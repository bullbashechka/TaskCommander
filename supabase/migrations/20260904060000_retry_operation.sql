begin;

alter table public.operation_draft
  add column retry_source_operation_id uuid references public.bulk_operation(id) on delete restrict,
  add column retry_source_state_version bigint,
  add column retry_intents jsonb,
  add constraint operation_draft_retry_triplet check (
    (retry_source_operation_id is null and retry_source_state_version is null and retry_intents is null)
    or (retry_source_operation_id is not null and retry_source_state_version > 0
      and jsonb_typeof(retry_intents) = 'array'
      and jsonb_array_length(retry_intents) between 1 and 1000
      and octet_length(retry_intents::text) <= 8388608)
  );

create function public.clear_retry_draft_on_normal_edit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.revision <> old.revision and new.status = 'preparing'
    and new.preflight_snapshot is null then
    new.retry_source_operation_id := null;
    new.retry_source_state_version := null;
    new.retry_intents := null;
  end if;
  return new;
end;
$$;
create trigger operation_draft_clear_retry_on_edit before update on public.operation_draft
  for each row execute function public.clear_retry_draft_on_normal_edit();

-- This RPC is callable only with the server service role. Browser access is denied by grants.
create function public.read_retry_source(
  p_portal_id text, p_actor_id text, p_source_id uuid,
  p_access_version bigint, p_is_bitrix_admin boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_source public.bulk_operation;
  v_plan public.private_operation_execution_plan;
  v_settings public.user_settings;
  v_report public.report;
begin
  if p_portal_id is null or p_actor_id !~ '^[0-9]{1,32}$' or p_source_id is null
    or p_is_bitrix_admin is null
    or (p_is_bitrix_admin and p_access_version is not null)
    or (not p_is_bitrix_admin and p_access_version is null) then
    raise exception 'TC_RETRY_SOURCE_INVALID' using errcode = '22023';
  end if;
  select * into v_source from public.bulk_operation
    where portal_id = p_portal_id and id = p_source_id;
  if not found or v_source.status not in
      ('completed','completed_with_errors','cancelled','interrupted')
    or v_source.operation_type not in ('bulk_change','retry')
    or v_source.created_at <= now() - interval '1 year' then return null; end if;
  if not p_is_bitrix_admin then
    select * into v_settings from public.user_settings
      where portal_id = p_portal_id and user_id = p_actor_id;
    if not found or v_settings.access_state <> 'active'
      or v_settings.access_version <> p_access_version
      or not (array['app_access','run_bulk_operations','change_allowed_fields',
        'retry_operations']::text[] <@ v_settings.permissions)
      or (v_source.initiator_id = p_actor_id
        and not ('view_own_reports' = any(v_settings.permissions)))
      or (v_source.initiator_id <> p_actor_id
        and not ('view_all_reports' = any(v_settings.permissions))) then return null; end if;
  end if;
  select * into v_report from public.report where operation_id = p_source_id;
  if found and (v_report.storage_status <> 'active'
    or v_report.archived_at is not null or v_report.active_until <= now()) then
    return null;
  end if;
  select * into v_plan from public.private_operation_execution_plan
    where operation_id = p_source_id;
  if not found then return null; end if;
  return jsonb_build_object('operation',to_jsonb(v_source), 'plan',jsonb_build_object(
    'ciphertext',encode(v_plan.ciphertext,'base64'),
    'nonce',encode(v_plan.nonce,'base64'), 'keyVersion',v_plan.key_version,
    'payloadVersion',v_plan.payload_version));
end;
$$;

create function public.save_retry_operation_draft(
  p_portal_id text, p_owner_id text, p_source_id uuid, p_source_state_version bigint,
  p_access_version bigint, p_is_bitrix_admin boolean,
  p_selected_task_ids text[], p_changes jsonb, p_intents jsonb
) returns public.operation_draft language plpgsql security definer set search_path = '' as $$
declare
  v_source public.bulk_operation;
  v_settings public.user_settings;
  v_existing public.operation_draft;
  v_saved public.operation_draft;
  v_report public.report;
  v_old_source public.bulk_operation;
  v_old_report public.report;
begin
  if p_portal_id is null or p_owner_id !~ '^[0-9]{1,32}$' or p_source_id is null
    or p_source_state_version is null or p_source_state_version < 1
    or p_is_bitrix_admin is null or (p_is_bitrix_admin and p_access_version is not null)
    or (not p_is_bitrix_admin and p_access_version is null)
    or cardinality(p_selected_task_ids) not between 1 and 1000
    or cardinality(p_selected_task_ids) <>
      cardinality(array(select distinct unnest(p_selected_task_ids)))
    or p_intents is null or jsonb_typeof(p_intents) <> 'array'
    or jsonb_array_length(p_intents) <> cardinality(p_selected_task_ids)
    or octet_length(p_intents::text) > 8388608
    or p_changes is null or jsonb_typeof(p_changes) <> 'array'
    or exists(select 1 from unnest(p_selected_task_ids) as task_id
      where task_id !~ '^[0-9]{1,32}$') then
    raise exception 'TC_RETRY_DRAFT_INVALID' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_portal_id || chr(31) || p_owner_id, 0));
  select * into v_source from public.bulk_operation
    where portal_id = p_portal_id and id = p_source_id for share;
  if not found or v_source.state_version <> p_source_state_version
    or v_source.status not in ('completed','completed_with_errors','cancelled','interrupted')
    or v_source.operation_type not in ('bulk_change','retry')
    or v_source.created_at <= now() - interval '1 year'
    or exists(select 1 from public.report where operation_id = p_source_id
      and (storage_status <> 'active' or archived_at is not null
        or active_until <= now())) then
    raise exception 'TC_RETRY_SOURCE_CHANGED' using errcode = '40001';
  end if;
  if not p_is_bitrix_admin then
    select * into v_settings from public.user_settings
      where portal_id = p_portal_id and user_id = p_owner_id for share;
    if not found or v_settings.access_state <> 'active'
      or v_settings.access_version <> p_access_version
      or not (array['app_access','run_bulk_operations','change_allowed_fields',
        'retry_operations']::text[] <@ v_settings.permissions)
      or (v_source.initiator_id = p_owner_id
        and not ('view_own_reports' = any(v_settings.permissions)))
      or (v_source.initiator_id <> p_owner_id
        and not ('view_all_reports' = any(v_settings.permissions))) then
      raise exception 'TC_RETRY_ACCESS_CHANGED' using errcode = '40001';
    end if;
  end if;
  select * into v_report from public.report where operation_id = p_source_id;
  if found and (v_report.storage_status <> 'active'
    or v_report.archived_at is not null or v_report.active_until <= now()) then
    raise exception 'TC_RETRY_SOURCE_CHANGED' using errcode = '40001';
  end if;
  if exists(select 1 from jsonb_array_elements(p_intents) with ordinality as item(intent,n)
    where item.intent->>'taskId' is distinct from p_selected_task_ids[item.n]
      or jsonb_typeof(item.intent->'targetValues') <> 'object'
      or (select count(*) from jsonb_object_keys(case
        when jsonb_typeof(item.intent->'targetValues') = 'object'
          then item.intent->'targetValues' else '{}'::jsonb end)) not between 1 and 64
      or not exists(select 1 from public.task_processing_result as result
        left join public.task_result_refinement as refinement
          on refinement.source_task_processing_result_id = result.id
        where result.operation_id = p_source_id and result.task_id = p_selected_task_ids[item.n]
          and coalesce(refinement.outcome,result.outcome) in
            ('error','unconfirmed','conflict','not_processed','partially_applied'))
    ) then
    raise exception 'TC_RETRY_DRAFT_INVALID' using errcode = '22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_changes) as change
    where not exists(select 1 from jsonb_array_elements(p_intents) as intent,
      jsonb_object_keys(intent->'targetValues') as field_id(value)
      where field_id.value = change->>'fieldId'))
    or exists(select 1 from jsonb_array_elements(p_intents) as intent,
      jsonb_object_keys(intent->'targetValues') as field_id(value)
      where not exists(select 1 from jsonb_array_elements(p_changes) as change
        where change->>'fieldId' = field_id.value)) then
    raise exception 'TC_RETRY_DRAFT_INVALID' using errcode = '22023';
  end if;
  if not p_is_bitrix_admin and exists(
    select 1 from jsonb_array_elements(p_intents) as intent,
      jsonb_object_keys(intent->'targetValues') as field_id(value)
      where not (field_id.value = any(v_settings.allowed_field_ids))) then
    raise exception 'TC_RETRY_ACCESS_CHANGED' using errcode = '40001';
  end if;
  select * into v_existing from public.operation_draft
    where portal_id = p_portal_id and owner_id = p_owner_id for update;
  if found then
    if v_existing.expires_at > now() then
      if v_existing.retry_source_operation_id is null then
        raise exception 'TC_RETRY_DRAFT_EXISTS' using errcode = '40001';
      end if;
      select * into v_old_source from public.bulk_operation
        where portal_id = p_portal_id and id = v_existing.retry_source_operation_id for share;
      if found then
        select * into v_old_report from public.report
          where operation_id = v_old_source.id for share;
      end if;
      if v_old_source.id is not null
        and v_old_source.state_version = v_existing.retry_source_state_version
        and v_old_source.status in ('completed','completed_with_errors','cancelled','interrupted')
        and v_old_source.created_at > now() - interval '1 year'
        and (v_old_report.id is null or (v_old_report.storage_status = 'active'
          and v_old_report.archived_at is null and v_old_report.active_until > now()))
        and (p_is_bitrix_admin or (
          (v_old_source.initiator_id = p_owner_id
            and 'view_own_reports' = any(v_settings.permissions))
          or (v_old_source.initiator_id <> p_owner_id
            and 'view_all_reports' = any(v_settings.permissions)))
          and not exists(select 1 from jsonb_array_elements(v_existing.retry_intents) as intent,
            jsonb_object_keys(intent->'targetValues') as field_id(value)
            where not (field_id.value = any(v_settings.allowed_field_ids)))) then
        raise exception 'TC_RETRY_DRAFT_EXISTS' using errcode = '40001';
      end if;
    end if;
    delete from public.task_preflight_confirmation where portal_id = p_portal_id
      and owner_id = p_owner_id and draft_id = v_existing.id;
    delete from public.operation_draft where id = v_existing.id;
  end if;
  insert into public.operation_draft(portal_id,owner_id,status,filter_snapshot,
    sort_snapshot,selected_task_ids,changes,preflight_snapshot,
    retry_source_operation_id,retry_source_state_version,retry_intents)
  values(p_portal_id,p_owner_id,'preparing','{"filters":[]}'::jsonb,
    '{"fieldId":"deadline","direction":"asc"}'::jsonb,
    p_selected_task_ids,p_changes,null,p_source_id,p_source_state_version,p_intents)
  returning * into v_saved;
  return v_saved;
end;
$$;

create function public.discard_retry_operation_draft(
  p_portal_id text, p_owner_id text, p_draft_id uuid, p_expected_revision integer,
  p_access_version bigint, p_is_bitrix_admin boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_settings public.user_settings;
  v_draft public.operation_draft;
begin
  if p_portal_id is null or p_owner_id !~ '^[0-9]{1,32}$'
    or p_draft_id is null or p_expected_revision is null or p_expected_revision < 1
    or p_is_bitrix_admin is null or (p_is_bitrix_admin and p_access_version is not null)
    or (not p_is_bitrix_admin and p_access_version is null) then
    raise exception 'TC_RETRY_DRAFT_INVALID' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_portal_id || chr(31) || p_owner_id, 0));
  if not p_is_bitrix_admin then
    select * into v_settings from public.user_settings
      where portal_id = p_portal_id and user_id = p_owner_id for share;
    if not found or v_settings.access_state <> 'active'
      or v_settings.access_version <> p_access_version
      or not (array['app_access','run_bulk_operations','change_allowed_fields']::text[]
        <@ v_settings.permissions) then
      raise exception 'TC_RETRY_ACCESS_CHANGED' using errcode = '40001';
    end if;
  end if;
  select * into v_draft from public.operation_draft
    where portal_id = p_portal_id and owner_id = p_owner_id for update;
  if not found or v_draft.id <> p_draft_id or v_draft.revision <> p_expected_revision
    or v_draft.retry_source_operation_id is null then
    return false;
  end if;
  delete from public.task_preflight_confirmation
    where portal_id = p_portal_id and owner_id = p_owner_id and draft_id = v_draft.id;
  delete from public.operation_draft where id = v_draft.id;
  return true;
end;
$$;

revoke all on function public.discard_retry_operation_draft(
  text,text,uuid,integer,bigint,boolean) from public, anon, authenticated;
grant execute on function public.discard_retry_operation_draft(
  text,text,uuid,integer,bigint,boolean) to service_role;

revoke all on function public.clear_retry_draft_on_normal_edit() from public, anon, authenticated;
revoke all on function public.read_retry_source(text,text,uuid,bigint,boolean)
  from public, anon, authenticated;
revoke all on function public.save_retry_operation_draft(
  text,text,uuid,bigint,bigint,boolean,text[],jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.read_retry_source(text,text,uuid,bigint,boolean) to service_role;
grant execute on function public.save_retry_operation_draft(
  text,text,uuid,bigint,bigint,boolean,text[],jsonb,jsonb) to service_role;

create or replace function public.launch_confirmed_task_preflight(
  p_portal_id text, p_owner_id text, p_display_name text,
  p_draft_id uuid, p_draft_revision integer, p_checked_at timestamptz,
  p_token uuid, p_expected_access_version bigint, p_is_bitrix_admin boolean,
  p_preflight_snapshot jsonb, p_snapshot_fingerprint text,
  p_ciphertext text, p_nonce text, p_key_version text, p_correlation_id text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.operation_draft;
  v_confirmation public.task_preflight_confirmation;
  v_settings public.user_settings;
  v_existing public.bulk_operation;
  v_response jsonb;
  v_operation public.bulk_operation;
  v_key text;
  v_initial jsonb;
  v_safe_changes jsonb;
  v_source public.bulk_operation;
  v_source_settings public.user_settings;
  v_report public.report;
begin
  if p_portal_id is null or btrim(p_portal_id) = '' or p_owner_id is null
    or p_owner_id !~ '^[0-9]{1,32}$' or p_display_name is null
    or p_draft_id is null or p_draft_revision is null or p_draft_revision < 1
    or p_checked_at is null or p_preflight_snapshot is null
    or p_snapshot_fingerprint is null or p_snapshot_fingerprint !~ '^[0-9a-f]{64}$'
    or p_correlation_id is null or p_is_bitrix_admin is null
    or (p_is_bitrix_admin and p_expected_access_version is not null)
    or (not p_is_bitrix_admin and p_expected_access_version is null)
    or (p_token is not null and (p_ciphertext is null or p_nonce is null or p_key_version is null))
    or (p_token is null and (p_ciphertext is not null or p_nonce is not null or p_key_version is not null)) then
    raise exception 'TC_OPERATION_LAUNCH_INVALID' using errcode = '22023';
  end if;

  -- Serialize exact concurrent requests before replay lookup. An edited draft may delete its
  -- confirmation row, while the namespaced operation key remains durable.
  perform pg_advisory_xact_lock(hashtextextended(p_portal_id || chr(31) || p_owner_id, 0));
  v_key := case when p_token is null then
    'zero:' || p_draft_id::text || ':' || p_draft_revision::text
    else 'confirmation:' || p_token::text end;
  select * into v_existing from public.bulk_operation where portal_id = p_portal_id
    and initiator_id = p_owner_id and idempotency_key = v_key;
  if found then
    if v_existing.preflight_snapshot->>'draftId' <> p_draft_id::text
      or v_existing.preflight_snapshot->>'draftRevision' <> p_draft_revision::text
      or (v_existing.preflight_snapshot->>'checkedAt')::timestamptz is distinct from p_checked_at
      or v_existing.preflight_snapshot->>'snapshotFingerprint' <> p_snapshot_fingerprint then
      raise exception 'TC_OPERATION_LAUNCH_CONFLICT' using errcode = '40001';
    end if;
    return jsonb_build_object('disposition', 'existing', 'operation', to_jsonb(v_existing));
  end if;

  if not p_is_bitrix_admin then
    select * into v_settings from public.user_settings where portal_id = p_portal_id
      and user_id = p_owner_id for share;
    if not found or v_settings.access_state <> 'active'
      or v_settings.access_version <> p_expected_access_version
      or not (array['app_access','run_bulk_operations','change_allowed_fields']::text[]
        <@ v_settings.permissions) then
      raise exception 'TC_OPERATION_LAUNCH_ACCESS_CHANGED' using errcode = '40001';
    end if;
  end if;
  select * into v_draft from public.operation_draft where portal_id = p_portal_id
    and owner_id = p_owner_id and id = p_draft_id for update;
  if not found or v_draft.status <> 'awaiting_confirmation'
    or v_draft.revision <> p_draft_revision or v_draft.expires_at <= now()
    or v_draft.preflight_snapshot is distinct from p_preflight_snapshot
    or p_preflight_snapshot->>'draftId' <> p_draft_id::text
    or p_preflight_snapshot->>'draftRevision' <> p_draft_revision::text
    or (p_preflight_snapshot->>'checkedAt')::timestamptz is distinct from p_checked_at
    or p_checked_at <= now() - interval '15 minutes'
    or p_checked_at > now() + interval '1 minute'
    or (p_is_bitrix_admin and p_preflight_snapshot->'actorAccessVersion' is distinct from 'null'::jsonb)
    or (not p_is_bitrix_admin and p_preflight_snapshot->>'actorAccessVersion' <> p_expected_access_version::text) then
    raise exception 'TC_OPERATION_LAUNCH_CONFLICT' using errcode = '40001';
  end if;
  if p_token is null then
    if p_preflight_snapshot->>'canProceed' <> 'false'
      or (p_preflight_snapshot->'summary'->>'eligible')::integer <> 0 then
      raise exception 'TC_OPERATION_LAUNCH_CONFLICT' using errcode = '40001';
    end if;
  else
    select * into v_confirmation from public.task_preflight_confirmation
      where portal_id = p_portal_id and owner_id = p_owner_id for update;
    if not found or v_confirmation.token <> p_token or v_confirmation.consumed_at is not null
      or v_confirmation.expires_at <= now() or v_confirmation.draft_id <> p_draft_id
      or v_confirmation.draft_revision <> p_draft_revision
      or v_confirmation.snapshot_fingerprint <> p_snapshot_fingerprint
      or p_preflight_snapshot->>'canProceed' <> 'true'
      or (p_preflight_snapshot->'summary'->>'eligible')::integer <= 0 then
      raise exception 'TC_OPERATION_LAUNCH_CONFLICT' using errcode = '40001';
    end if;
  end if;

  if v_draft.retry_source_operation_id is not null then
    select * into v_source from public.bulk_operation
      where portal_id = p_portal_id and id = v_draft.retry_source_operation_id for share;
    if not found or v_source.state_version <> v_draft.retry_source_state_version
      or v_source.status not in ('completed','completed_with_errors','cancelled','interrupted')
      or v_source.operation_type not in ('bulk_change','retry')
      or v_source.created_at <= now() - interval '1 year'
      or jsonb_typeof(v_draft.retry_intents) <> 'array'
      or jsonb_array_length(v_draft.retry_intents) <> cardinality(v_draft.selected_task_ids)
      or exists(select 1 from jsonb_array_elements(v_draft.retry_intents)
        with ordinality as intent(value,n)
        where intent.value->>'taskId' is distinct from v_draft.selected_task_ids[intent.n]) then
      raise exception 'TC_RETRY_SOURCE_CHANGED' using errcode = '40001';
    end if;
    select * into v_report from public.report where operation_id = v_source.id for share;
    if found and (v_report.storage_status <> 'active'
      or v_report.archived_at is not null or v_report.active_until <= now()) then
      raise exception 'TC_RETRY_SOURCE_CHANGED' using errcode = '40001';
    end if;
    if not p_is_bitrix_admin then
      select * into v_source_settings from public.user_settings
        where portal_id = p_portal_id and user_id = p_owner_id for share;
      if not found or v_source_settings.access_version <> p_expected_access_version
        or not ('retry_operations' = any(v_source_settings.permissions))
        or (v_source.initiator_id = p_owner_id
          and not ('view_own_reports' = any(v_source_settings.permissions)))
        or (v_source.initiator_id <> p_owner_id
          and not ('view_all_reports' = any(v_source_settings.permissions))) then
        raise exception 'TC_RETRY_ACCESS_CHANGED' using errcode = '40001';
      end if;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('fieldId', fields.value)
      order by fields.value), '[]'::jsonb) into v_safe_changes
    from (select distinct field_id.value from jsonb_array_elements(v_draft.retry_intents) as intent,
      jsonb_object_keys(intent->'targetValues') as field_id(value)) as fields;
  else
    select coalesce(jsonb_agg(jsonb_build_object('fieldId', change->>'fieldId')), '[]'::jsonb)
      into v_safe_changes from jsonb_array_elements(v_draft.changes) as change;
  end if;
  if v_draft.retry_source_operation_id is not null and not p_is_bitrix_admin
    and exists(select 1 from jsonb_array_elements(v_safe_changes) as change
      where not coalesce(change->>'fieldId' = any(v_settings.allowed_field_ids), false)) then
    raise exception 'TC_RETRY_ACCESS_CHANGED' using errcode = '40001';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'taskId', entry->>'taskId', 'title', entry->>'title', 'taskUrl', entry->>'taskUrl',
    'outcome', entry->>'disposition', 'requestedFieldIds',
      case when v_draft.retry_intents is null then
        (select coalesce(jsonb_agg(change->>'fieldId'), '[]'::jsonb)
         from jsonb_array_elements(v_draft.changes) as change)
      else
        (select coalesce(jsonb_agg(field_id.value), '[]'::jsonb)
         from jsonb_array_elements(v_draft.retry_intents) as intent,
           jsonb_object_keys(intent->'targetValues') as field_id(value)
         where intent->>'taskId' = entry->>'taskId') end,
    'reasonCode', entry->>'reasonCode', 'reasonMessage', entry->>'reasonMessage'
  )), '[]'::jsonb) into v_initial
  from jsonb_array_elements(p_preflight_snapshot->'entries') as entry
  where entry->>'disposition' in ('excluded_by_preflight', 'no_change');

  v_response := public.create_bulk_operation_idempotent(
    p_portal_id, case when v_draft.retry_source_operation_id is null then 'bulk_change' else 'retry' end,
    p_owner_id, p_display_name, v_draft.retry_source_operation_id, v_key, null,
    v_draft.selected_task_ids, v_safe_changes,
    jsonb_build_object('draftId', p_draft_id, 'draftRevision', p_draft_revision,
      'checkedAt', p_preflight_snapshot->>'checkedAt',
      'snapshotFingerprint', p_snapshot_fingerprint,
      'summary', p_preflight_snapshot->'summary', 'fieldIds',
      (select coalesce(jsonb_agg(change->>'fieldId'), '[]'::jsonb)
       from jsonb_array_elements(v_safe_changes) as change),
      'retrySourceStateVersion', v_draft.retry_source_state_version),
    (p_preflight_snapshot->'summary'->>'selected')::integer,
    (p_preflight_snapshot->'summary'->>'eligible')::integer,
    (p_preflight_snapshot->'summary'->>'excluded')::integer,
    (p_preflight_snapshot->'summary'->>'unchanged')::integer,
    p_correlation_id, v_initial
  );
  if v_response->>'disposition' <> 'created' then
    raise exception 'TC_OPERATION_LAUNCH_CONFLICT' using errcode = '40001';
  end if;
  v_operation := jsonb_populate_record(null::public.bulk_operation, v_response->'operation');
  if p_token is not null then
    insert into public.private_operation_execution_plan
      (operation_id, ciphertext, nonce, key_version)
    values (v_operation.id, decode(p_ciphertext, 'base64'), decode(p_nonce, 'base64'), p_key_version);
    insert into public.operation_launch_dispatch(operation_id, launch_attempt, portal_id)
    values (v_operation.id, v_operation.launch_attempt, p_portal_id);
    update public.task_preflight_confirmation set consumed_at = now()
      where portal_id = p_portal_id and owner_id = p_owner_id and token = p_token;
  end if;
  -- The encrypted plan is now authoritative. Remove all plaintext commands and values in the
  -- same transaction; the operation key and compact metadata preserve exact HTTP replay.
  delete from public.task_preflight_confirmation
    where portal_id = p_portal_id and owner_id = p_owner_id;
  delete from public.operation_draft
    where portal_id = p_portal_id and owner_id = p_owner_id and id = p_draft_id;
  return v_response;
end;
$$;


commit;
