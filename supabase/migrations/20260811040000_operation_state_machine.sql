begin;

alter table public.bulk_operation
  add column request_fingerprint text;

update public.bulk_operation
set request_fingerprint = encode(
  extensions.digest(
    jsonb_build_object(
      'type', operation_type,
      'sourceOperationId', source_operation_id,
      'filterSnapshot', filter_snapshot,
      'selectedTaskIds', selected_task_ids,
      'changes', changes,
      'preflightSnapshot', preflight_snapshot,
      'selected', selected_count,
      'eligible', eligible_count,
      'excluded', excluded_count,
      'unchanged', unchanged_count
    )::text,
    'sha256'
  ),
  'hex'
);

alter table public.bulk_operation
  alter column request_fingerprint set not null,
  alter column request_fingerprint set default repeat('0', 64),
  add column interruption_requested_at timestamptz,
  add constraint bulk_operation_request_fingerprint_format
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint bulk_operation_single_stop_request check (
    cancel_requested_at is null or interruption_requested_at is null
  );

create function public.operation_request_fingerprint(
  p_operation_type text,
  p_source_operation_id uuid,
  p_filter_snapshot jsonb,
  p_selected_task_ids text[],
  p_changes jsonb,
  p_preflight_snapshot jsonb,
  p_selected_count integer,
  p_eligible_count integer,
  p_excluded_count integer,
  p_unchanged_count integer
)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select encode(
    extensions.digest(
      jsonb_build_object(
        'type', p_operation_type,
        'sourceOperationId', p_source_operation_id,
        'filterSnapshot', p_filter_snapshot,
        'selectedTaskIds', p_selected_task_ids,
        'changes', p_changes,
        'preflightSnapshot', p_preflight_snapshot,
        'selected', p_selected_count,
        'eligible', p_eligible_count,
        'excluded', p_excluded_count,
        'unchanged', p_unchanged_count
      )::text,
      'sha256'
    ),
    'hex'
  );
$$;

create function public.append_operation_state_error(
  p_portal_id text,
  p_operation_id uuid,
  p_correlation_id text,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_occurred_at timestamptz;
begin
  select occurred_at into v_occurred_at
  from public.audit_event
  where portal_id = p_portal_id
    and event_key = encode(
      extensions.digest(
        coalesce(p_operation_id::text, 'operation-state-machine') || ':' || p_correlation_id
          || chr(31) || 'system_error' || chr(31) || 'state-rejection',
        'sha256'
      ),
      'hex'
    );

  perform public.append_audit_event(
    p_portal_id,
    coalesce(v_occurred_at, now()),
    'system_error',
    'system',
    null,
    'Система',
    'internal',
    'system',
    coalesce(p_operation_id::text, 'operation-state-machine'),
    'Машина состояний операции',
    '[]'::jsonb,
    'failure',
    p_correlation_id,
    coalesce(p_operation_id::text, 'operation-state-machine') || ':' || p_correlation_id,
    'state-rejection',
    jsonb_build_object(
      'kind', 'system',
      'component', 'operation-state-machine',
      'errorCode', p_error_code,
      'retryable', false
    )
  );
end;
$$;

create function public.set_bulk_operation_state_machine_context()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('task_commander.state_machine', 'enabled', true);
end;
$$;

create function public.prevent_bulk_operation_status_bypass()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from old.status
    and current_setting('task_commander.state_machine', true) is distinct from 'enabled' then
    raise exception 'Bulk operation status changes require the state machine.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger bulk_operation_prevent_status_bypass
before update on public.bulk_operation
for each row execute function public.prevent_bulk_operation_status_bypass();

create function public.create_bulk_operation_idempotent(
  p_portal_id text,
  p_operation_type text,
  p_initiator_id text,
  p_initiator_display_name text,
  p_source_operation_id uuid,
  p_idempotency_key text,
  p_filter_snapshot jsonb,
  p_selected_task_ids text[],
  p_changes jsonb,
  p_preflight_snapshot jsonb,
  p_selected_count integer,
  p_eligible_count integer,
  p_excluded_count integer,
  p_unchanged_count integer,
  p_correlation_id text,
  p_initial_results jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_fingerprint text;
  v_existing public.bulk_operation;
  v_active public.bulk_operation;
  v_created public.bulk_operation;
  v_initial_count integer;
begin
  if p_selected_count <> cardinality(p_selected_task_ids)
    or p_selected_count <> p_eligible_count + p_excluded_count + p_unchanged_count
    or p_selected_count <> cardinality(array(select distinct unnest(p_selected_task_ids))) then
    perform public.append_operation_state_error(
      p_portal_id, null, p_correlation_id, 'OPERATION_REQUEST_INVALID'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_REQUEST_INVALID');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_portal_id || chr(31) || p_initiator_id, 0));
  v_fingerprint := public.operation_request_fingerprint(
    p_operation_type, p_source_operation_id, p_filter_snapshot, p_selected_task_ids, p_changes,
    p_preflight_snapshot, p_selected_count, p_eligible_count, p_excluded_count, p_unchanged_count
  );

  select * into v_existing
  from public.bulk_operation
  where portal_id = p_portal_id
    and initiator_id = p_initiator_id
    and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint = v_fingerprint then
      return jsonb_build_object('disposition', 'existing', 'operation', to_jsonb(v_existing));
    end if;
    perform public.append_operation_state_error(
      p_portal_id, v_existing.id, p_correlation_id, 'IDEMPOTENCY_PAYLOAD_MISMATCH'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  end if;

  select * into v_active
  from public.bulk_operation
  where portal_id = p_portal_id
    and initiator_id = p_initiator_id
    and status in ('launching', 'running')
  order by created_at desc
  limit 1;

  if found then
    return jsonb_build_object('disposition', 'active_operation', 'operation', to_jsonb(v_active));
  end if;

  if jsonb_typeof(p_initial_results) <> 'array' then
    perform public.append_operation_state_error(
      p_portal_id, null, p_correlation_id, 'INITIAL_RESULTS_INVALID'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'INITIAL_RESULTS_INVALID');
  end if;

  v_initial_count := jsonb_array_length(p_initial_results);
  if v_initial_count <> p_excluded_count + p_unchanged_count then
    perform public.append_operation_state_error(
      p_portal_id, null, p_correlation_id, 'INITIAL_RESULTS_COUNT_MISMATCH'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'INITIAL_RESULTS_COUNT_MISMATCH');
  end if;

  insert into public.bulk_operation (
    portal_id, operation_type, status, initiator_id, initiator_display_name, source_operation_id,
    idempotency_key, request_fingerprint, filter_snapshot, selected_task_ids, changes,
    preflight_snapshot, selected_count, eligible_count, excluded_count, unchanged_count
  ) values (
    p_portal_id, p_operation_type,
    case when p_eligible_count = 0 then 'completed' else 'launching' end,
    p_initiator_id, p_initiator_display_name, p_source_operation_id, p_idempotency_key,
    v_fingerprint, p_filter_snapshot, p_selected_task_ids, p_changes, p_preflight_snapshot,
    p_selected_count, p_eligible_count, p_excluded_count, p_unchanged_count
  ) returning * into v_created;

  if v_initial_count > 0 then
    insert into public.task_processing_result (
      operation_id, task_id, task_title, task_url, outcome, requested_field_ids,
      applied_field_ids, failed_field_ids, reason_code, reason_message, correlation_id, can_retry
    )
    select
      v_created.id,
      entry->>'taskId',
      entry->>'title',
      entry->>'taskUrl',
      entry->>'outcome',
      coalesce(array(select jsonb_array_elements_text(entry->'requestedFieldIds')), '{}'::text[]),
      '{}'::text[],
      '{}'::text[],
      entry->>'reasonCode',
      entry->>'reasonMessage',
      null,
      false
    from jsonb_array_elements(p_initial_results) as entry;
  end if;

  if p_eligible_count = 0 then
    perform public.set_bulk_operation_state_machine_context();
    update public.bulk_operation
    set completed_at = now()
    where id = v_created.id
    returning * into v_created;
  end if;

  perform public.append_audit_event(
    p_portal_id, now(), 'operation_create', 'user', p_initiator_id, p_initiator_display_name,
    null, 'operation', v_created.id::text, 'Массовая операция', '[]'::jsonb, 'success',
    p_correlation_id, v_created.id::text, 'create',
    jsonb_build_object('kind', 'operation', 'reasonCode', null, 'summary', null)
  );

  if p_eligible_count = 0 then
    perform public.append_audit_event(
      p_portal_id, now(), 'operation_complete', 'user', p_initiator_id, p_initiator_display_name,
      null, 'operation', v_created.id::text, 'Массовая операция', '[]'::jsonb, 'success',
      p_correlation_id, v_created.id::text, 'complete',
      jsonb_build_object(
        'kind', 'operation', 'reasonCode', null,
        'summary', jsonb_build_object(
          'selected', p_selected_count, 'successful', 0, 'failed', 0, 'conflicted', 0,
          'partiallyApplied', 0, 'notProcessed', 0
        )
      )
    );
  end if;

  return jsonb_build_object('disposition', 'created', 'operation', to_jsonb(v_created));
end;
$$;

create function public.start_bulk_operation(
  p_portal_id text,
  p_operation_id uuid,
  p_correlation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation public.bulk_operation;
begin
  select * into v_operation from public.bulk_operation
  where id = p_operation_id and portal_id = p_portal_id for update;

  if not found then
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_UNAVAILABLE');
  end if;
  if v_operation.status = 'running' then
    return jsonb_build_object('disposition', 'already_applied', 'operation', to_jsonb(v_operation));
  end if;
  if v_operation.status in ('completed', 'completed_with_errors', 'cancelled', 'interrupted', 'launch_failed') then
    return jsonb_build_object('disposition', 'already_applied', 'operation', to_jsonb(v_operation));
  end if;
  if v_operation.status <> 'launching' or v_operation.cancel_requested_at is not null
    or v_operation.interruption_requested_at is not null then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'OPERATION_START_REJECTED'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_START_REJECTED');
  end if;

  perform public.set_bulk_operation_state_machine_context();
  update public.bulk_operation
  set status = 'running', started_at = coalesce(started_at, now()), last_progress_at = now()
  where id = p_operation_id
  returning * into v_operation;

  perform public.append_audit_event(
    p_portal_id, now(), 'operation_start', 'system', null, 'Система', 'queue',
    'operation', p_operation_id::text, 'Массовая операция', '[]'::jsonb, 'success',
    p_correlation_id, p_operation_id::text, 'start',
    jsonb_build_object('kind', 'operation', 'reasonCode', null, 'summary', null)
  );
  return jsonb_build_object('disposition', 'applied', 'operation', to_jsonb(v_operation));
end;
$$;

create function public.request_bulk_operation_stop(
  p_portal_id text,
  p_operation_id uuid,
  p_stop_kind text,
  p_reason_code text,
  p_reason_message text,
  p_correlation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation public.bulk_operation;
begin
  select * into v_operation from public.bulk_operation
  where id = p_operation_id and portal_id = p_portal_id for update;

  if not found then
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_UNAVAILABLE');
  end if;
  if v_operation.status in ('completed', 'completed_with_errors', 'cancelled', 'interrupted', 'launch_failed')
    or v_operation.cancel_requested_at is not null
    or v_operation.interruption_requested_at is not null then
    return jsonb_build_object('disposition', 'already_applied', 'operation', to_jsonb(v_operation));
  end if;
  if p_stop_kind not in ('cancel', 'interrupt') then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'STOP_KIND_INVALID'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'STOP_KIND_INVALID');
  end if;

  update public.bulk_operation
  set
    cancel_requested_at = case when p_stop_kind = 'cancel' then now() else null end,
    interruption_requested_at = case when p_stop_kind = 'interrupt' then now() else null end,
    interruption_reason_code = case when p_stop_kind = 'interrupt' then p_reason_code else null end,
    interruption_reason_message = case when p_stop_kind = 'interrupt' then p_reason_message else null end
  where id = p_operation_id
  returning * into v_operation;

  return jsonb_build_object('disposition', 'applied', 'operation', to_jsonb(v_operation));
end;
$$;

create or replace function public.record_task_processing_result(
  p_portal_id text,
  p_operation_id uuid,
  p_task_id text,
  p_task_title text,
  p_task_url text,
  p_outcome text,
  p_requested_field_ids text[],
  p_applied_field_ids text[],
  p_failed_field_ids text[],
  p_reason_code text,
  p_reason_message text,
  p_correlation_id text,
  p_can_retry boolean,
  p_protected_ciphertext bytea default null,
  p_protected_nonce bytea default null,
  p_protected_key_version text default null,
  p_protected_payload_version smallint default null,
  p_before_version text default null,
  p_after_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  locked_operation public.bulk_operation;
  inserted_result public.task_processing_result;
  existing_result public.task_processing_result;
  existing_protected_result public.protected_task_result;
  updated_operation public.bulk_operation;
  has_protected_payload boolean;
  result_count integer;
begin
  has_protected_payload := p_protected_ciphertext is not null;
  if has_protected_payload <> (
    p_protected_nonce is not null and p_protected_key_version is not null
    and p_protected_payload_version is not null and p_before_version is not null
    and p_after_version is not null
  ) then
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'PROTECTED_RESULT_PAYLOAD_INVALID');
  end if;

  select * into locked_operation from public.bulk_operation
  where id = p_operation_id and portal_id = p_portal_id for update;
  if not found then
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'OPERATION_UNAVAILABLE');
  end if;

  select * into existing_result from public.task_processing_result
  where operation_id = p_operation_id and task_id = p_task_id;
  if found then
    if existing_result.task_title is not distinct from p_task_title
      and existing_result.task_url is not distinct from p_task_url
      and existing_result.outcome is not distinct from p_outcome
      and existing_result.requested_field_ids is not distinct from p_requested_field_ids
      and existing_result.applied_field_ids is not distinct from p_applied_field_ids
      and existing_result.failed_field_ids is not distinct from p_failed_field_ids
      and existing_result.reason_code is not distinct from p_reason_code
      and existing_result.reason_message is not distinct from p_reason_message
      and existing_result.correlation_id is not distinct from p_correlation_id
      and existing_result.can_retry is not distinct from p_can_retry then
      select * into existing_protected_result
      from public.protected_task_result
      where task_processing_result_id = existing_result.id;

      if (has_protected_payload and (
        not found
        or existing_protected_result.payload_version is distinct from p_protected_payload_version
        or existing_protected_result.before_version is distinct from p_before_version
        or existing_protected_result.after_version is distinct from p_after_version
      )) or (not has_protected_payload and found) then
        perform public.append_operation_state_error(
          p_portal_id, p_operation_id, coalesce(p_correlation_id, 'TC-00000000-0000-4000-8000-000000000000'),
          'TASK_RESULT_CONFLICT'
        );
        return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'TASK_RESULT_CONFLICT');
      end if;
      return jsonb_build_object('inserted', false, 'result', to_jsonb(existing_result), 'summary', jsonb_build_object(
        'successful', locked_operation.successful_count, 'failed', locked_operation.failed_count,
        'conflicted', locked_operation.conflicted_count, 'partiallyApplied', locked_operation.partially_applied_count,
        'notProcessed', locked_operation.not_processed_count
      ));
    end if;
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, coalesce(p_correlation_id, 'TC-00000000-0000-4000-8000-000000000000'),
      'TASK_RESULT_CONFLICT'
    );
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'TASK_RESULT_CONFLICT');
  end if;

  if locked_operation.status <> 'running'
    or not (p_task_id = any(locked_operation.selected_task_ids))
    or p_outcome not in ('success', 'error', 'conflict', 'restored', 'restore_error', 'partially_applied') then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, coalesce(p_correlation_id, 'TC-00000000-0000-4000-8000-000000000000'),
      'TASK_RESULT_REJECTED'
    );
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'TASK_RESULT_REJECTED');
  end if;

  insert into public.task_processing_result (
    operation_id, task_id, task_title, task_url, outcome, requested_field_ids, applied_field_ids,
    failed_field_ids, reason_code, reason_message, correlation_id, can_retry
  ) values (
    p_operation_id, p_task_id, p_task_title, p_task_url, p_outcome, p_requested_field_ids,
    p_applied_field_ids, p_failed_field_ids, p_reason_code, p_reason_message, p_correlation_id, p_can_retry
  ) returning * into inserted_result;

  if has_protected_payload then
    insert into public.protected_task_result (
      task_processing_result_id, ciphertext, nonce, key_version, payload_version, before_version, after_version
    ) values (
      inserted_result.id, p_protected_ciphertext, p_protected_nonce, p_protected_key_version,
      p_protected_payload_version, p_before_version, p_after_version
    );
  end if;

  select count(*) into result_count from public.task_processing_result where operation_id = p_operation_id;
  if result_count > locked_operation.selected_count then
    raise exception 'TC_TASK_RESULT_COUNT_INVALID' using errcode = 'P0001';
  end if;

  update public.bulk_operation
  set
    successful_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome in ('success', 'restored')),
    failed_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome in ('error', 'restore_error')),
    conflicted_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'conflict'),
    partially_applied_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'partially_applied'),
    not_processed_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'not_processed'),
    last_progress_at = now()
  where id = p_operation_id and portal_id = p_portal_id
  returning * into updated_operation;

  return jsonb_build_object('inserted', true, 'result', to_jsonb(inserted_result), 'summary', jsonb_build_object(
    'successful', updated_operation.successful_count, 'failed', updated_operation.failed_count,
    'conflicted', updated_operation.conflicted_count, 'partiallyApplied', updated_operation.partially_applied_count,
    'notProcessed', updated_operation.not_processed_count
  ));
end;
$$;

create function public.finalize_bulk_operation(
  p_portal_id text,
  p_operation_id uuid,
  p_correlation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation public.bulk_operation;
  v_next_status text;
  v_processed integer;
  v_outcome text;
  v_action text;
begin
  select * into v_operation from public.bulk_operation
  where id = p_operation_id and portal_id = p_portal_id for update;
  if not found then
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_UNAVAILABLE');
  end if;
  if v_operation.status in ('completed', 'completed_with_errors', 'cancelled', 'interrupted', 'launch_failed') then
    return jsonb_build_object('disposition', 'already_applied', 'operation', to_jsonb(v_operation));
  end if;

  if v_operation.status in ('launching', 'running') then
    if v_operation.cancel_requested_at is not null or v_operation.interruption_requested_at is not null then
      insert into public.task_processing_result (
        operation_id, task_id, task_title, task_url, outcome, requested_field_ids,
        applied_field_ids, failed_field_ids, reason_code, reason_message, correlation_id, can_retry
      )
      select
        p_operation_id,
        selected_task_id,
        null,
        null,
        'not_processed',
        '{}'::text[],
        '{}'::text[],
        '{}'::text[],
        case when v_operation.cancel_requested_at is not null then 'CANCELLED' else v_operation.interruption_reason_code end,
        case when v_operation.cancel_requested_at is not null then 'Операция остановлена до обработки задачи.' else v_operation.interruption_reason_message end,
        null,
        true
      from unnest(v_operation.selected_task_ids) as selected_task_id
      left join public.task_processing_result existing_result
        on existing_result.operation_id = p_operation_id and existing_result.task_id = selected_task_id
      where existing_result.id is null;

      update public.bulk_operation
      set
        successful_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome in ('success', 'restored')),
        failed_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome in ('error', 'restore_error')),
        conflicted_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'conflict'),
        partially_applied_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'partially_applied'),
        not_processed_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'not_processed')
      where id = p_operation_id
      returning * into v_operation;
    end if;

    select count(*) into v_processed
    from public.task_processing_result
    where operation_id = p_operation_id
      and outcome not in ('excluded_by_preflight', 'no_change');

    if v_processed <> v_operation.eligible_count then
      perform public.append_operation_state_error(
        p_portal_id, p_operation_id, p_correlation_id, 'OPERATION_FINALIZATION_INCOMPLETE'
      );
      return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_FINALIZATION_INCOMPLETE');
    end if;

    if v_operation.cancel_requested_at is not null and v_operation.not_processed_count > 0 then
      v_next_status := 'cancelled';
    elsif v_operation.interruption_requested_at is not null and v_operation.not_processed_count > 0 then
      v_next_status := 'interrupted';
    elsif v_operation.failed_count + v_operation.conflicted_count + v_operation.partially_applied_count > 0 then
      v_next_status := 'completed_with_errors';
    else
      v_next_status := 'completed';
    end if;

    perform public.set_bulk_operation_state_machine_context();
    update public.bulk_operation
    set status = v_next_status, completed_at = now()
    where id = p_operation_id
    returning * into v_operation;
  else
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'OPERATION_FINALIZATION_REJECTED'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_FINALIZATION_REJECTED');
  end if;

  if v_operation.status = 'cancelled' then
    v_action := 'operation_cancel';
    v_outcome := 'success';
  elsif v_operation.status = 'interrupted' then
    v_action := 'operation_interrupt';
    v_outcome := 'failure';
  else
    v_action := 'operation_complete';
    v_outcome := case when v_operation.status = 'completed_with_errors' then 'partial' else 'success' end;
  end if;

  perform public.append_audit_event(
    p_portal_id, now(), v_action, 'system', null, 'Система', 'queue',
    'operation', p_operation_id::text, 'Массовая операция', '[]'::jsonb, v_outcome,
    p_correlation_id, p_operation_id::text, 'finalize',
    jsonb_build_object(
      'kind', 'operation',
      'reasonCode', v_operation.interruption_reason_code,
      'summary', jsonb_build_object(
        'selected', v_operation.selected_count, 'successful', v_operation.successful_count,
        'failed', v_operation.failed_count, 'conflicted', v_operation.conflicted_count,
        'partiallyApplied', v_operation.partially_applied_count,
        'notProcessed', v_operation.not_processed_count
      )
    )
  );
  return jsonb_build_object('disposition', 'applied', 'operation', to_jsonb(v_operation));
end;
$$;

create function public.fail_bulk_operation_launch(
  p_portal_id text,
  p_operation_id uuid,
  p_correlation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation public.bulk_operation;
begin
  select * into v_operation from public.bulk_operation
  where id = p_operation_id and portal_id = p_portal_id for update;
  if not found then
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_UNAVAILABLE');
  end if;
  if v_operation.status = 'launch_failed' then
    return jsonb_build_object('disposition', 'already_applied', 'operation', to_jsonb(v_operation));
  end if;
  if v_operation.cancel_requested_at is not null or v_operation.interruption_requested_at is not null then
    return jsonb_build_object('disposition', 'already_applied', 'operation', to_jsonb(v_operation));
  end if;
  if v_operation.status <> 'launching' then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'OPERATION_LAUNCH_FAILURE_REJECTED'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_LAUNCH_FAILURE_REJECTED');
  end if;

  perform public.set_bulk_operation_state_machine_context();
  update public.bulk_operation
  set status = 'launch_failed', completed_at = now()
  where id = p_operation_id
  returning * into v_operation;
  perform public.append_audit_event(
    p_portal_id, now(), 'operation_start', 'system', null, 'Система', 'queue',
    'operation', p_operation_id::text, 'Массовая операция', '[]'::jsonb, 'failure',
    p_correlation_id, p_operation_id::text, 'launch-failed',
    jsonb_build_object('kind', 'operation', 'reasonCode', 'LAUNCH_FAILED', 'summary', null)
  );
  return jsonb_build_object('disposition', 'applied', 'operation', to_jsonb(v_operation));
end;
$$;

drop function public.transition_bulk_operation_status(text, uuid, text[], text, boolean, boolean, boolean);

revoke insert, update on table public.bulk_operation from service_role;
revoke insert, update on table public.task_processing_result from service_role;
revoke insert, update on table public.protected_task_result from service_role;

revoke all on function public.operation_request_fingerprint(
  text, uuid, jsonb, text[], jsonb, jsonb, integer, integer, integer, integer
) from public, anon, authenticated;
revoke all on function public.append_operation_state_error(text, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.set_bulk_operation_state_machine_context()
  from public, anon, authenticated;

revoke all on function public.create_bulk_operation_idempotent(
  text, text, text, text, uuid, text, jsonb, text[], jsonb, jsonb, integer, integer, integer,
  integer, text, jsonb
) from public, anon, authenticated;
revoke all on function public.start_bulk_operation(text, uuid, text) from public, anon, authenticated;
revoke all on function public.request_bulk_operation_stop(text, uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.finalize_bulk_operation(text, uuid, text) from public, anon, authenticated;
revoke all on function public.fail_bulk_operation_launch(text, uuid, text) from public, anon, authenticated;

grant execute on function public.create_bulk_operation_idempotent(
  text, text, text, text, uuid, text, jsonb, text[], jsonb, jsonb, integer, integer, integer,
  integer, text, jsonb
) to service_role;
grant execute on function public.start_bulk_operation(text, uuid, text) to service_role;
grant execute on function public.request_bulk_operation_stop(text, uuid, text, text, text, text)
  to service_role;
grant execute on function public.finalize_bulk_operation(text, uuid, text) to service_role;
grant execute on function public.fail_bulk_operation_launch(text, uuid, text) to service_role;

commit;
