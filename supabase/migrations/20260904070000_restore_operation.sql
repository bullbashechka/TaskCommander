begin;

alter table public.operation_draft
  add column restore_source_operation_id uuid references public.bulk_operation(id) on delete restrict,
  add column restore_source_state_version bigint,
  add column restore_intents jsonb,
  add constraint operation_draft_restore_triplet check (
    (restore_source_operation_id is null and restore_source_state_version is null and restore_intents is null)
    or (restore_source_operation_id is not null and restore_source_state_version > 0
      and jsonb_typeof(restore_intents) = 'array'
      and jsonb_array_length(restore_intents) between 1 and 1000
      and retry_source_operation_id is null)
  );

create table public.private_restore_draft (
  draft_id uuid primary key references public.operation_draft(id) on delete cascade,
  portal_id text not null,
  owner_id text not null,
  source_operation_id uuid not null,
  source_state_version bigint not null,
  intent_ciphertext bytea not null,
  intent_nonce bytea not null,
  preview_ciphertext bytea,
  preview_nonce bytea,
  preview_revision integer,
  preview_fingerprint text,
  key_version text not null default 'v1',
  constraint private_restore_nonce_length check (octet_length(intent_nonce) = 12
    and (preview_nonce is null or octet_length(preview_nonce) = 12)),
  constraint private_restore_preview_pair check (
    (preview_ciphertext is null and preview_nonce is null and preview_revision is null
      and preview_fingerprint is null)
    or (preview_ciphertext is not null and preview_nonce is not null
      and preview_revision > 0 and preview_fingerprint ~ '^[0-9a-f]{64}$'))
);
alter table public.private_restore_draft enable row level security;
revoke all on table public.private_restore_draft from anon, authenticated;
revoke select, insert, update, delete on table public.private_restore_draft from service_role;

create or replace function public.clear_retry_draft_on_normal_edit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.revision <> old.revision and new.status = 'preparing'
    and new.preflight_snapshot is null then
    new.retry_source_operation_id := null;
    new.retry_source_state_version := null;
    new.retry_intents := null;
    new.restore_source_operation_id := null;
    new.restore_source_state_version := null;
    new.restore_intents := null;
  end if;
  return new;
end;
$$;

create function public.read_restore_source(
  p_portal_id text,p_actor_id text,p_source_id uuid,
  p_access_version bigint,p_is_bitrix_admin boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_source public.bulk_operation;
  v_settings public.user_settings;
  v_report public.report;
  v_tasks jsonb;
begin
  if p_portal_id is null or p_actor_id !~ '^[0-9]{1,32}$' or p_source_id is null
    or p_is_bitrix_admin is null or (p_is_bitrix_admin and p_access_version is not null)
    or (not p_is_bitrix_admin and p_access_version is null) then
    raise exception 'TC_RESTORE_SOURCE_INVALID' using errcode='22023';
  end if;
  select * into v_source from public.bulk_operation
    where portal_id=p_portal_id and id=p_source_id;
  if not found or v_source.status not in ('completed','completed_with_errors','cancelled','interrupted')
    or v_source.created_at <= now()-interval '1 year' then return null; end if;
  if not p_is_bitrix_admin then
    select * into v_settings from public.user_settings
      where portal_id=p_portal_id and user_id=p_actor_id;
    if not found or v_settings.access_state <> 'active'
      or v_settings.access_version <> p_access_version
      or not (array['app_access','run_bulk_operations','change_allowed_fields',
        'restore_operations']::text[] <@ v_settings.permissions)
      or (v_source.initiator_id=p_actor_id and not ('view_own_reports'=any(v_settings.permissions)))
      or (v_source.initiator_id<>p_actor_id and not ('view_all_reports'=any(v_settings.permissions)))
      then return null; end if;
  end if;
  select * into v_report from public.report where operation_id=p_source_id;
  if found and (v_report.storage_status <> 'active' or v_report.archived_at is not null
    or v_report.active_until <= now()) then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'taskId',result.task_id,'title',result.task_title,'taskUrl',result.task_url,
    'appliedFieldIds',coalesce(refinement.applied_field_ids,result.applied_field_ids),
    'ciphertext',encode(protected.ciphertext,'base64'),
    'nonce',encode(protected.nonce,'base64'),'keyVersion',protected.key_version,
    'payloadVersion',protected.payload_version,'beforeVersion',protected.before_version,
    'afterVersion',protected.after_version) order by result.task_id),'[]'::jsonb)
    into v_tasks
  from public.task_processing_result as result
  left join public.task_result_refinement as refinement
    on refinement.source_task_processing_result_id=result.id
  join public.protected_task_result as protected
    on protected.task_processing_result_id=result.id
  where result.operation_id=p_source_id
    and coalesce(refinement.outcome,result.outcome) in ('success','partially_applied','restored')
    and cardinality(coalesce(refinement.applied_field_ids,result.applied_field_ids)) > 0
    and protected.after_version ~ '^mock:[1-9][0-9]*$';
  return jsonb_build_object('operationId',v_source.id,'ownerId',v_source.initiator_id,
    'stateVersion',v_source.state_version,'tasks',v_tasks);
end;
$$;

revoke all on function public.read_restore_source(text,text,uuid,bigint,boolean)
  from public,anon,authenticated;
grant execute on function public.read_restore_source(text,text,uuid,bigint,boolean) to service_role;

create function public.save_restore_operation_draft(
  p_portal_id text,p_owner_id text,p_draft_id uuid,p_source_id uuid,
  p_source_state_version bigint,p_access_version bigint,p_is_bitrix_admin boolean,
  p_selected_task_ids text[],p_changes jsonb,p_intents jsonb,
  p_ciphertext text,p_nonce text
) returns public.operation_draft language plpgsql security definer set search_path='' as $$
declare
  v_source public.bulk_operation;
  v_settings public.user_settings;
  v_report public.report;
  v_existing public.operation_draft;
  v_saved public.operation_draft;
begin
  if p_portal_id is null or p_owner_id !~ '^[0-9]{1,32}$' or p_draft_id is null
    or p_source_id is null or p_source_state_version < 1 or p_is_bitrix_admin is null
    or (p_is_bitrix_admin and p_access_version is not null)
    or (not p_is_bitrix_admin and p_access_version is null)
    or cardinality(p_selected_task_ids) not between 1 and 1000
    or cardinality(p_selected_task_ids) <>
      cardinality(array(select distinct unnest(p_selected_task_ids)))
    or jsonb_typeof(p_intents) <> 'array'
    or jsonb_array_length(p_intents) <> cardinality(p_selected_task_ids)
    or jsonb_typeof(p_changes) <> 'array'
    or jsonb_array_length(p_changes) not between 1 and 64
    or exists(select 1 from jsonb_array_elements(p_changes) as change
      where jsonb_typeof(change) <> 'object'
        or change->>'action' <> 'clear'
        or change->>'fieldId' is null or change->>'kind' is null
        or change - 'fieldId' - 'kind' - 'action' <> '{}'::jsonb)
    or p_ciphertext is null or p_nonce is null
    or octet_length(decode(p_nonce,'base64')) <> 12
    or octet_length(decode(p_ciphertext,'base64')) not between 1 and 16777216 then
    raise exception 'TC_RESTORE_DRAFT_INVALID' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_portal_id||chr(31)||p_owner_id,0));
  select * into v_source from public.bulk_operation
    where portal_id=p_portal_id and id=p_source_id for share;
  if not found or v_source.state_version <> p_source_state_version
    or v_source.status not in ('completed','completed_with_errors','cancelled','interrupted')
    or v_source.created_at <= now()-interval '1 year' then
    raise exception 'TC_RESTORE_SOURCE_CHANGED' using errcode='40001';
  end if;
  select * into v_report from public.report where operation_id=p_source_id for share;
  if found and (v_report.storage_status <> 'active' or v_report.archived_at is not null
    or v_report.active_until <= now()) then
    raise exception 'TC_RESTORE_SOURCE_CHANGED' using errcode='40001';
  end if;
  if not p_is_bitrix_admin then
    select * into v_settings from public.user_settings
      where portal_id=p_portal_id and user_id=p_owner_id for share;
    if not found or v_settings.access_state <> 'active'
      or v_settings.access_version <> p_access_version
      or not (array['app_access','run_bulk_operations','change_allowed_fields',
        'restore_operations']::text[] <@ v_settings.permissions)
      or (v_source.initiator_id=p_owner_id
        and not ('view_own_reports'=any(v_settings.permissions)))
      or (v_source.initiator_id<>p_owner_id
        and not ('view_all_reports'=any(v_settings.permissions))) then
      raise exception 'TC_RESTORE_ACCESS_CHANGED' using errcode='40001';
    end if;
  end if;
  if exists(select 1 from jsonb_array_elements(p_intents) with ordinality as intent(value,n)
    where intent.value->>'taskId' is distinct from p_selected_task_ids[intent.n]
      or intent.value - 'taskId' - 'fieldIds' - 'afterVersion' <> '{}'::jsonb
      or intent.value->>'afterVersion' !~ '^mock:[1-9][0-9]*$'
      or jsonb_typeof(intent.value->'fieldIds') <> 'array'
      or jsonb_array_length(intent.value->'fieldIds') not between 1 and 64
      or exists(select 1 from jsonb_array_elements_text(intent.value->'fieldIds') as field_id(value)
        where not p_is_bitrix_admin and not (field_id.value=any(v_settings.allowed_field_ids)))
      or not exists(select 1 from public.task_processing_result as result
        left join public.task_result_refinement as refinement
          on refinement.source_task_processing_result_id=result.id
        join public.protected_task_result as protected
          on protected.task_processing_result_id=result.id
        where result.operation_id=p_source_id and result.task_id=intent.value->>'taskId'
          and coalesce(refinement.outcome,result.outcome) in
            ('success','partially_applied','restored')
          and protected.after_version=intent.value->>'afterVersion'
          and (select array_agg(field_id.value order by field_id.value)
            from jsonb_array_elements_text(intent.value->'fieldIds') as field_id(value))
            = (select array_agg(field_id order by field_id)
              from unnest(coalesce(refinement.applied_field_ids,result.applied_field_ids)) as field_id))) then
    raise exception 'TC_RESTORE_DRAFT_INVALID' using errcode='22023';
  end if;
  if (select array_agg(distinct change->>'fieldId' order by change->>'fieldId')
      from jsonb_array_elements(p_changes) as change) is distinct from
    (select array_agg(distinct field_id.value order by field_id.value)
      from jsonb_array_elements(p_intents) as intent,
        jsonb_array_elements_text(intent->'fieldIds') as field_id(value)) then
    raise exception 'TC_RESTORE_DRAFT_INVALID' using errcode='22023';
  end if;
  select * into v_existing from public.operation_draft
    where portal_id=p_portal_id and owner_id=p_owner_id for update;
  if found then
    if v_existing.expires_at>now() then
      raise exception 'TC_RESTORE_DRAFT_EXISTS' using errcode='40001';
    end if;
    delete from public.task_preflight_confirmation where portal_id=p_portal_id
      and owner_id=p_owner_id and draft_id=v_existing.id;
    delete from public.operation_draft where id=v_existing.id;
  end if;
  insert into public.operation_draft(id,portal_id,owner_id,status,filter_snapshot,
    sort_snapshot,selected_task_ids,changes,preflight_snapshot,
    restore_source_operation_id,restore_source_state_version,restore_intents)
  values(p_draft_id,p_portal_id,p_owner_id,'preparing','{"filters":[]}'::jsonb,
    '{"fieldId":"deadline","direction":"asc"}'::jsonb,p_selected_task_ids,
    p_changes,null,p_source_id,p_source_state_version,p_intents)
  returning * into v_saved;
  insert into public.private_restore_draft(draft_id,portal_id,owner_id,source_operation_id,
    source_state_version,intent_ciphertext,intent_nonce,key_version)
  values(p_draft_id,p_portal_id,p_owner_id,p_source_id,p_source_state_version,
    decode(p_ciphertext,'base64'),decode(p_nonce,'base64'),'v1');
  return v_saved;
end;
$$;

revoke all on function public.save_restore_operation_draft(
  text,text,uuid,uuid,bigint,bigint,boolean,text[],jsonb,jsonb,text,text)
  from public,anon,authenticated;
grant execute on function public.save_restore_operation_draft(
  text,text,uuid,uuid,bigint,bigint,boolean,text[],jsonb,jsonb,text,text) to service_role;

create function public.read_private_restore_draft(
  p_portal_id text,p_owner_id text,p_draft_id uuid,
  p_access_version bigint,p_is_bitrix_admin boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_draft public.operation_draft;
  v_private public.private_restore_draft;
  v_source public.bulk_operation;
  v_settings public.user_settings;
  v_report public.report;
begin
  select * into v_draft from public.operation_draft
    where portal_id=p_portal_id and owner_id=p_owner_id and id=p_draft_id;
  if not found or v_draft.expires_at<=now() or v_draft.restore_source_operation_id is null
    then return null; end if;
  select * into v_source from public.bulk_operation
    where portal_id=p_portal_id and id=v_draft.restore_source_operation_id;
  if not found or v_source.state_version<>v_draft.restore_source_state_version
    or v_source.status not in ('completed','completed_with_errors','cancelled','interrupted')
    or v_source.created_at<=now()-interval '1 year' then return null; end if;
  select * into v_report from public.report where operation_id=v_source.id;
  if found and (v_report.storage_status<>'active' or v_report.archived_at is not null
    or v_report.active_until<=now()) then return null; end if;
  if not p_is_bitrix_admin then
    select * into v_settings from public.user_settings
      where portal_id=p_portal_id and user_id=p_owner_id;
    if not found or v_settings.access_state<>'active'
      or v_settings.access_version<>p_access_version
      or not (array['app_access','run_bulk_operations','change_allowed_fields',
        'restore_operations']::text[] <@ v_settings.permissions)
      or (v_source.initiator_id=p_owner_id
        and not ('view_own_reports'=any(v_settings.permissions)))
      or (v_source.initiator_id<>p_owner_id
        and not ('view_all_reports'=any(v_settings.permissions)))
      or exists(select 1 from jsonb_array_elements(v_draft.restore_intents) as intent,
        jsonb_array_elements_text(intent->'fieldIds') as field_id(value)
        where not (field_id.value=any(v_settings.allowed_field_ids))) then return null; end if;
  end if;
  select * into v_private from public.private_restore_draft
    where draft_id=p_draft_id and portal_id=p_portal_id and owner_id=p_owner_id;
  if not found or v_private.source_operation_id<>v_draft.restore_source_operation_id
    or v_private.source_state_version<>v_draft.restore_source_state_version then return null; end if;
  return jsonb_build_object('intentCiphertext',encode(v_private.intent_ciphertext,'base64'),
    'intentNonce',encode(v_private.intent_nonce,'base64'),
    'previewCiphertext',case when v_private.preview_ciphertext is null then null
      else encode(v_private.preview_ciphertext,'base64') end,
    'previewNonce',case when v_private.preview_nonce is null then null
      else encode(v_private.preview_nonce,'base64') end,
    'previewRevision',v_private.preview_revision,
    'previewFingerprint',v_private.preview_fingerprint,
    'keyVersion',v_private.key_version);
end;
$$;

create function public.save_restore_preflight(
  p_portal_id text,p_owner_id text,p_draft_id uuid,p_expected_revision integer,
  p_access_version bigint,p_is_bitrix_admin boolean,p_safe_snapshot jsonb,
  p_ciphertext text,p_nonce text,p_fingerprint text
) returns public.operation_draft language plpgsql security definer set search_path='' as $$
declare
  v_draft public.operation_draft;
  v_private public.private_restore_draft;
  v_source public.bulk_operation;
begin
  if p_ciphertext is null or p_nonce is null or p_fingerprint !~ '^[0-9a-f]{64}$'
    or octet_length(decode(p_nonce,'base64'))<>12
    or octet_length(decode(p_ciphertext,'base64')) not between 1 and 16777216 then
    raise exception 'TC_RESTORE_PREFLIGHT_INVALID' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_portal_id||chr(31)||p_owner_id,0));
  select * into v_draft from public.operation_draft
    where portal_id=p_portal_id and owner_id=p_owner_id and id=p_draft_id for update;
  select * into v_private from public.private_restore_draft
    where draft_id=p_draft_id for update;
  select * into v_source from public.bulk_operation
    where portal_id=p_portal_id and id=v_draft.restore_source_operation_id for share;
  if v_draft.id is null or v_private.draft_id is null or v_source.id is null
    or v_source.state_version<>v_draft.restore_source_state_version then
    raise exception 'TC_RESTORE_SOURCE_CHANGED' using errcode='40001';
  end if;
  if public.read_private_restore_draft(p_portal_id,p_owner_id,p_draft_id,
    p_access_version,p_is_bitrix_admin) is null then
    raise exception 'TC_RESTORE_ACCESS_CHANGED' using errcode='40001';
  end if;
  if v_draft.revision=p_expected_revision+1 then
    if v_draft.status<>'awaiting_confirmation'
      or v_draft.preflight_snapshot is distinct from p_safe_snapshot
      or v_private.preview_revision<>v_draft.revision
      or v_private.preview_fingerprint is null then
      raise exception 'TC_RESTORE_PREFLIGHT_CONFLICT' using errcode='40001';
    end if;
    return v_draft;
  end if;
  v_draft:=public.save_task_preflight(p_portal_id,p_owner_id,p_draft_id,
    p_expected_revision,p_access_version,p_is_bitrix_admin,p_safe_snapshot);
  update public.private_restore_draft set preview_ciphertext=decode(p_ciphertext,'base64'),
    preview_nonce=decode(p_nonce,'base64'),preview_revision=v_draft.revision,
    preview_fingerprint=p_fingerprint where draft_id=p_draft_id;
  return v_draft;
end;
$$;

revoke all on function public.read_private_restore_draft(text,text,uuid,bigint,boolean)
  from public,anon,authenticated;
grant execute on function public.read_private_restore_draft(text,text,uuid,bigint,boolean)
  to service_role;
revoke all on function public.save_restore_preflight(
  text,text,uuid,integer,bigint,boolean,jsonb,text,text,text)
  from public,anon,authenticated;
grant execute on function public.save_restore_preflight(
  text,text,uuid,integer,bigint,boolean,jsonb,text,text,text) to service_role;

create function public.launch_confirmed_restore_preflight(
  p_portal_id text,p_owner_id text,p_display_name text,p_draft_id uuid,
  p_draft_revision integer,p_checked_at timestamptz,p_token uuid,
  p_access_version bigint,p_is_bitrix_admin boolean,p_safe_snapshot jsonb,
  p_snapshot_fingerprint text,p_full_fingerprint text,p_ciphertext text,p_nonce text,
  p_key_version text,p_correlation_id text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_draft public.operation_draft;
  v_private public.private_restore_draft;
  v_source public.bulk_operation;
  v_report public.report;
  v_confirmation public.task_preflight_confirmation;
  v_settings public.user_settings;
  v_existing public.bulk_operation;
  v_operation public.bulk_operation;
  v_key text;
  v_initial_count integer;
  v_executable integer;
  v_conflicts integer;
  v_excluded integer;
  v_unchanged integer;
  v_safe_changes jsonb;
begin
  if p_portal_id is null or p_owner_id !~ '^[0-9]{1,32}$' or p_draft_id is null
    or p_draft_revision < 1 or p_checked_at is null or p_is_bitrix_admin is null
    or p_snapshot_fingerprint !~ '^[0-9a-f]{64}$'
    or p_full_fingerprint !~ '^[0-9a-f]{64}$'
    or p_correlation_id is null or p_safe_snapshot is null
    or (p_is_bitrix_admin and p_access_version is not null)
    or (not p_is_bitrix_admin and p_access_version is null)
    or (p_token is not null and (p_ciphertext is null or p_nonce is null
      or p_key_version is null)) then
    raise exception 'TC_RESTORE_LAUNCH_INVALID' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_portal_id||chr(31)||p_owner_id,0));
  v_key:=case when p_token is null then
    'zero:'||p_draft_id::text||':'||p_draft_revision::text
    else 'confirmation:'||p_token::text end;
  select * into v_existing from public.bulk_operation where portal_id=p_portal_id
    and initiator_id=p_owner_id and idempotency_key=v_key;
  if found then
    if v_existing.operation_type<>'restore'
      or v_existing.preflight_snapshot->>'draftId'<>p_draft_id::text
      or v_existing.preflight_snapshot->>'draftRevision'<>p_draft_revision::text
      or (v_existing.preflight_snapshot->>'checkedAt')::timestamptz is distinct from p_checked_at
      or v_existing.preflight_snapshot->>'snapshotFingerprint'<>p_snapshot_fingerprint then
      raise exception 'TC_RESTORE_LAUNCH_CONFLICT' using errcode='40001';
    end if;
    return jsonb_build_object('disposition','existing','operation',to_jsonb(v_existing));
  end if;
  select * into v_draft from public.operation_draft where portal_id=p_portal_id
    and owner_id=p_owner_id and id=p_draft_id for update;
  select * into v_private from public.private_restore_draft
    where draft_id=p_draft_id for update;
  if v_draft.id is null or v_private.draft_id is null
    or v_draft.status<>'awaiting_confirmation' or v_draft.revision<>p_draft_revision
    or v_draft.expires_at<=now() or v_draft.preflight_snapshot is distinct from p_safe_snapshot
    or v_private.preview_revision<>p_draft_revision
    or v_private.preview_fingerprint<>p_full_fingerprint
    or p_safe_snapshot->>'draftId'<>p_draft_id::text
    or p_safe_snapshot->>'draftRevision'<>p_draft_revision::text
    or (p_safe_snapshot->>'checkedAt')::timestamptz is distinct from p_checked_at
    or (p_is_bitrix_admin and p_safe_snapshot->'actorAccessVersion'
      is distinct from 'null'::jsonb)
    or (not p_is_bitrix_admin and p_safe_snapshot->>'actorAccessVersion'
      <> p_access_version::text)
    or p_checked_at<=now()-interval '15 minutes'
    or p_checked_at>now()+interval '1 minute' then
    raise exception 'TC_RESTORE_LAUNCH_CONFLICT' using errcode='40001';
  end if;
  if public.read_private_restore_draft(p_portal_id,p_owner_id,p_draft_id,
    p_access_version,p_is_bitrix_admin) is null then
    raise exception 'TC_RESTORE_SOURCE_CHANGED' using errcode='40001';
  end if;
  select * into v_source from public.bulk_operation
    where portal_id=p_portal_id and id=v_draft.restore_source_operation_id for share;
  select * into v_report from public.report where operation_id=v_source.id for share;
  if v_source.id is null or v_source.state_version<>v_draft.restore_source_state_version
    or v_source.created_at<=now()-interval '1 year'
    or (v_report.id is not null and (v_report.storage_status<>'active'
      or v_report.archived_at is not null or v_report.active_until<=now())) then
    raise exception 'TC_RESTORE_SOURCE_CHANGED' using errcode='40001';
  end if;
  if not p_is_bitrix_admin then
    select * into v_settings from public.user_settings
      where portal_id=p_portal_id and user_id=p_owner_id for share;
    if not found or v_settings.access_state<>'active'
      or v_settings.access_version<>p_access_version
      or not (array['app_access','run_bulk_operations','change_allowed_fields',
        'restore_operations']::text[] <@ v_settings.permissions)
      or (v_source.initiator_id=p_owner_id
        and not ('view_own_reports'=any(v_settings.permissions)))
      or (v_source.initiator_id<>p_owner_id
        and not ('view_all_reports'=any(v_settings.permissions)))
      or exists(select 1 from jsonb_array_elements(v_draft.restore_intents) as intent,
        jsonb_array_elements_text(intent->'fieldIds') as field_id(value)
        where not (field_id.value=any(v_settings.allowed_field_ids))) then
      raise exception 'TC_RESTORE_ACCESS_CHANGED' using errcode='40001';
    end if;
  end if;
  v_executable:=(p_safe_snapshot->'summary'->>'eligible')::integer;
  v_conflicts:=(p_safe_snapshot->'summary'->>'conflicted')::integer;
  v_excluded:=(p_safe_snapshot->'summary'->>'excluded')::integer;
  v_unchanged:=(p_safe_snapshot->'summary'->>'unchanged')::integer;
  v_initial_count:=jsonb_array_length(p_safe_snapshot->'entries');
  if v_initial_count<>cardinality(v_draft.selected_task_ids)
    or v_initial_count<>v_executable+v_conflicts+v_excluded+v_unchanged
    or (p_safe_snapshot->>'canProceed'='true') is distinct from (v_executable>0)
    or (v_executable>0) is distinct from (p_token is not null)
    or (p_token is not null and (octet_length(decode(p_nonce,'base64'))<>12
      or octet_length(decode(p_ciphertext,'base64')) not between 1 and 16777216))
    or exists(select 1 from jsonb_array_elements(p_safe_snapshot->'entries')
      with ordinality as entry(value,n)
      where entry.value->>'taskId' is distinct from v_draft.selected_task_ids[entry.n]
        or entry.value->'currentValues' is distinct from 'null'::jsonb
        or entry.value->'targetValues' is distinct from 'null'::jsonb) then
    raise exception 'TC_RESTORE_LAUNCH_INVALID' using errcode='22023';
  end if;
  if p_token is not null then
    select * into v_confirmation from public.task_preflight_confirmation
      where portal_id=p_portal_id and owner_id=p_owner_id for update;
    if not found or v_confirmation.token<>p_token or v_confirmation.consumed_at is not null
      or v_confirmation.expires_at<=now() or v_confirmation.draft_id<>p_draft_id
      or v_confirmation.draft_revision<>p_draft_revision
      or v_confirmation.snapshot_fingerprint<>p_snapshot_fingerprint then
      raise exception 'TC_RESTORE_LAUNCH_CONFLICT' using errcode='40001';
    end if;
  end if;
  if exists(select 1 from public.bulk_operation where portal_id=p_portal_id
    and initiator_id=p_owner_id and status in ('launching','running')) then
    raise exception 'TC_ACTIVE_OPERATION' using errcode='40001';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('fieldId',field_id.value)
    order by field_id.value),'[]'::jsonb) into v_safe_changes
  from (select distinct field_id.value from jsonb_array_elements(v_draft.restore_intents) as intent,
    jsonb_array_elements_text(intent->'fieldIds') as field_id(value)) as field_id;
  insert into public.bulk_operation(portal_id,operation_type,status,initiator_id,
    initiator_display_name,source_operation_id,idempotency_key,request_fingerprint,
    filter_snapshot,selected_task_ids,changes,preflight_snapshot,selected_count,
    eligible_count,excluded_count,unchanged_count,conflicted_count,completed_at)
  values(p_portal_id,'restore',case when v_executable>0 then 'launching'
    when v_conflicts>0 then 'completed_with_errors' else 'completed' end,
    p_owner_id,p_display_name,v_source.id,v_key,p_snapshot_fingerprint,null,
    v_draft.selected_task_ids,v_safe_changes,
    jsonb_build_object('draftId',p_draft_id,'draftRevision',p_draft_revision,
      'checkedAt',p_checked_at,'snapshotFingerprint',p_snapshot_fingerprint,
      'summary',p_safe_snapshot->'summary','fieldIds',
      (select coalesce(jsonb_agg(change->>'fieldId'),'[]'::jsonb)
        from jsonb_array_elements(v_safe_changes) as change),
      'restoreSourceStateVersion',v_draft.restore_source_state_version),
    v_initial_count,v_executable+v_conflicts,v_excluded,v_unchanged,v_conflicts,
    case when v_executable=0 then now() else null end)
  returning * into v_operation;
  insert into public.task_processing_result(operation_id,task_id,task_title,task_url,
    outcome,requested_field_ids,applied_field_ids,failed_field_ids,reason_code,
    reason_message,can_retry,result_fingerprint)
  select v_operation.id,entry->>'taskId',entry->>'title',entry->>'taskUrl',
    entry->>'disposition',
    coalesce(array(select jsonb_array_elements_text(selected.intent->'fieldIds')),'{}'::text[]),
    '{}'::text[],'{}'::text[],entry->>'reasonCode',entry->>'reasonMessage',false,
    public.task_processing_result_fingerprint(entry->>'disposition',entry->>'title',
      entry->>'taskUrl',
      coalesce(array(select jsonb_array_elements_text(selected.intent->'fieldIds')),'{}'::text[]),
      '{}'::text[],'{}'::text[],entry->>'reasonCode',entry->>'reasonMessage',false,null,null)
  from jsonb_array_elements(p_safe_snapshot->'entries') as entry
  join lateral (select value as intent from jsonb_array_elements(v_draft.restore_intents) as value
    where value->>'taskId'=entry->>'taskId' limit 1) as selected on true
  where entry->>'disposition' in ('conflict','excluded_by_preflight','no_change');
  perform public.append_audit_event(p_portal_id,now(),'operation_create','user',
    p_owner_id,p_display_name,null,'operation',v_operation.id::text,
    'Восстановление предыдущих значений','[]'::jsonb,'success',p_correlation_id,
    v_operation.id::text,'create',jsonb_build_object('kind','operation','reasonCode',null,'summary',null));
  if p_token is not null then
    insert into public.private_operation_execution_plan(operation_id,ciphertext,nonce,key_version)
    values(v_operation.id,decode(p_ciphertext,'base64'),decode(p_nonce,'base64'),p_key_version);
    insert into public.operation_launch_dispatch(operation_id,launch_attempt,portal_id)
    values(v_operation.id,v_operation.launch_attempt,p_portal_id);
  end if;
  delete from public.task_preflight_confirmation where portal_id=p_portal_id
    and owner_id=p_owner_id and draft_id=p_draft_id;
  delete from public.operation_draft where id=p_draft_id;
  return jsonb_build_object('disposition','created','operation',to_jsonb(v_operation));
end;
$$;

revoke all on function public.launch_confirmed_restore_preflight(
  text,text,text,uuid,integer,timestamptz,uuid,bigint,boolean,jsonb,text,text,
  text,text,text,text) from public,anon,authenticated;
grant execute on function public.launch_confirmed_restore_preflight(
  text,text,text,uuid,integer,timestamptz,uuid,bigint,boolean,jsonb,text,text,
  text,text,text,text) to service_role;

-- A restored write carries the same protected before-values as an ordinary success.
create or replace function public.record_claimed_task_result(p_portal_id text, p_operation_id uuid,
  p_launch_attempt integer, p_task_id text, p_claim_id uuid,
  p_task_title text, p_task_url text, p_outcome text, p_requested_field_ids text[],
  p_applied_field_ids text[], p_failed_field_ids text[], p_reason_code text,
  p_reason_message text, p_correlation_id text, p_can_retry boolean,
  p_after_version text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.bulk_operation;
  v_claim public.operation_task_claim;
  v_result jsonb;
  v_existing public.task_processing_result;
  v_protected public.protected_task_result;
  v_fingerprint text;
begin
  select * into v_operation from public.bulk_operation
    where portal_id = p_portal_id and id = p_operation_id for update;
  if not found or v_operation.launch_attempt <> p_launch_attempt then
    return jsonb_build_object('inserted',false,'rejected',true,'reasonCode','OPERATION_LAUNCH_ATTEMPT_STALE');
  end if;
  select * into v_claim from public.operation_task_claim
    where operation_id = p_operation_id and task_id = p_task_id for update;
  if not found or v_claim.claim_id <> p_claim_id or v_claim.launch_attempt <> p_launch_attempt then
    return jsonb_build_object('inserted',false,'rejected',true,'reasonCode','TASK_CLAIM_STALE');
  end if;
  if v_claim.phase = 'done' then
    select * into v_existing from public.task_processing_result
      where operation_id = p_operation_id and task_id = p_task_id;
    v_fingerprint := public.task_processing_result_fingerprint(
      p_outcome,p_task_title,p_task_url,p_requested_field_ids,p_applied_field_ids,
      p_failed_field_ids,p_reason_code,p_reason_message,p_can_retry,
      case when p_outcome in ('success','partially_applied','restored') then v_claim.before_version else null end,
      case when p_outcome in ('success','partially_applied','restored') then p_after_version else null end);
    if found and v_existing.result_fingerprint = v_fingerprint then
      select * into v_protected from public.protected_task_result
        where task_processing_result_id = v_existing.id;
      if (p_outcome in ('success','partially_applied','restored') and found
        and v_protected.after_version = p_after_version
        and v_protected.before_version = v_claim.before_version)
        or (p_outcome not in ('success','partially_applied','restored') and not found) then
        return jsonb_build_object('inserted',false,'result',to_jsonb(v_existing),
          'summary',jsonb_build_object('successful',v_operation.successful_count,
            'failed',v_operation.failed_count,'unconfirmed',v_operation.unconfirmed_count,
            'conflicted',v_operation.conflicted_count,
            'partiallyApplied',v_operation.partially_applied_count,
            'notProcessed',v_operation.not_processed_count));
      end if;
    end if;
    perform public.append_operation_state_error(p_portal_id,p_operation_id,p_correlation_id,
      'TASK_RESULT_CONFLICT');
    return jsonb_build_object('inserted',false,'rejected',true,'reasonCode','TASK_RESULT_CONFLICT');
  end if;
  if v_claim.lease_until <= now()
    or (p_outcome in ('success','partially_applied','restored') and (
      v_claim.phase <> 'applied' or v_claim.after_mutation_version is null
      or p_after_version is distinct from 'mock:' || v_claim.after_mutation_version::text)) then
    return jsonb_build_object('inserted',false,'rejected',true,'reasonCode','TASK_CLAIM_STALE');
  end if;
  v_result := public.record_task_processing_result_with_attempt(
    p_portal_id,p_operation_id,p_launch_attempt,p_task_id,p_task_title,p_task_url,
    p_outcome,p_requested_field_ids,p_applied_field_ids,p_failed_field_ids,
    p_reason_code,p_reason_message,p_correlation_id,p_can_retry,
    case when p_outcome in ('success','partially_applied','restored') then v_claim.protected_ciphertext else null end,
    case when p_outcome in ('success','partially_applied','restored') then v_claim.protected_nonce else null end,
    case when p_outcome in ('success','partially_applied','restored') then v_claim.protected_key_version else null end,
    case when p_outcome in ('success','partially_applied','restored') then v_claim.protected_payload_version else null end,
    case when p_outcome in ('success','partially_applied','restored') then v_claim.before_version else null end,
    case when p_outcome in ('success','partially_applied','restored') then p_after_version else null end
  );
  if coalesce((v_result->>'rejected')::boolean,false) then return v_result; end if;
  update public.operation_task_claim set phase = 'done', updated_at = now(),
    protected_ciphertext = case when p_outcome = 'unconfirmed' then protected_ciphertext else null end,
    protected_nonce = case when p_outcome = 'unconfirmed' then protected_nonce else null end,
    protected_key_version = case when p_outcome = 'unconfirmed' then protected_key_version else null end,
    protected_payload_version = case when p_outcome = 'unconfirmed' then protected_payload_version else null end
    where operation_id = p_operation_id and task_id = p_task_id;
  return v_result;
end;
$$;


-- Late confirmation retains protected values and the restore outcome.
create or replace function public.refine_claimed_task_result(p_portal_id text, p_operation_id uuid,
  p_task_id text, p_claim_id uuid, p_after_version text, p_correlation_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.bulk_operation;
  v_claim public.operation_task_claim;
  v_source public.task_processing_result;
  v_response jsonb;
begin
  select * into v_operation from public.bulk_operation
    where portal_id = p_portal_id and id = p_operation_id for update;
  if not found or v_operation.status not in ('completed','completed_with_errors','cancelled','interrupted') then
    return jsonb_build_object('rejected',true,'reasonCode','OPERATION_UNAVAILABLE');
  end if;
  select * into v_claim from public.operation_task_claim
    where operation_id = p_operation_id and task_id = p_task_id for update;
  select * into v_source from public.task_processing_result
    where operation_id = p_operation_id and task_id = p_task_id for update;
  if v_claim.claim_id is distinct from p_claim_id or v_claim.phase <> 'done'
    or v_claim.after_mutation_version is null or v_source.outcome <> 'unconfirmed'
    or p_after_version <> 'mock:' || v_claim.after_mutation_version::text
    or v_claim.protected_ciphertext is null then
    return jsonb_build_object('rejected',true,'reasonCode','TASK_RESULT_REFINEMENT_REJECTED');
  end if;
  v_response := public.record_task_result_refinement_with_versions(
    p_portal_id,p_operation_id,p_task_id,case when v_operation.operation_type='restore' then 'restored' else 'success' end,v_claim.applied_field_ids,'{}'::text[],
    null,null,p_correlation_id,false,v_claim.before_version,p_after_version
  );
  if coalesce((v_response->>'rejected')::boolean,false) then return v_response; end if;
  insert into public.protected_task_result(task_processing_result_id,ciphertext,nonce,
    key_version,payload_version,before_version,after_version)
    values(v_source.id,v_claim.protected_ciphertext,v_claim.protected_nonce,
      v_claim.protected_key_version,v_claim.protected_payload_version,
      v_claim.before_version,p_after_version)
    on conflict (task_processing_result_id) do nothing;
  return v_response;
end;
$$;


commit;
