drop function if exists public.expire_operation_execution_leases(integer);
drop function if exists public.request_owned_operation_cancellation(text,text,uuid,text,bigint,boolean);
drop function if exists public.release_operation_execution_lease(text,uuid,integer,uuid);
drop function if exists public.renew_operation_execution_lease(text,uuid,integer,uuid,text,uuid);
drop function if exists public.acquire_operation_execution_lease(text,uuid,integer,uuid);

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
        and operation.last_progress_at < now() - interval '2 minutes'
        and coalesce(dispatch.claimed_at, dispatch.created_at) < now() - interval '2 minutes'
        and dispatch.operation_id in (
          select candidate.id from public.bulk_operation as candidate
          where candidate.status = 'running'
            and candidate.last_progress_at < now() - interval '2 minutes'
          order by candidate.last_progress_at, candidate.id limit p_limit
          for update skip locked
        )
      returning dispatch.*;
end;
$$;

drop table if exists public.operation_execution_lease;
