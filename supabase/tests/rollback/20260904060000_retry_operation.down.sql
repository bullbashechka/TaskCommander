delete from public.task_preflight_confirmation where draft_id in
  (select id from public.operation_draft where retry_source_operation_id is not null);
delete from public.operation_draft where retry_source_operation_id is not null;
drop function if exists public.save_retry_operation_draft(text,text,uuid,bigint,bigint,boolean,text[],jsonb,jsonb);
drop function if exists public.discard_retry_operation_draft(text,text,uuid,integer,bigint,boolean);
drop function if exists public.read_retry_source(text,text,uuid,bigint,boolean);
drop trigger if exists operation_draft_clear_retry_on_edit on public.operation_draft;
drop function if exists public.clear_retry_draft_on_normal_edit();
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

  select coalesce(jsonb_agg(jsonb_build_object('fieldId', change->>'fieldId')), '[]'::jsonb)
    into v_safe_changes from jsonb_array_elements(v_draft.changes) as change;
  select coalesce(jsonb_agg(jsonb_build_object(
    'taskId', entry->>'taskId', 'title', entry->>'title', 'taskUrl', entry->>'taskUrl',
    'outcome', entry->>'disposition', 'requestedFieldIds',
      (select coalesce(jsonb_agg(change->>'fieldId'), '[]'::jsonb)
       from jsonb_array_elements(v_draft.changes) as change),
    'reasonCode', entry->>'reasonCode', 'reasonMessage', entry->>'reasonMessage'
  )), '[]'::jsonb) into v_initial
  from jsonb_array_elements(p_preflight_snapshot->'entries') as entry
  where entry->>'disposition' in ('excluded_by_preflight', 'no_change');

  v_response := public.create_bulk_operation_idempotent(
    p_portal_id, 'bulk_change', p_owner_id, p_display_name, null, v_key, null,
    v_draft.selected_task_ids, v_safe_changes,
    jsonb_build_object('draftId', p_draft_id, 'draftRevision', p_draft_revision,
      'checkedAt', p_preflight_snapshot->>'checkedAt',
      'snapshotFingerprint', p_snapshot_fingerprint,
      'summary', p_preflight_snapshot->'summary', 'fieldIds',
      (select coalesce(jsonb_agg(change->>'fieldId'), '[]'::jsonb)
       from jsonb_array_elements(v_draft.changes) as change)),
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


alter table public.operation_draft drop constraint if exists operation_draft_retry_triplet,
  drop column if exists retry_source_operation_id,
  drop column if exists retry_source_state_version,
  drop column if exists retry_intents;
