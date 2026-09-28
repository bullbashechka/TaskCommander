begin;

-- A delivery owns one fenced server-side lease. Browser polling never renews it.
create table public.operation_execution_lease (
  operation_id uuid primary key references public.bulk_operation(id) on delete cascade,
  launch_attempt integer not null check (launch_attempt > 0),
  lease_id uuid not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.operation_execution_lease enable row level security;

revoke all on public.operation_execution_lease from public, anon, authenticated;
grant select, insert, update, delete on public.operation_execution_lease to service_role;

create function public.acquire_operation_execution_lease(
  p_portal_id text, p_operation_id uuid, p_launch_attempt integer, p_lease_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.bulk_operation;
begin
  select * into v_operation from public.bulk_operation
    where portal_id = p_portal_id and id = p_operation_id for update;
  if not found or v_operation.status <> 'running'
    or v_operation.launch_attempt <> p_launch_attempt
    or v_operation.cancel_requested_at is not null
    or v_operation.interruption_requested_at is not null then return false; end if;
  insert into public.operation_execution_lease(operation_id, launch_attempt, lease_id, expires_at)
    values (p_operation_id, p_launch_attempt, p_lease_id, now() + interval '3 minutes')
    on conflict (operation_id) do nothing;
  return found;
end;
$$;

create function public.renew_operation_execution_lease(
  p_portal_id text, p_operation_id uuid, p_launch_attempt integer, p_lease_id uuid,
  p_task_id text, p_claim_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.bulk_operation;
begin
  select * into v_operation from public.bulk_operation
    where portal_id = p_portal_id and id = p_operation_id for update;
  if not found or v_operation.status <> 'running'
    or v_operation.launch_attempt <> p_launch_attempt then return false; end if;
  if (p_task_id is null) <> (p_claim_id is null) then return false; end if;
  perform 1 from public.operation_execution_lease
    where operation_id = p_operation_id and launch_attempt = p_launch_attempt
      and lease_id = p_lease_id and expires_at > now() for update;
  if not found then return false; end if;
  if p_task_id is not null then
    perform 1 from public.operation_task_claim
      where operation_id = p_operation_id and task_id = p_task_id
        and launch_attempt = p_launch_attempt and claim_id = p_claim_id
        and phase in ('prepared','writing','applied') for update;
    if not found then return false; end if;
  end if;
  update public.operation_execution_lease set expires_at = now() + interval '3 minutes',
    updated_at = now() where operation_id = p_operation_id
      and launch_attempt = p_launch_attempt and lease_id = p_lease_id;
  if p_task_id is not null and p_claim_id is not null then
    update public.operation_task_claim set lease_until = now() + interval '3 minutes',
      updated_at = now() where operation_id = p_operation_id and task_id = p_task_id
        and launch_attempt = p_launch_attempt and claim_id = p_claim_id
        and phase in ('prepared','writing','applied');
  end if;
  update public.bulk_operation set last_progress_at = now() where id = p_operation_id;
  return true;
end;
$$;

create function public.release_operation_execution_lease(
  p_portal_id text, p_operation_id uuid, p_launch_attempt integer, p_lease_id uuid
) returns void language sql security definer set search_path = '' as $$
  delete from public.operation_execution_lease as lease
    using public.bulk_operation as operation
    where operation.id = p_operation_id and operation.portal_id = p_portal_id
      and lease.operation_id = operation.id and lease.launch_attempt = p_launch_attempt
      and lease.lease_id = p_lease_id;
$$;

-- An expired writing intent may have reached Bitrix. It is unconfirmed, never not_processed.
create function public.expire_operation_execution_leases(p_limit integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.bulk_operation;
  v_lease public.operation_execution_lease;
  v_claim public.operation_task_claim;
  v_count integer := 0;
  v_correlation text;
  v_result jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'TC_OPERATION_LEASE_LIMIT_INVALID' using errcode = '22023';
  end if;
  delete from public.operation_execution_lease as lease using public.bulk_operation as operation
    where lease.operation_id = operation.id
      and operation.status in ('completed','completed_with_errors','cancelled','interrupted','launch_failed');
  for v_operation in
    select operation.* from public.bulk_operation as operation
      left join public.operation_execution_lease as lease on lease.operation_id = operation.id
      where operation.status = 'running' and (lease.expires_at <= now()
        or (lease.operation_id is null and
          (operation.cancel_requested_at is not null or operation.interruption_requested_at is not null)))
      order by coalesce(lease.expires_at, operation.last_progress_at)
      limit p_limit for update of operation skip locked
  loop
    select * into v_lease from public.operation_execution_lease
      where operation_id = v_operation.id for update;
    if found and (v_lease.expires_at > now()
      or v_lease.launch_attempt <> v_operation.launch_attempt) then continue; end if;
    v_correlation := 'TC-' || gen_random_uuid()::text;
    for v_claim in select * from public.operation_task_claim
      where operation_id = v_operation.id and phase in ('writing','applied') for update
    loop
      if not exists(select 1 from public.task_processing_result
        where operation_id = v_operation.id and task_id = v_claim.task_id) then
        v_result := public.record_task_processing_result_with_attempt(
          v_operation.portal_id, v_operation.id, v_operation.launch_attempt,
          v_claim.task_id, null, null, 'unconfirmed',
          coalesce(v_claim.required_field_ids, '{}'::text[]), '{}'::text[],
          coalesce(v_claim.required_field_ids, '{}'::text[]),
          'UPSTREAM_OUTCOME_UNKNOWN',
          'Обработчик остановился во время изменения; итог задачи не подтверждён.',
          v_correlation, false
        );
        if coalesce((v_result->>'rejected')::boolean,false) then
          raise exception 'TC_OPERATION_WATCHDOG_RESULT_REJECTED' using errcode = 'P0001';
        end if;
        update public.operation_task_claim set phase = 'done', updated_at = now()
          where operation_id = v_operation.id and task_id = v_claim.task_id
            and claim_id = v_claim.claim_id;
      end if;
    end loop;
    if v_operation.cancel_requested_at is null and v_operation.interruption_requested_at is null then
      v_result := public.request_bulk_operation_stop(v_operation.portal_id, v_operation.id,
        'interrupt', 'CONSUMER_LEASE_EXPIRED', 'Связь с обработчиком потеряна.', v_correlation);
      if v_result->>'disposition' = 'rejected' then
        raise exception 'TC_OPERATION_WATCHDOG_STOP_REJECTED' using errcode = 'P0001';
      end if;
    end if;
    v_result := public.finalize_bulk_operation(v_operation.portal_id, v_operation.id, v_correlation);
    if v_result->>'disposition' = 'rejected' then
      raise exception 'TC_OPERATION_WATCHDOG_FINALIZE_REJECTED' using errcode = 'P0001';
    end if;
    delete from public.operation_execution_lease where operation_id = v_operation.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create function public.request_owned_operation_cancellation(
  p_portal_id text, p_owner_id text, p_operation_id uuid, p_correlation_id text,
  p_expected_access_version bigint, p_is_bitrix_admin boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.bulk_operation;
  v_settings public.user_settings;
  v_result jsonb;
  v_final jsonb;
begin
  if p_is_bitrix_admin is null
    or (p_is_bitrix_admin and p_expected_access_version is not null)
    or (not p_is_bitrix_admin and p_expected_access_version is null) then
    raise exception 'TC_OPERATION_CANCEL_INVALID' using errcode = '22023';
  end if;
  if not p_is_bitrix_admin then
    select * into v_settings from public.user_settings
      where portal_id = p_portal_id and user_id = p_owner_id for share;
    if not found or v_settings.access_state <> 'active'
      or v_settings.access_version <> p_expected_access_version
      or not (array['app_access','run_bulk_operations']::text[] <@ v_settings.permissions) then
      raise exception 'TC_OPERATION_CANCEL_ACCESS_CHANGED' using errcode = '40001';
    end if;
  end if;
  select * into v_operation from public.bulk_operation
    where portal_id = p_portal_id and initiator_id = p_owner_id and id = p_operation_id for update;
  if not found then return jsonb_build_object('disposition','rejected','reasonCode','OPERATION_UNAVAILABLE'); end if;
  v_result := public.request_bulk_operation_stop(p_portal_id, p_operation_id,
    'cancel', null, null, p_correlation_id);
  if v_result->>'disposition' in ('applied','already_applied')
    and v_operation.status = 'running'
    and not exists(select 1 from public.operation_execution_lease
      where operation_id = p_operation_id)
    and not exists(select 1 from public.operation_task_claim as claim
      where claim.operation_id = p_operation_id and claim.phase in ('writing','applied')
        and not exists(select 1 from public.task_processing_result as result
          where result.operation_id = p_operation_id and result.task_id = claim.task_id)) then
    v_final := public.finalize_bulk_operation(p_portal_id, p_operation_id, p_correlation_id);
    if v_final->>'disposition' in ('applied','already_applied') then
      return v_final;
    end if;
  end if;
  return v_result;
end;
$$;

-- Running executions with a live or expired lease are never blindly redriven.
create or replace function public.claim_stalled_operation_executions(p_limit integer)
returns setof public.operation_launch_dispatch
language plpgsql security definer set search_path = '' as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'TC_OPERATION_REDRIVE_LIMIT_INVALID' using errcode = '22023';
  end if;
  return query
    update public.operation_launch_dispatch as dispatch
      set claimed_at = now(), claim_id = gen_random_uuid()
      from public.bulk_operation as operation
      where operation.id = dispatch.operation_id
        and operation.portal_id = dispatch.portal_id
        and operation.launch_attempt = dispatch.launch_attempt
        and operation.status = 'running'
        and operation.cancel_requested_at is null
        and operation.interruption_requested_at is null
        and operation.last_progress_at < now() - interval '2 minutes'
        and coalesce(dispatch.claimed_at, dispatch.created_at) < now() - interval '2 minutes'
        and not exists(select 1 from public.operation_execution_lease as lease
          where lease.operation_id = operation.id)
        and dispatch.operation_id in (
          select candidate.id from public.bulk_operation as candidate
          where candidate.status = 'running'
            and candidate.cancel_requested_at is null
            and candidate.interruption_requested_at is null
            and candidate.last_progress_at < now() - interval '2 minutes'
            and not exists(select 1 from public.operation_execution_lease as lease
              where lease.operation_id = candidate.id)
          order by candidate.last_progress_at, candidate.id limit p_limit
          for update skip locked
        )
      returning dispatch.*;
end;
$$;

revoke all on function public.acquire_operation_execution_lease(text,uuid,integer,uuid)
  from public, anon, authenticated;
revoke all on function public.renew_operation_execution_lease(text,uuid,integer,uuid,text,uuid)
  from public, anon, authenticated;
revoke all on function public.release_operation_execution_lease(text,uuid,integer,uuid)
  from public, anon, authenticated;
revoke all on function public.expire_operation_execution_leases(integer)
  from public, anon, authenticated;
revoke all on function public.request_owned_operation_cancellation(text,text,uuid,text,bigint,boolean)
  from public, anon, authenticated;
grant execute on function public.acquire_operation_execution_lease(text,uuid,integer,uuid) to service_role;
grant execute on function public.renew_operation_execution_lease(text,uuid,integer,uuid,text,uuid) to service_role;
grant execute on function public.release_operation_execution_lease(text,uuid,integer,uuid) to service_role;
grant execute on function public.expire_operation_execution_leases(integer) to service_role;
grant execute on function public.request_owned_operation_cancellation(text,text,uuid,text,bigint,boolean)
  to service_role;

commit;
