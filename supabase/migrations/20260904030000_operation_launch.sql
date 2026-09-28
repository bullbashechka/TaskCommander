begin;

-- The public operation contains only field identifiers and counters. The full preflight and
-- commands are held in a separately encrypted, service-role-only execution plan.
create table public.private_operation_execution_plan (
  operation_id uuid primary key references public.bulk_operation(id) on delete restrict,
  ciphertext bytea not null,
  nonce bytea not null,
  key_version text not null,
  payload_version integer not null default 1,
  created_at timestamptz not null default now(),
  constraint operation_plan_nonce_length check (octet_length(nonce) = 12),
  constraint operation_plan_ciphertext_length check (octet_length(ciphertext) between 17 and 16777216),
  constraint operation_plan_key_version check (key_version ~ '^[a-zA-Z0-9_-]{1,32}$')
);
alter table public.private_operation_execution_plan enable row level security;
revoke all on public.private_operation_execution_plan from public, anon, authenticated;
grant select, insert on public.private_operation_execution_plan to service_role;

create table public.operation_launch_dispatch (
  operation_id uuid not null references public.bulk_operation(id) on delete restrict,
  launch_attempt integer not null,
  portal_id text not null,
  message_id uuid not null default gen_random_uuid(),
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  claimed_at timestamptz,
  claim_id uuid,
  primary key (operation_id, launch_attempt),
  unique (message_id),
  constraint operation_launch_dispatch_attempt check (launch_attempt > 0),
  constraint operation_launch_dispatch_status check (status in ('pending', 'sending', 'dispatched', 'failed'))
);
create index operation_launch_dispatch_pending on public.operation_launch_dispatch(status, created_at);
alter table public.operation_launch_dispatch enable row level security;
revoke all on public.operation_launch_dispatch from public, anon, authenticated;
grant select on public.operation_launch_dispatch to service_role;

create function public.launch_confirmed_task_preflight(
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

revoke all on function public.launch_confirmed_task_preflight(
  text,text,text,uuid,integer,timestamptz,uuid,bigint,boolean,jsonb,text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.launch_confirmed_task_preflight(
  text,text,text,uuid,integer,timestamptz,uuid,bigint,boolean,jsonb,text,text,text,text,text
) to service_role;

create function public.read_confirmed_operation_receipt(
  p_portal_id text, p_owner_id text, p_operation_id uuid
)
returns jsonb language sql security definer set search_path = '' as $$
  select to_jsonb(operation) from public.bulk_operation as operation
  where operation.portal_id = p_portal_id and operation.initiator_id = p_owner_id
    and operation.id = p_operation_id
    and (operation.idempotency_key like 'confirmation:%'
      or operation.idempotency_key like 'zero:%');
$$;
revoke all on function public.read_confirmed_operation_receipt(text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.read_confirmed_operation_receipt(text,text,uuid) to service_role;

create function public.claim_operation_launch_dispatch(p_portal_id text, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.bulk_operation;
  v_dispatch public.operation_launch_dispatch;
begin
  select * into v_operation from public.bulk_operation
  where portal_id = p_portal_id and id = p_operation_id for update;
  if not found or v_operation.status <> 'launching' then return null; end if;
  select * into v_dispatch from public.operation_launch_dispatch
  where portal_id = p_portal_id and operation_id = p_operation_id
    and launch_attempt = v_operation.launch_attempt for update;
  if not found or (v_dispatch.status = 'sending' and
      v_dispatch.claimed_at > now() - interval '2 minutes')
    or (v_dispatch.status = 'dispatched' and
      v_dispatch.dispatched_at > now() - interval '15 minutes')
    or v_dispatch.status = 'failed' then return null; end if;
  update public.operation_launch_dispatch set status = 'sending', claimed_at = now(),
    claim_id = gen_random_uuid()
  where operation_id = p_operation_id and launch_attempt = v_operation.launch_attempt
  returning * into v_dispatch;
  return to_jsonb(v_dispatch);
end;
$$;
revoke all on function public.claim_operation_launch_dispatch(text,uuid) from public, anon, authenticated;
grant execute on function public.claim_operation_launch_dispatch(text,uuid) to service_role;

create function public.list_recoverable_operation_dispatches(p_limit integer)
returns setof public.operation_launch_dispatch language sql security definer set search_path = '' as $$
  select dispatch.* from public.operation_launch_dispatch as dispatch
  join public.bulk_operation as operation on operation.id = dispatch.operation_id
  where operation.status = 'launching' and operation.launch_attempt = dispatch.launch_attempt
    and (dispatch.status = 'pending' or
      (dispatch.status = 'sending' and dispatch.claimed_at < now() - interval '2 minutes') or
      (dispatch.status = 'dispatched' and dispatch.dispatched_at < now() - interval '15 minutes'))
  order by dispatch.created_at limit least(greatest(p_limit, 1), 100);
$$;
revoke all on function public.list_recoverable_operation_dispatches(integer)
  from public, anon, authenticated;
grant execute on function public.list_recoverable_operation_dispatches(integer) to service_role;

create function public.complete_operation_launch_dispatch(
  p_portal_id text, p_operation_id uuid, p_launch_attempt integer, p_message_id uuid,
  p_claim_id uuid,
  p_sent boolean, p_correlation_id text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.bulk_operation;
  v_dispatch public.operation_launch_dispatch;
  v_result jsonb;
begin
  select * into v_operation from public.bulk_operation
  where portal_id = p_portal_id and id = p_operation_id for update;
  if not found or v_operation.launch_attempt <> p_launch_attempt then
    return jsonb_build_object('disposition','stale');
  end if;
  select * into v_dispatch from public.operation_launch_dispatch
  where operation_id = p_operation_id and launch_attempt = p_launch_attempt
    and portal_id = p_portal_id and message_id = p_message_id
    and claim_id = p_claim_id for update;
  if not found or v_dispatch.status <> 'sending' then
    return jsonb_build_object('disposition','stale');
  end if;
  if p_sent then
    update public.operation_launch_dispatch set status = 'dispatched', dispatched_at = now()
    where operation_id = p_operation_id and launch_attempt = p_launch_attempt;
    return jsonb_build_object('disposition','dispatched');
  end if;
  if v_operation.status <> 'launching' then
    return jsonb_build_object('disposition','stale');
  end if;
  v_result := public.fail_bulk_operation_launch_with_attempt(
    p_portal_id, p_operation_id, p_launch_attempt, p_correlation_id
  );
  if v_result->>'disposition' in ('applied','already_applied') then
    update public.operation_launch_dispatch set status = 'failed'
    where operation_id = p_operation_id and launch_attempt = p_launch_attempt;
  end if;
  return v_result;
end;
$$;
revoke all on function public.complete_operation_launch_dispatch(text,uuid,integer,uuid,uuid,boolean,text)
  from public, anon, authenticated;
grant execute on function public.complete_operation_launch_dispatch(text,uuid,integer,uuid,uuid,boolean,text)
  to service_role;

create function public.retry_confirmed_operation_launch(
  p_portal_id text, p_owner_id text, p_operation_id uuid, p_correlation_id text,
  p_expected_access_version bigint, p_is_bitrix_admin boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.bulk_operation;
  v_result jsonb;
  v_settings public.user_settings;
begin
  if p_is_bitrix_admin is null
    or (p_is_bitrix_admin and p_expected_access_version is not null)
    or (not p_is_bitrix_admin and p_expected_access_version is null) then
    raise exception 'TC_OPERATION_LAUNCH_INVALID' using errcode = '22023';
  end if;
  if not p_is_bitrix_admin then
    select * into v_settings from public.user_settings
      where portal_id = p_portal_id and user_id = p_owner_id for share;
    if not found or v_settings.access_state <> 'active'
      or v_settings.access_version <> p_expected_access_version
      or not (array['app_access','run_bulk_operations','change_allowed_fields',
        'retry_operations']::text[] <@ v_settings.permissions) then
      raise exception 'TC_OPERATION_LAUNCH_ACCESS_CHANGED' using errcode = '40001';
    end if;
  end if;
  select * into v_operation from public.bulk_operation
  where portal_id = p_portal_id and initiator_id = p_owner_id and id = p_operation_id;
  if not found or v_operation.idempotency_key not like 'confirmation:%' then
    raise exception 'TC_OPERATION_LAUNCH_CONFLICT' using errcode = '40001';
  end if;
  v_result := public.retry_bulk_operation_launch(p_portal_id, p_operation_id, p_correlation_id);
  if v_result->>'disposition' = 'applied' then
    v_operation := jsonb_populate_record(null::public.bulk_operation, v_result->'operation');
    insert into public.operation_launch_dispatch(operation_id,launch_attempt,portal_id)
    values (v_operation.id,v_operation.launch_attempt,p_portal_id);
  end if;
  return v_result;
end;
$$;
revoke all on function public.retry_confirmed_operation_launch(text,text,uuid,text,bigint,boolean)
  from public, anon, authenticated;
grant execute on function public.retry_confirmed_operation_launch(text,text,uuid,text,bigint,boolean)
  to service_role;

commit;
