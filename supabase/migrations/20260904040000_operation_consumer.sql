begin;

-- A claim is durable before the external write. A writing claim is never silently reset to
-- prepared: an expired writer must reconcile the task before a second write is considered.
create table public.operation_task_claim (
  operation_id uuid not null references public.bulk_operation(id) on delete restrict,
  task_id text not null,
  launch_attempt integer not null,
  claim_id uuid not null,
  phase text not null,
  lease_until timestamptz not null,
  before_version text,
  actor_access_version bigint,
  required_field_ids text[] not null default '{}',
  before_mutation_version bigint,
  after_mutation_version bigint,
  applied_field_ids text[] not null default '{}',
  protected_ciphertext bytea,
  protected_nonce bytea,
  protected_key_version text,
  protected_payload_version smallint,
  updated_at timestamptz not null default now(),
  primary key (operation_id, task_id),
  constraint operation_task_claim_phase check (phase in ('prepared','writing','applied','done')),
  constraint operation_task_claim_versions check (before_mutation_version is null or before_mutation_version >= 0),
  constraint operation_task_claim_protected check (
    (protected_ciphertext is null and protected_nonce is null and protected_key_version is null
      and protected_payload_version is null)
    or (protected_ciphertext is not null and octet_length(protected_ciphertext) > 0
      and octet_length(protected_nonce) = 12 and protected_key_version is not null
      and protected_payload_version > 0)
  )
);
create index operation_task_claim_expired on public.operation_task_claim(lease_until)
  where phase <> 'done';
alter table public.operation_task_claim enable row level security;
revoke all on public.operation_task_claim from public, anon, authenticated;
grant select on public.operation_task_claim to service_role;

-- Mock-only durable state. The production adapter remains unavailable until real Bitrix credentials
-- and contract tests exist. Every persisted mutation increments the full-task version.
create table public.mock_task_state (
  portal_id text not null,
  task_id text not null,
  task jsonb not null,
  mutation_version bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (portal_id, task_id),
  constraint mock_task_state_version check (mutation_version > 0),
  constraint mock_task_state_shape check (jsonb_typeof(task) = 'object')
);
alter table public.mock_task_state enable row level security;
revoke all on public.mock_task_state from public, anon, authenticated;
grant select on public.mock_task_state to service_role;

create table public.operation_api_rate_slot (
  portal_id text primary key,
  next_at timestamptz not null
);
alter table public.operation_api_rate_slot enable row level security;
revoke all on public.operation_api_rate_slot from public, anon, authenticated;

create function public.reserve_operation_api_slot(p_portal_id text, p_operation_id uuid,
  p_launch_attempt integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_next timestamptz;
  v_reserved timestamptz;
begin
  if not exists(select 1 from public.bulk_operation where portal_id = p_portal_id
    and id = p_operation_id and launch_attempt = p_launch_attempt and status = 'running') then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('operation-rate:' || p_portal_id,0));
  select next_at into v_next from public.operation_api_rate_slot
    where portal_id = p_portal_id for update;
  v_reserved := greatest(now(), coalesce(v_next, now()));
  insert into public.operation_api_rate_slot(portal_id,next_at)
    values(p_portal_id,v_reserved + interval '200 milliseconds')
    on conflict(portal_id) do update set next_at = excluded.next_at;
  return ceil(extract(epoch from v_reserved - now()) * 1000)::integer;
end;
$$;

create function public.read_mock_task_state(p_portal_id text, p_task_id text)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('task',task,'mutationVersion',mutation_version)
    from public.mock_task_state where portal_id = p_portal_id and task_id = p_task_id;
$$;

create function public.list_mock_task_state(p_portal_id text)
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('task',task,'mutationVersion',mutation_version)), '[]'::jsonb)
    from public.mock_task_state where portal_id = p_portal_id;
$$;

-- Local scenario mutations use the same full-task monotonic version as operation writes.
create function public.mutate_mock_task_state(p_portal_id text, p_task_id text,
  p_expected_mutation_version bigint, p_task jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_state public.mock_task_state;
  v_next bigint;
begin
  if p_expected_mutation_version is null or p_expected_mutation_version < 0
    or p_task->>'id' is distinct from p_task_id
    or jsonb_typeof(p_task->'values') is distinct from 'object' then
    raise exception 'TC_MOCK_TASK_MUTATION_INVALID' using errcode = '22023';
  end if;
  select * into v_state from public.mock_task_state where portal_id = p_portal_id
    and task_id = p_task_id for update;
  if found then
    if v_state.mutation_version <> p_expected_mutation_version then return null; end if;
  elsif p_expected_mutation_version <> 0 then return null;
  end if;
  v_next := p_expected_mutation_version + 1;
  if v_state.task_id is null then
    insert into public.mock_task_state(portal_id,task_id,task,mutation_version)
      values(p_portal_id,p_task_id,p_task,v_next)
      on conflict(portal_id,task_id) do nothing;
  else
    update public.mock_task_state set task = p_task, mutation_version = v_next,
      updated_at = now() where portal_id = p_portal_id and task_id = p_task_id
        and mutation_version = p_expected_mutation_version;
  end if;
  if not found then return null; end if;
  return v_next;
end;
$$;

create function public.read_operation_execution(p_portal_id text, p_operation_id uuid,
  p_launch_attempt integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.bulk_operation;
  v_plan public.private_operation_execution_plan;
  v_settings public.user_settings;
begin
  select * into v_operation from public.bulk_operation
    where portal_id = p_portal_id and id = p_operation_id;
  if not found or v_operation.launch_attempt <> p_launch_attempt
    or v_operation.status not in ('launching','running') then return null; end if;
  select * into v_plan from public.private_operation_execution_plan
    where operation_id = p_operation_id;
  if not found then raise exception 'TC_OPERATION_PLAN_MISSING' using errcode = 'P0001'; end if;
  select * into v_settings from public.user_settings
    where portal_id = p_portal_id and user_id = v_operation.initiator_id;
  return jsonb_build_object(
    'operation', to_jsonb(v_operation),
    'plan', jsonb_build_object('ciphertext', encode(v_plan.ciphertext, 'base64'),
      'nonce', encode(v_plan.nonce, 'base64'), 'keyVersion', v_plan.key_version,
      'payloadVersion', v_plan.payload_version),
    'access', case when found then jsonb_build_object(
      'active', v_settings.access_state = 'active', 'version', v_settings.access_version,
      'permissions', v_settings.permissions, 'allowedFieldIds', v_settings.allowed_field_ids
    ) else null end
  );
end;
$$;

create function public.claim_operation_task(p_portal_id text, p_operation_id uuid,
  p_launch_attempt integer, p_task_id text, p_claim_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.bulk_operation;
  v_claim public.operation_task_claim;
begin
  select * into v_operation from public.bulk_operation
    where portal_id = p_portal_id and id = p_operation_id for update;
  if not found or v_operation.status <> 'running'
    or v_operation.launch_attempt <> p_launch_attempt
    or v_operation.cancel_requested_at is not null
    or v_operation.interruption_requested_at is not null
    or not (p_task_id = any(v_operation.selected_task_ids)) then
    return jsonb_build_object('disposition','stale');
  end if;
  if exists(select 1 from public.task_processing_result
    where operation_id = p_operation_id and task_id = p_task_id) then
    return jsonb_build_object('disposition','done');
  end if;
  select * into v_claim from public.operation_task_claim
    where operation_id = p_operation_id and task_id = p_task_id for update;
  if not found then
    insert into public.operation_task_claim(operation_id,task_id,launch_attempt,claim_id,phase,lease_until)
      values (p_operation_id,p_task_id,p_launch_attempt,p_claim_id,'prepared',now()+interval '2 minutes')
      returning * into v_claim;
    return jsonb_build_object('disposition','claimed','claim',to_jsonb(v_claim));
  end if;
  if v_claim.phase = 'done' then return jsonb_build_object('disposition','done'); end if;
  if v_claim.lease_until > now() then return jsonb_build_object('disposition','busy'); end if;
  update public.operation_task_claim set claim_id = p_claim_id,
    lease_until = now()+interval '2 minutes', updated_at = now(), launch_attempt = p_launch_attempt
    where operation_id = p_operation_id and task_id = p_task_id returning * into v_claim;
  return jsonb_build_object('disposition',
    case when v_claim.phase = 'prepared' then 'claimed' else 'reconcile' end,
    'claim',to_jsonb(v_claim));
end;
$$;

create function public.read_operation_task_claim(p_portal_id text, p_operation_id uuid,
  p_task_id text)
returns jsonb language sql security definer set search_path = '' as $$
  select to_jsonb(claim) from public.operation_task_claim as claim
    join public.bulk_operation as operation on operation.id = claim.operation_id
    where operation.portal_id = p_portal_id and claim.operation_id = p_operation_id
      and claim.task_id = p_task_id;
$$;

create function public.release_prepared_operation_task(p_portal_id text, p_operation_id uuid,
  p_task_id text, p_claim_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from public.operation_task_claim as claim using public.bulk_operation as operation
    where claim.operation_id = p_operation_id and claim.task_id = p_task_id
      and claim.claim_id = p_claim_id and claim.phase = 'prepared'
      and operation.id = claim.operation_id and operation.portal_id = p_portal_id;
  return found;
end;
$$;

create function public.release_rate_limited_operation_task(p_portal_id text, p_operation_id uuid,
  p_task_id text, p_claim_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from public.operation_task_claim as claim using public.bulk_operation as operation
    where claim.operation_id = p_operation_id and claim.task_id = p_task_id
      and claim.claim_id = p_claim_id and claim.phase = 'writing'
      and claim.after_mutation_version is null
      and operation.id = claim.operation_id and operation.portal_id = p_portal_id
      and not exists(select 1 from public.task_processing_result as result
        where result.operation_id = p_operation_id and result.task_id = p_task_id);
  return found;
end;
$$;

create function public.mark_operation_task_writing(p_portal_id text, p_operation_id uuid,
  p_launch_attempt integer, p_task_id text, p_claim_id uuid,
  p_before_version text, p_before_mutation_version bigint,
  p_actor_access_version bigint, p_required_field_ids text[],
  p_ciphertext text, p_nonce text, p_key_version text, p_payload_version smallint)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_before_version is null or p_before_mutation_version is null or p_before_mutation_version < 0
    or p_ciphertext is null or p_nonce is null or p_key_version is null then return false; end if;
  update public.operation_task_claim as claim set phase = 'writing',
    before_version = p_before_version, before_mutation_version = p_before_mutation_version,
    lease_until = now() + interval '2 minutes',
    actor_access_version = p_actor_access_version, required_field_ids = p_required_field_ids,
    protected_ciphertext = decode(p_ciphertext,'base64'),
    protected_nonce = decode(p_nonce,'base64'), protected_key_version = p_key_version,
    protected_payload_version = p_payload_version, updated_at = now()
    from public.bulk_operation as operation
    where claim.operation_id = p_operation_id and claim.task_id = p_task_id
      and claim.claim_id = p_claim_id and claim.launch_attempt = p_launch_attempt
      and claim.phase = 'prepared' and claim.lease_until > now()
      and operation.id = p_operation_id and operation.portal_id = p_portal_id
      and operation.status = 'running' and operation.launch_attempt = p_launch_attempt
      and operation.cancel_requested_at is null and operation.interruption_requested_at is null
      and (p_actor_access_version is null or exists (
        select 1 from public.user_settings as settings
          where settings.portal_id = p_portal_id and settings.user_id = operation.initiator_id
            and settings.access_state = 'active'
            and settings.access_version = p_actor_access_version
            and array['app_access','run_bulk_operations','change_allowed_fields']::text[] <@ settings.permissions
            and p_required_field_ids <@ settings.allowed_field_ids
      ));
  return found;
end;
$$;

create function public.apply_claimed_mock_task_change(p_portal_id text, p_operation_id uuid,
  p_launch_attempt integer, p_task_id text, p_claim_id uuid,
  p_expected_mutation_version bigint, p_base_task jsonb, p_target_values jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation public.bulk_operation;
  v_claim public.operation_task_claim;
  v_settings public.user_settings;
  v_state public.mock_task_state;
  v_task jsonb;
  v_field text;
  v_value jsonb;
  v_applied text[] := '{}';
  v_after bigint;
begin
  select * into v_operation from public.bulk_operation
    where portal_id = p_portal_id and id = p_operation_id for share;
  if not found or v_operation.launch_attempt <> p_launch_attempt
    or v_operation.status <> 'running' or v_operation.cancel_requested_at is not null
    or v_operation.interruption_requested_at is not null then
    return jsonb_build_object('kind','stale');
  end if;
  select * into v_claim from public.operation_task_claim
    where operation_id = p_operation_id and task_id = p_task_id for update;
  if not found or v_claim.claim_id <> p_claim_id or v_claim.phase <> 'writing'
    or v_claim.launch_attempt <> p_launch_attempt or v_claim.lease_until <= now()
    or v_claim.before_mutation_version <> p_expected_mutation_version then
    return jsonb_build_object('kind','stale');
  end if;
  if v_claim.actor_access_version is not null then
    select * into v_settings from public.user_settings where portal_id = p_portal_id
      and user_id = v_operation.initiator_id for share;
    if not found or v_settings.access_state <> 'active'
      or v_settings.access_version <> v_claim.actor_access_version
      or not (array['app_access','run_bulk_operations','change_allowed_fields']::text[] <@ v_settings.permissions)
      or not (v_claim.required_field_ids <@ v_settings.allowed_field_ids) then
      return jsonb_build_object('kind','stale');
    end if;
  end if;
  select * into v_state from public.mock_task_state
    where portal_id = p_portal_id and task_id = p_task_id for update;
  if found then
    if v_state.mutation_version <> p_expected_mutation_version then
      return jsonb_build_object('kind','conflict');
    end if;
    v_task := v_state.task;
  else
    if p_expected_mutation_version <> 0 or p_base_task is null then
      return jsonb_build_object('kind','conflict');
    end if;
    v_task := p_base_task;
  end if;
  if jsonb_typeof(p_target_values) <> 'object' or jsonb_typeof(v_task->'values') <> 'object'
    or v_task->>'id' <> p_task_id then return jsonb_build_object('kind','invalid'); end if;
  for v_field, v_value in select key,value from jsonb_each(p_target_values) loop
    if (v_task->'values'->v_field) is distinct from v_value then
      v_applied := array_append(v_applied,v_field);
      v_task := jsonb_set(v_task,array['values',v_field],v_value,true);
      if v_field = 'title' then v_task := jsonb_set(v_task,'{title}',v_value,true); end if;
      if v_field = 'status' then v_task := jsonb_set(v_task,'{status}',v_value,true); end if;
    end if;
  end loop;
  if cardinality(v_applied) = 0 then return jsonb_build_object('kind','no_change'); end if;
  v_after := p_expected_mutation_version + 1;
  if v_state.task_id is null then
    insert into public.mock_task_state(portal_id,task_id,task,mutation_version)
      values(p_portal_id,p_task_id,v_task,v_after)
      on conflict (portal_id,task_id) do nothing;
  else
    update public.mock_task_state set task = v_task, mutation_version = v_after, updated_at = now()
      where portal_id = p_portal_id and task_id = p_task_id
        and mutation_version = p_expected_mutation_version;
  end if;
  if not found then return jsonb_build_object('kind','conflict'); end if;
  update public.operation_task_claim set phase = 'applied', after_mutation_version = v_after,
    applied_field_ids = v_applied, updated_at = now()
    where operation_id = p_operation_id and task_id = p_task_id;
  return jsonb_build_object('kind','success','appliedFieldIds',v_applied,
    'afterMutationVersion',v_after);
end;
$$;

create function public.record_claimed_task_result(p_portal_id text, p_operation_id uuid,
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
      case when p_outcome in ('success','partially_applied') then v_claim.before_version else null end,
      case when p_outcome in ('success','partially_applied') then p_after_version else null end);
    if found and v_existing.result_fingerprint = v_fingerprint then
      select * into v_protected from public.protected_task_result
        where task_processing_result_id = v_existing.id;
      if (p_outcome in ('success','partially_applied') and found
        and v_protected.after_version = p_after_version
        and v_protected.before_version = v_claim.before_version)
        or (p_outcome not in ('success','partially_applied') and not found) then
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
    or (p_outcome in ('success','partially_applied') and (
      v_claim.phase <> 'applied' or v_claim.after_mutation_version is null
      or p_after_version is distinct from 'mock:' || v_claim.after_mutation_version::text)) then
    return jsonb_build_object('inserted',false,'rejected',true,'reasonCode','TASK_CLAIM_STALE');
  end if;
  v_result := public.record_task_processing_result_with_attempt(
    p_portal_id,p_operation_id,p_launch_attempt,p_task_id,p_task_title,p_task_url,
    p_outcome,p_requested_field_ids,p_applied_field_ids,p_failed_field_ids,
    p_reason_code,p_reason_message,p_correlation_id,p_can_retry,
    case when p_outcome in ('success','partially_applied') then v_claim.protected_ciphertext else null end,
    case when p_outcome in ('success','partially_applied') then v_claim.protected_nonce else null end,
    case when p_outcome in ('success','partially_applied') then v_claim.protected_key_version else null end,
    case when p_outcome in ('success','partially_applied') then v_claim.protected_payload_version else null end,
    case when p_outcome in ('success','partially_applied') then v_claim.before_version else null end,
    case when p_outcome in ('success','partially_applied') then p_after_version else null end
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

create function public.claim_stalled_operation_executions(p_limit integer)
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

-- A later confirmation of an initially unconfirmed write must not create a restorable result
-- without its encrypted before-values. The refinement and protected payload commit together.
create function public.refine_claimed_task_result(p_portal_id text, p_operation_id uuid,
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
    p_portal_id,p_operation_id,p_task_id,'success',v_claim.applied_field_ids,'{}'::text[],
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

revoke all on function public.read_operation_execution(text,uuid,integer) from public, anon, authenticated;
revoke all on function public.reserve_operation_api_slot(text,uuid,integer) from public, anon, authenticated;
revoke all on function public.read_mock_task_state(text,text) from public, anon, authenticated;
revoke all on function public.list_mock_task_state(text) from public, anon, authenticated;
revoke all on function public.mutate_mock_task_state(text,text,bigint,jsonb) from public, anon, authenticated;
revoke all on function public.claim_operation_task(text,uuid,integer,text,uuid) from public, anon, authenticated;
revoke all on function public.read_operation_task_claim(text,uuid,text) from public, anon, authenticated;
revoke all on function public.release_prepared_operation_task(text,uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.release_rate_limited_operation_task(text,uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.mark_operation_task_writing(text,uuid,integer,text,uuid,text,bigint,bigint,text[],text,text,text,smallint) from public, anon, authenticated;
revoke all on function public.apply_claimed_mock_task_change(text,uuid,integer,text,uuid,bigint,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.record_claimed_task_result(text,uuid,integer,text,uuid,text,text,text,text[],text[],text[],text,text,text,boolean,text) from public, anon, authenticated;
revoke all on function public.claim_stalled_operation_executions(integer) from public, anon, authenticated;
revoke all on function public.refine_claimed_task_result(text,uuid,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.read_operation_execution(text,uuid,integer) to service_role;
grant execute on function public.reserve_operation_api_slot(text,uuid,integer) to service_role;
grant execute on function public.read_mock_task_state(text,text) to service_role;
grant execute on function public.list_mock_task_state(text) to service_role;
grant execute on function public.mutate_mock_task_state(text,text,bigint,jsonb) to service_role;
grant execute on function public.claim_operation_task(text,uuid,integer,text,uuid) to service_role;
grant execute on function public.read_operation_task_claim(text,uuid,text) to service_role;
grant execute on function public.release_prepared_operation_task(text,uuid,text,uuid) to service_role;
grant execute on function public.release_rate_limited_operation_task(text,uuid,text,uuid) to service_role;
grant execute on function public.mark_operation_task_writing(text,uuid,integer,text,uuid,text,bigint,bigint,text[],text,text,text,smallint) to service_role;
grant execute on function public.apply_claimed_mock_task_change(text,uuid,integer,text,uuid,bigint,jsonb,jsonb) to service_role;
grant execute on function public.record_claimed_task_result(text,uuid,integer,text,uuid,text,text,text,text[],text[],text[],text,text,text,boolean,text) to service_role;
grant execute on function public.claim_stalled_operation_executions(integer) to service_role;
grant execute on function public.refine_claimed_task_result(text,uuid,text,uuid,text,text) to service_role;

commit;
