delete from public.task_preflight_confirmation where draft_id in
  (select id from public.operation_draft where restore_source_operation_id is not null);
delete from public.operation_draft where restore_source_operation_id is not null;
drop function public.launch_confirmed_restore_preflight(text,text,text,uuid,integer,timestamptz,uuid,bigint,boolean,jsonb,text,text,text,text,text,text);
drop function public.save_restore_preflight(text,text,uuid,integer,bigint,boolean,jsonb,text,text,text);
drop function public.read_private_restore_draft(text,text,uuid,bigint,boolean);
drop function public.save_restore_operation_draft(text,text,uuid,uuid,bigint,bigint,boolean,text[],jsonb,jsonb,text,text);
drop function public.read_restore_source(text,text,uuid,bigint,boolean);
drop table public.private_restore_draft;
alter table public.operation_draft drop constraint operation_draft_restore_triplet,
  drop column restore_intents, drop column restore_source_state_version,
  drop column restore_source_operation_id;
create or replace function public.clear_retry_draft_on_normal_edit()
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
