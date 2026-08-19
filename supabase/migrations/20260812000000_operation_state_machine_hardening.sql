begin;

alter table public.bulk_operation
  add column state_version bigint not null default 1,
  add column launch_attempt integer not null default 1,
  add column unconfirmed_count integer not null default 0,
  add constraint bulk_operation_state_version_positive check (state_version > 0),
  add constraint bulk_operation_launch_attempt_positive check (launch_attempt > 0);

alter table public.bulk_operation
  drop constraint bulk_operation_nonnegative_counts,
  drop constraint bulk_operation_summary_bounds,
  add constraint bulk_operation_nonnegative_counts check (
    selected_count >= 0
    and eligible_count >= 0
    and excluded_count >= 0
    and unchanged_count >= 0
    and successful_count >= 0
    and failed_count >= 0
    and unconfirmed_count >= 0
    and conflicted_count >= 0
    and partially_applied_count >= 0
    and not_processed_count >= 0
  ),
  add constraint bulk_operation_summary_bounds check (
    eligible_count + excluded_count + unchanged_count <= selected_count
    and successful_count + failed_count + unconfirmed_count + conflicted_count
      + partially_applied_count + not_processed_count <= eligible_count
  );

alter table public.task_processing_result
  drop constraint task_processing_result_outcome_allowed,
  add column result_fingerprint text not null default repeat('0', 64),
  add constraint task_processing_result_outcome_allowed check (
    outcome in (
      'success', 'error', 'unconfirmed', 'conflict', 'excluded_by_preflight', 'not_processed',
      'restored', 'restore_error', 'no_change', 'partially_applied'
    )
  ),
  add constraint task_processing_result_fingerprint_format
    check (result_fingerprint ~ '^[0-9a-f]{64}$');

create function public.task_processing_result_fingerprint(
  p_outcome text,
  p_task_title text,
  p_task_url text,
  p_requested_field_ids text[],
  p_applied_field_ids text[],
  p_failed_field_ids text[],
  p_reason_code text,
  p_reason_message text,
  p_can_retry boolean,
  p_before_version text,
  p_after_version text
)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select encode(
    extensions.digest(
      jsonb_build_object(
        'outcome', p_outcome,
        'taskTitle', p_task_title,
        'taskUrl', p_task_url,
        'requestedFieldIds', p_requested_field_ids,
        'appliedFieldIds', p_applied_field_ids,
        'failedFieldIds', p_failed_field_ids,
        'reasonCode', p_reason_code,
        'reasonMessage', p_reason_message,
        'canRetry', p_can_retry,
        'beforeVersion', p_before_version,
        'afterVersion', p_after_version
      )::text,
      'sha256'
    ),
    'hex'
  );
$$;

update public.task_processing_result as result
set result_fingerprint = public.task_processing_result_fingerprint(
  result.outcome,
  result.task_title,
  result.task_url,
  result.requested_field_ids,
  result.applied_field_ids,
  result.failed_field_ids,
  result.reason_code,
  result.reason_message,
  result.can_retry,
  (select before_version from public.protected_task_result where task_processing_result_id = result.id),
  (select after_version from public.protected_task_result where task_processing_result_id = result.id)
)
where exists (
  select 1 from public.protected_task_result where task_processing_result_id = result.id
);

update public.task_processing_result
set result_fingerprint = public.task_processing_result_fingerprint(
  outcome,
  task_title,
  task_url,
  requested_field_ids,
  applied_field_ids,
  failed_field_ids,
  reason_code,
  reason_message,
  can_retry,
  null,
  null
)
where result_fingerprint = repeat('0', 64);

create function public.operation_request_fingerprint_with_initial_results(
  p_operation_type text,
  p_source_operation_id uuid,
  p_filter_snapshot jsonb,
  p_selected_task_ids text[],
  p_changes jsonb,
  p_preflight_snapshot jsonb,
  p_selected_count integer,
  p_eligible_count integer,
  p_excluded_count integer,
  p_unchanged_count integer,
  p_initial_results jsonb
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
        'unchanged', p_unchanged_count,
        'initialResults', coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'taskId', entry->>'taskId',
                'title', entry->>'title',
                'taskUrl', entry->>'taskUrl',
                'outcome', entry->>'outcome',
                'requestedFieldIds', coalesce(entry->'requestedFieldIds', '[]'::jsonb),
                'reasonCode', entry->>'reasonCode',
                'reasonMessage', entry->>'reasonMessage'
              ) order by array_position(p_selected_task_ids, entry->>'taskId')
            )
            from jsonb_array_elements(p_initial_results) as entry
          ),
          '[]'::jsonb
        )
      )::text,
      'sha256'
    ),
    'hex'
  );
$$;

update public.bulk_operation as operation
set request_fingerprint = public.operation_request_fingerprint_with_initial_results(
  operation.operation_type,
  operation.source_operation_id,
  operation.filter_snapshot,
  operation.selected_task_ids,
  operation.changes,
  operation.preflight_snapshot,
  operation.selected_count,
  operation.eligible_count,
  operation.excluded_count,
  operation.unchanged_count,
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'taskId', result.task_id,
          'title', result.task_title,
          'taskUrl', result.task_url,
          'outcome', result.outcome,
          'requestedFieldIds', to_jsonb(result.requested_field_ids),
          'reasonCode', result.reason_code,
          'reasonMessage', result.reason_message
        ) order by array_position(operation.selected_task_ids, result.task_id)
      )
      from public.task_processing_result as result
      where result.operation_id = operation.id
        and result.outcome in ('excluded_by_preflight', 'no_change')
    ),
    '[]'::jsonb
  )
);

create table public.task_result_refinement (
  id uuid primary key default gen_random_uuid(),
  source_task_processing_result_id uuid not null unique,
  outcome text not null,
  applied_field_ids text[] not null default '{}'::text[],
  failed_field_ids text[] not null default '{}'::text[],
  reason_code text,
  reason_message text,
  can_retry boolean not null default false,
  result_fingerprint text not null,
  before_version text,
  after_version text,
  created_at timestamptz not null default now(),
  foreign key (source_task_processing_result_id)
    references public.task_processing_result (id) on delete restrict,
  constraint task_result_refinement_outcome_allowed check (
    outcome in ('success', 'error', 'conflict', 'restored', 'restore_error', 'partially_applied')
  ),
  constraint task_result_refinement_field_limits check (
    cardinality(applied_field_ids) <= 256 and cardinality(failed_field_ids) <= 256
  ),
  constraint task_result_refinement_reason_code_format check (
    reason_code is null or (reason_code = btrim(reason_code) and char_length(reason_code) between 1 and 128)
  ),
  constraint task_result_refinement_reason_message_format check (
    reason_message is null
    or (reason_message = btrim(reason_message) and char_length(reason_message) between 1 and 512)
  ),
  constraint task_result_refinement_fingerprint_format check (
    result_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint task_result_refinement_versions_pair check (
    (before_version is null) = (after_version is null)
  ),
  constraint task_result_refinement_before_version_format check (
    before_version is null
    or (before_version = btrim(before_version) and char_length(before_version) between 1 and 256)
  ),
  constraint task_result_refinement_after_version_format check (
    after_version is null
    or (after_version = btrim(after_version) and char_length(after_version) between 1 and 256)
  )
);

create function public.task_result_refinement_fingerprint(
  p_outcome text,
  p_applied_field_ids text[],
  p_failed_field_ids text[],
  p_reason_code text,
  p_reason_message text,
  p_can_retry boolean,
  p_before_version text,
  p_after_version text
)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select encode(
    extensions.digest(
      jsonb_build_object(
        'outcome', p_outcome,
        'appliedFieldIds', p_applied_field_ids,
        'failedFieldIds', p_failed_field_ids,
        'reasonCode', p_reason_code,
        'reasonMessage', p_reason_message,
        'canRetry', p_can_retry,
        'beforeVersion', p_before_version,
        'afterVersion', p_after_version
      )::text,
      'sha256'
    ),
    'hex'
  );
$$;

create function public.prevent_task_processing_result_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('task_commander.integration_cleanup', true) = 'enabled' then
      return old;
    end if;
    raise exception 'Task processing results are immutable.' using errcode = '23514';
  end if;
  if new.id is distinct from old.id
    or new.operation_id is distinct from old.operation_id
    or new.task_id is distinct from old.task_id
    or new.task_title is distinct from old.task_title
    or new.task_url is distinct from old.task_url
    or new.outcome is distinct from old.outcome
    or new.requested_field_ids is distinct from old.requested_field_ids
    or new.applied_field_ids is distinct from old.applied_field_ids
    or new.failed_field_ids is distinct from old.failed_field_ids
    or new.reason_code is distinct from old.reason_code
    or new.reason_message is distinct from old.reason_message
    or new.correlation_id is distinct from old.correlation_id
    or new.can_retry is distinct from old.can_retry
    or new.result_fingerprint is distinct from old.result_fingerprint
    or new.created_at is distinct from old.created_at
    or new.updated_at is distinct from old.updated_at then
    raise exception 'Task processing results are immutable.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function public.prevent_task_result_refinement_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('task_commander.integration_cleanup', true) = 'enabled'
      or (
        current_setting('task_commander.audit_retention', true) = 'enabled'
        and old.occurred_at < now() - interval '2 years'
      ) then
      return old;
    end if;
  end if;
  raise exception 'Task result refinements are append-only.' using errcode = '23514';
end;
$$;

create or replace function public.prevent_audit_event_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE'
    and current_setting('task_commander.integration_cleanup', true) = 'enabled' then
    return old;
  end if;
  raise exception 'Audit events are append-only.' using errcode = '23514';
end;
$$;

create trigger z_task_processing_result_prevent_mutation
before update or delete on public.task_processing_result
for each row execute function public.prevent_task_processing_result_mutation();

create trigger task_result_refinement_prevent_update
before update on public.task_result_refinement
for each row execute function public.prevent_task_result_refinement_mutation();

create trigger task_result_refinement_prevent_delete
before delete on public.task_result_refinement
for each row execute function public.prevent_task_result_refinement_mutation();

alter table public.task_result_refinement enable row level security;

create or replace function public.create_bulk_operation_idempotent(
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
    or p_selected_count <> cardinality(array(select distinct unnest(p_selected_task_ids)))
    or exists (
      select 1 from unnest(p_selected_task_ids) as selected_task_id
      where selected_task_id is null
        or selected_task_id !~ '^[0-9]+$'
        or char_length(selected_task_id) not between 1 and 32
    ) then
    perform public.append_operation_state_error(
      p_portal_id, null, p_correlation_id, 'OPERATION_REQUEST_INVALID'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_REQUEST_INVALID');
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
  if exists (
    select 1 from jsonb_array_elements(p_initial_results) as entry
    where jsonb_typeof(entry) <> 'object'
      or entry->>'taskId' is null
      or not ((entry->>'taskId') = any(p_selected_task_ids))
      or entry->>'outcome' not in ('excluded_by_preflight', 'no_change')
      or jsonb_typeof(coalesce(entry->'requestedFieldIds', '[]'::jsonb)) <> 'array'
  )
    or v_initial_count <> (
      select count(distinct entry->>'taskId') from jsonb_array_elements(p_initial_results) as entry
    )
    or p_excluded_count <> (
      select count(*) from jsonb_array_elements(p_initial_results) as entry
      where entry->>'outcome' = 'excluded_by_preflight'
    )
    or p_unchanged_count <> (
      select count(*) from jsonb_array_elements(p_initial_results) as entry
      where entry->>'outcome' = 'no_change'
    ) then
    perform public.append_operation_state_error(
      p_portal_id, null, p_correlation_id, 'INITIAL_RESULTS_INVALID'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'INITIAL_RESULTS_INVALID');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_portal_id || chr(31) || p_initiator_id, 0));
  v_fingerprint := public.operation_request_fingerprint_with_initial_results(
    p_operation_type, p_source_operation_id, p_filter_snapshot, p_selected_task_ids, p_changes,
    p_preflight_snapshot, p_selected_count, p_eligible_count, p_excluded_count, p_unchanged_count,
    p_initial_results
  );
  select * into v_existing from public.bulk_operation
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

  select * into v_active from public.bulk_operation
  where portal_id = p_portal_id
    and initiator_id = p_initiator_id
    and status in ('launching', 'running')
  order by created_at desc
  limit 1;
  if found then
    return jsonb_build_object('disposition', 'active_operation', 'operation', to_jsonb(v_active));
  end if;

  insert into public.bulk_operation (
    portal_id, operation_type, status, initiator_id, initiator_display_name, source_operation_id,
    idempotency_key, request_fingerprint, filter_snapshot, selected_task_ids, changes,
    preflight_snapshot, selected_count, eligible_count, excluded_count, unchanged_count, completed_at
  ) values (
    p_portal_id, p_operation_type,
    case when p_eligible_count = 0 then 'completed' else 'launching' end,
    p_initiator_id, p_initiator_display_name, p_source_operation_id, p_idempotency_key,
    v_fingerprint, p_filter_snapshot, p_selected_task_ids, p_changes, p_preflight_snapshot,
    p_selected_count, p_eligible_count, p_excluded_count, p_unchanged_count,
    case when p_eligible_count = 0 then now() else null end
  ) returning * into v_created;

  if v_initial_count > 0 then
    insert into public.task_processing_result (
      operation_id, task_id, task_title, task_url, outcome, requested_field_ids,
      applied_field_ids, failed_field_ids, reason_code, reason_message, correlation_id, can_retry,
      result_fingerprint
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
      false,
      public.task_processing_result_fingerprint(
        entry->>'outcome',
        entry->>'title',
        entry->>'taskUrl',
        coalesce(array(select jsonb_array_elements_text(entry->'requestedFieldIds')), '{}'::text[]),
        '{}'::text[],
        '{}'::text[],
        entry->>'reasonCode',
        entry->>'reasonMessage',
        false,
        null,
        null
      )
    from jsonb_array_elements(p_initial_results) as entry;
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
        'kind', 'operation',
        'reasonCode', null,
        'summary', jsonb_build_object(
          'selected', p_selected_count,
          'successful', 0,
          'failed', 0,
          'unconfirmed', 0,
          'conflicted', 0,
          'partiallyApplied', 0,
          'notProcessed', 0
        )
      )
    );
  end if;
  return jsonb_build_object('disposition', 'created', 'operation', to_jsonb(v_created));
end;
$$;

drop function public.start_bulk_operation(text, uuid, text);

create function public.start_bulk_operation_with_attempt(
  p_portal_id text,
  p_operation_id uuid,
  p_expected_launch_attempt integer,
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
  if v_operation.launch_attempt <> p_expected_launch_attempt then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'OPERATION_LAUNCH_ATTEMPT_STALE'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_LAUNCH_ATTEMPT_STALE');
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
  set
    status = 'running',
    started_at = coalesce(started_at, now()),
    last_progress_at = now(),
    state_version = state_version + 1
  where id = p_operation_id
  returning * into v_operation;
  perform public.append_audit_event(
    p_portal_id, now(), 'operation_start', 'system', null, 'Система', 'queue',
    'operation', p_operation_id::text, 'Массовая операция', '[]'::jsonb, 'success',
    p_correlation_id, p_operation_id::text, 'start:' || v_operation.launch_attempt::text,
    jsonb_build_object('kind', 'operation', 'reasonCode', null, 'summary', null)
  );
  return jsonb_build_object('disposition', 'applied', 'operation', to_jsonb(v_operation));
end;
$$;

create or replace function public.request_bulk_operation_stop(
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
  v_action text;
  v_outcome text;
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

  if v_operation.status = 'launching' then
    insert into public.task_processing_result (
      operation_id, task_id, outcome, requested_field_ids, applied_field_ids, failed_field_ids,
      reason_code, reason_message, correlation_id, can_retry, result_fingerprint
    )
    select
      p_operation_id,
      selected_task_id,
      'not_processed',
      '{}'::text[],
      '{}'::text[],
      '{}'::text[],
      case when p_stop_kind = 'cancel' then 'CANCELLED' else p_reason_code end,
      case when p_stop_kind = 'cancel' then 'Операция остановлена до обработки задачи.' else p_reason_message end,
      null,
      true,
      public.task_processing_result_fingerprint(
        'not_processed', null, null, '{}'::text[], '{}'::text[], '{}'::text[],
        case when p_stop_kind = 'cancel' then 'CANCELLED' else p_reason_code end,
        case when p_stop_kind = 'cancel' then 'Операция остановлена до обработки задачи.' else p_reason_message end,
        true, null, null
      )
    from unnest(v_operation.selected_task_ids) as selected_task_id
    left join public.task_processing_result existing_result
      on existing_result.operation_id = p_operation_id and existing_result.task_id = selected_task_id
    where existing_result.id is null;

    perform public.set_bulk_operation_state_machine_context();
    update public.bulk_operation
    set
      status = case when p_stop_kind = 'cancel' then 'cancelled' else 'interrupted' end,
      cancel_requested_at = case when p_stop_kind = 'cancel' then now() else null end,
      interruption_requested_at = case when p_stop_kind = 'interrupt' then now() else null end,
      interruption_reason_code = case when p_stop_kind = 'interrupt' then p_reason_code else null end,
      interruption_reason_message = case when p_stop_kind = 'interrupt' then p_reason_message else null end,
      successful_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome in ('success', 'restored')),
      failed_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome in ('error', 'restore_error')),
      unconfirmed_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'unconfirmed'),
      conflicted_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'conflict'),
      partially_applied_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'partially_applied'),
      not_processed_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'not_processed'),
      last_progress_at = now(),
      completed_at = now(),
      state_version = state_version + 1
    where id = p_operation_id
    returning * into v_operation;

    v_action := case when p_stop_kind = 'cancel' then 'operation_cancel' else 'operation_interrupt' end;
    v_outcome := case when p_stop_kind = 'cancel' then 'success' else 'failure' end;
    perform public.append_audit_event(
      p_portal_id, now(), v_action, 'system', null, 'Система', 'queue',
      'operation', p_operation_id::text, 'Массовая операция', '[]'::jsonb, v_outcome,
      p_correlation_id, p_operation_id::text, 'stop-before-start',
      jsonb_build_object(
        'kind', 'operation',
        'reasonCode', v_operation.interruption_reason_code,
        'summary', jsonb_build_object(
          'selected', v_operation.selected_count, 'successful', v_operation.successful_count,
          'failed', v_operation.failed_count, 'unconfirmed', v_operation.unconfirmed_count,
          'conflicted', v_operation.conflicted_count, 'partiallyApplied', v_operation.partially_applied_count,
          'notProcessed', v_operation.not_processed_count
        )
      )
    );
    return jsonb_build_object('disposition', 'applied', 'operation', to_jsonb(v_operation));
  end if;

  update public.bulk_operation
  set
    cancel_requested_at = case when p_stop_kind = 'cancel' then now() else null end,
    interruption_requested_at = case when p_stop_kind = 'interrupt' then now() else null end,
    interruption_reason_code = case when p_stop_kind = 'interrupt' then p_reason_code else null end,
    interruption_reason_message = case when p_stop_kind = 'interrupt' then p_reason_message else null end,
    state_version = state_version + 1
  where id = p_operation_id
  returning * into v_operation;

  return jsonb_build_object('disposition', 'applied', 'operation', to_jsonb(v_operation));
end;
$$;

create function public.request_bulk_operation_cancellation(
  p_portal_id text,
  p_operation_id uuid,
  p_correlation_id text
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.request_bulk_operation_stop(
    p_portal_id, p_operation_id, 'cancel', null, null, p_correlation_id
  );
$$;

create function public.request_bulk_operation_interruption_with_attempt(
  p_portal_id text,
  p_operation_id uuid,
  p_expected_launch_attempt integer,
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
  if v_operation.launch_attempt <> p_expected_launch_attempt then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'OPERATION_LAUNCH_ATTEMPT_STALE'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_LAUNCH_ATTEMPT_STALE');
  end if;
  return public.request_bulk_operation_stop(
    p_portal_id, p_operation_id, 'interrupt', p_reason_code, p_reason_message, p_correlation_id
  );
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
  v_fingerprint text;
begin
  has_protected_payload := p_protected_ciphertext is not null;
  if has_protected_payload <> (
    p_protected_nonce is not null and p_protected_key_version is not null
    and p_protected_payload_version is not null and p_before_version is not null
    and p_after_version is not null
  ) then
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'PROTECTED_RESULT_PAYLOAD_INVALID');
  end if;
  if cardinality(p_requested_field_ids) <> cardinality(array(select distinct unnest(p_requested_field_ids)))
    or cardinality(p_applied_field_ids) <> cardinality(array(select distinct unnest(p_applied_field_ids)))
    or cardinality(p_failed_field_ids) <> cardinality(array(select distinct unnest(p_failed_field_ids)))
    or exists (select 1 from unnest(p_applied_field_ids) as field_id where not field_id = any(p_requested_field_ids))
    or exists (select 1 from unnest(p_failed_field_ids) as field_id where not field_id = any(p_requested_field_ids))
    or exists (select 1 from unnest(p_applied_field_ids) as field_id where field_id = any(p_failed_field_ids)) then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, coalesce(p_correlation_id, 'TC-00000000-0000-4000-8000-000000000000'),
      'TASK_RESULT_FIELDS_INVALID'
    );
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'TASK_RESULT_FIELDS_INVALID');
  end if;
  if p_outcome = 'unconfirmed' and p_can_retry then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, coalesce(p_correlation_id, 'TC-00000000-0000-4000-8000-000000000000'),
      'UNCONFIRMED_RESULT_RETRY_FORBIDDEN'
    );
    return jsonb_build_object(
      'inserted', false,
      'rejected', true,
      'reasonCode', 'UNCONFIRMED_RESULT_RETRY_FORBIDDEN'
    );
  end if;

  select * into locked_operation from public.bulk_operation
  where id = p_operation_id and portal_id = p_portal_id for update;
  if not found then
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'OPERATION_UNAVAILABLE');
  end if;

  v_fingerprint := public.task_processing_result_fingerprint(
    p_outcome, p_task_title, p_task_url, p_requested_field_ids, p_applied_field_ids, p_failed_field_ids,
    p_reason_code, p_reason_message, p_can_retry, p_before_version, p_after_version
  );
  select * into existing_result from public.task_processing_result
  where operation_id = p_operation_id and task_id = p_task_id;
  if found then
    if existing_result.result_fingerprint = v_fingerprint then
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
        'unconfirmed', locked_operation.unconfirmed_count, 'conflicted', locked_operation.conflicted_count,
        'partiallyApplied', locked_operation.partially_applied_count,
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
    or p_outcome not in ('success', 'error', 'unconfirmed', 'conflict', 'restored', 'restore_error', 'partially_applied') then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, coalesce(p_correlation_id, 'TC-00000000-0000-4000-8000-000000000000'),
      'TASK_RESULT_REJECTED'
    );
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'TASK_RESULT_REJECTED');
  end if;

  insert into public.task_processing_result (
    operation_id, task_id, task_title, task_url, outcome, requested_field_ids, applied_field_ids,
    failed_field_ids, reason_code, reason_message, correlation_id, can_retry, result_fingerprint
  ) values (
    p_operation_id, p_task_id, p_task_title, p_task_url, p_outcome, p_requested_field_ids,
    p_applied_field_ids, p_failed_field_ids, p_reason_code, p_reason_message, p_correlation_id,
    p_can_retry, v_fingerprint
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
    unconfirmed_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'unconfirmed'),
    conflicted_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'conflict'),
    partially_applied_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'partially_applied'),
    not_processed_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'not_processed'),
    last_progress_at = now(),
    state_version = state_version + 1
  where id = p_operation_id and portal_id = p_portal_id
  returning * into updated_operation;

  return jsonb_build_object('inserted', true, 'result', to_jsonb(inserted_result), 'summary', jsonb_build_object(
    'successful', updated_operation.successful_count, 'failed', updated_operation.failed_count,
    'unconfirmed', updated_operation.unconfirmed_count, 'conflicted', updated_operation.conflicted_count,
    'partiallyApplied', updated_operation.partially_applied_count,
    'notProcessed', updated_operation.not_processed_count
  ));
end;
$$;

create function public.record_task_processing_result_with_attempt(
  p_portal_id text,
  p_operation_id uuid,
  p_expected_launch_attempt integer,
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
  v_operation public.bulk_operation;
begin
  select * into v_operation from public.bulk_operation
  where id = p_operation_id and portal_id = p_portal_id for update;
  if not found then
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'OPERATION_UNAVAILABLE');
  end if;
  if v_operation.launch_attempt <> p_expected_launch_attempt then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id,
      coalesce(p_correlation_id, 'TC-00000000-0000-4000-8000-000000000000'),
      'OPERATION_LAUNCH_ATTEMPT_STALE'
    );
    return jsonb_build_object(
      'inserted', false,
      'rejected', true,
      'reasonCode', 'OPERATION_LAUNCH_ATTEMPT_STALE'
    );
  end if;
  return public.record_task_processing_result(
    p_portal_id, p_operation_id, p_task_id, p_task_title, p_task_url, p_outcome,
    p_requested_field_ids, p_applied_field_ids, p_failed_field_ids, p_reason_code,
    p_reason_message, p_correlation_id, p_can_retry, p_protected_ciphertext,
    p_protected_nonce, p_protected_key_version, p_protected_payload_version,
    p_before_version, p_after_version
  );
end;
$$;

create or replace function public.finalize_bulk_operation(
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
        applied_field_ids, failed_field_ids, reason_code, reason_message, correlation_id, can_retry,
        result_fingerprint
      )
      select
        p_operation_id, selected_task_id, null, null, 'not_processed', '{}'::text[],
        '{}'::text[], '{}'::text[],
        case when v_operation.cancel_requested_at is not null then 'CANCELLED' else v_operation.interruption_reason_code end,
        case when v_operation.cancel_requested_at is not null then 'Операция остановлена до обработки задачи.' else v_operation.interruption_reason_message end,
        null, true,
        public.task_processing_result_fingerprint(
          'not_processed', null, null, '{}'::text[], '{}'::text[], '{}'::text[],
          case when v_operation.cancel_requested_at is not null then 'CANCELLED' else v_operation.interruption_reason_code end,
          case when v_operation.cancel_requested_at is not null then 'Операция остановлена до обработки задачи.' else v_operation.interruption_reason_message end,
          true, null, null
        )
      from unnest(v_operation.selected_task_ids) as selected_task_id
      left join public.task_processing_result existing_result
        on existing_result.operation_id = p_operation_id and existing_result.task_id = selected_task_id
      where existing_result.id is null;

      update public.bulk_operation
      set
        successful_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome in ('success', 'restored')),
        failed_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome in ('error', 'restore_error')),
        unconfirmed_count = (select count(*) from public.task_processing_result where operation_id = p_operation_id and outcome = 'unconfirmed'),
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

    if v_operation.cancel_requested_at is not null then
      v_next_status := 'cancelled';
    elsif v_operation.interruption_requested_at is not null then
      v_next_status := 'interrupted';
    elsif v_operation.failed_count + v_operation.unconfirmed_count + v_operation.conflicted_count
      + v_operation.partially_applied_count > 0 then
      v_next_status := 'completed_with_errors';
    else
      v_next_status := 'completed';
    end if;

    perform public.set_bulk_operation_state_machine_context();
    update public.bulk_operation
    set status = v_next_status, completed_at = now(), state_version = state_version + 1
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
      'kind', 'operation', 'reasonCode', v_operation.interruption_reason_code,
      'summary', jsonb_build_object(
        'selected', v_operation.selected_count, 'successful', v_operation.successful_count,
        'failed', v_operation.failed_count, 'unconfirmed', v_operation.unconfirmed_count,
        'conflicted', v_operation.conflicted_count, 'partiallyApplied', v_operation.partially_applied_count,
        'notProcessed', v_operation.not_processed_count
      )
    )
  );
  return jsonb_build_object('disposition', 'applied', 'operation', to_jsonb(v_operation));
end;
$$;

create function public.finalize_bulk_operation_with_attempt(
  p_portal_id text,
  p_operation_id uuid,
  p_expected_launch_attempt integer,
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
  if v_operation.launch_attempt <> p_expected_launch_attempt then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'OPERATION_LAUNCH_ATTEMPT_STALE'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_LAUNCH_ATTEMPT_STALE');
  end if;
  return public.finalize_bulk_operation(p_portal_id, p_operation_id, p_correlation_id);
end;
$$;

drop function public.fail_bulk_operation_launch(text, uuid, text);

create function public.fail_bulk_operation_launch_with_attempt(
  p_portal_id text,
  p_operation_id uuid,
  p_expected_launch_attempt integer,
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
  if v_operation.launch_attempt <> p_expected_launch_attempt then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'OPERATION_LAUNCH_ATTEMPT_STALE'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_LAUNCH_ATTEMPT_STALE');
  end if;
  if v_operation.status = 'launch_failed'
    or v_operation.status in ('completed', 'completed_with_errors', 'cancelled', 'interrupted') then
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
  set status = 'launch_failed', completed_at = now(), state_version = state_version + 1
  where id = p_operation_id
  returning * into v_operation;
  perform public.append_audit_event(
    p_portal_id, now(), 'operation_start', 'system', null, 'Система', 'queue',
    'operation', p_operation_id::text, 'Массовая операция', '[]'::jsonb, 'failure',
    p_correlation_id, p_operation_id::text, 'launch-failed:' || v_operation.launch_attempt::text,
    jsonb_build_object('kind', 'operation', 'reasonCode', 'LAUNCH_FAILED', 'summary', null)
  );
  return jsonb_build_object('disposition', 'applied', 'operation', to_jsonb(v_operation));
end;
$$;

create function public.retry_bulk_operation_launch(
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
  v_initiator_id text;
begin
  select initiator_id into v_initiator_id from public.bulk_operation
  where id = p_operation_id and portal_id = p_portal_id;
  if not found then
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_UNAVAILABLE');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_portal_id || chr(31) || v_initiator_id, 0));
  select * into v_operation from public.bulk_operation
  where id = p_operation_id and portal_id = p_portal_id for update;
  if v_operation.status <> 'launch_failed' then
    if v_operation.status in ('launching', 'running') then
      return jsonb_build_object('disposition', 'already_applied', 'operation', to_jsonb(v_operation));
    end if;
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'OPERATION_LAUNCH_RETRY_REJECTED'
    );
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'OPERATION_LAUNCH_RETRY_REJECTED');
  end if;
  if exists (
    select 1 from public.bulk_operation
    where portal_id = p_portal_id
      and initiator_id = v_operation.initiator_id
      and id <> p_operation_id
      and status in ('launching', 'running')
  ) then
    return jsonb_build_object('disposition', 'rejected', 'reasonCode', 'ACTIVE_OPERATION');
  end if;

  perform public.set_bulk_operation_state_machine_context();
  update public.bulk_operation
  set
    status = 'launching',
    completed_at = null,
    launch_attempt = launch_attempt + 1,
    state_version = state_version + 1
  where id = p_operation_id
  returning * into v_operation;
  perform public.append_audit_event(
    p_portal_id, now(), 'operation_start', 'system', null, 'Система', 'queue',
    'operation', p_operation_id::text, 'Массовая операция', '[]'::jsonb, 'success',
    p_correlation_id, p_operation_id::text, 'launch-retry:' || v_operation.launch_attempt::text,
    jsonb_build_object('kind', 'operation', 'reasonCode', null, 'summary', null)
  );
  return jsonb_build_object('disposition', 'applied', 'operation', to_jsonb(v_operation));
end;
$$;

create function public.record_task_result_refinement_with_versions(
  p_portal_id text,
  p_operation_id uuid,
  p_task_id text,
  p_outcome text,
  p_applied_field_ids text[],
  p_failed_field_ids text[],
  p_reason_code text,
  p_reason_message text,
  p_correlation_id text,
  p_can_retry boolean,
  p_before_version text,
  p_after_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation public.bulk_operation;
  v_source public.task_processing_result;
  v_existing public.task_result_refinement;
  v_refinement public.task_result_refinement;
  v_fingerprint text;
begin
  if (p_before_version is null) <> (p_after_version is null) then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'TASK_RESULT_REFINEMENT_VERSIONS_INVALID'
    );
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'TASK_RESULT_REFINEMENT_VERSIONS_INVALID');
  end if;
  if p_before_version is not null and (
    p_before_version <> btrim(p_before_version)
    or char_length(p_before_version) not between 1 and 256
    or p_after_version <> btrim(p_after_version)
    or char_length(p_after_version) not between 1 and 256
  ) then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'TASK_RESULT_REFINEMENT_VERSIONS_INVALID'
    );
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'TASK_RESULT_REFINEMENT_VERSIONS_INVALID');
  end if;
  if cardinality(p_applied_field_ids) <> cardinality(array(select distinct unnest(p_applied_field_ids)))
    or cardinality(p_failed_field_ids) <> cardinality(array(select distinct unnest(p_failed_field_ids)))
    or exists (select 1 from unnest(p_applied_field_ids) as field_id where field_id = any(p_failed_field_ids)) then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'TASK_RESULT_REFINEMENT_FIELDS_INVALID'
    );
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'TASK_RESULT_REFINEMENT_FIELDS_INVALID');
  end if;
  select * into v_operation from public.bulk_operation
  where id = p_operation_id and portal_id = p_portal_id for update;
  if not found then
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'OPERATION_UNAVAILABLE');
  end if;
  select * into v_source from public.task_processing_result
  where operation_id = p_operation_id and task_id = p_task_id for update;
  if not found or v_source.outcome <> 'unconfirmed' then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'TASK_RESULT_REFINEMENT_REJECTED'
    );
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'TASK_RESULT_REFINEMENT_REJECTED');
  end if;
  if v_operation.status not in ('completed', 'completed_with_errors', 'cancelled', 'interrupted') then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'TASK_RESULT_REFINEMENT_REJECTED'
    );
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'TASK_RESULT_REFINEMENT_REJECTED');
  end if;
  if p_outcome not in ('success', 'error', 'conflict', 'restored', 'restore_error', 'partially_applied') then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'TASK_RESULT_REFINEMENT_REJECTED'
    );
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'TASK_RESULT_REFINEMENT_REJECTED');
  end if;
  if exists (
    select 1 from unnest(p_applied_field_ids || p_failed_field_ids) as field_id
    where not field_id = any(v_source.requested_field_ids)
  ) then
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'TASK_RESULT_REFINEMENT_FIELDS_INVALID'
    );
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'TASK_RESULT_REFINEMENT_FIELDS_INVALID');
  end if;

  v_fingerprint := public.task_result_refinement_fingerprint(
    p_outcome, p_applied_field_ids, p_failed_field_ids, p_reason_code, p_reason_message, p_can_retry,
    p_before_version, p_after_version
  );
  select * into v_existing from public.task_result_refinement
  where source_task_processing_result_id = v_source.id;
  if found then
    if v_existing.result_fingerprint = v_fingerprint then
      return jsonb_build_object('inserted', false, 'refinement', to_jsonb(v_existing));
    end if;
    perform public.append_operation_state_error(
      p_portal_id, p_operation_id, p_correlation_id, 'TASK_RESULT_REFINEMENT_CONFLICT'
    );
    return jsonb_build_object('inserted', false, 'rejected', true, 'reasonCode', 'TASK_RESULT_REFINEMENT_CONFLICT');
  end if;

  insert into public.task_result_refinement (
    source_task_processing_result_id, outcome, applied_field_ids, failed_field_ids,
    reason_code, reason_message, can_retry, result_fingerprint, before_version, after_version
  ) values (
    v_source.id, p_outcome, p_applied_field_ids, p_failed_field_ids,
    p_reason_code, p_reason_message, p_can_retry, v_fingerprint, p_before_version, p_after_version
  ) returning * into v_refinement;
  update public.bulk_operation
  set state_version = state_version + 1, last_progress_at = now()
  where id = p_operation_id;
  perform public.append_audit_event(
    p_portal_id, now(), 'system_recovery', 'system', null, 'Система', 'recovery',
    'operation', p_operation_id::text, 'Массовая операция',
    jsonb_build_array(jsonb_build_object('type', 'operation_attempt', 'id', v_source.id::text, 'displayName', 'Уточнение результата задачи')),
    'success', p_correlation_id, v_source.id::text, 'result-refinement',
    jsonb_build_object('kind', 'system', 'component', 'operation-result-refinement', 'errorCode', 'TASK_RESULT_REFINED', 'retryable', false)
  );
  return jsonb_build_object('inserted', true, 'refinement', to_jsonb(v_refinement));
end;
$$;

create function public.record_task_result_refinement(
  p_portal_id text,
  p_operation_id uuid,
  p_task_id text,
  p_outcome text,
  p_applied_field_ids text[],
  p_failed_field_ids text[],
  p_reason_code text,
  p_reason_message text,
  p_correlation_id text,
  p_can_retry boolean
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.record_task_result_refinement_with_versions(
    p_portal_id, p_operation_id, p_task_id, p_outcome, p_applied_field_ids,
    p_failed_field_ids, p_reason_code, p_reason_message, p_correlation_id,
    p_can_retry, null, null
  );
$$;

create function public.purge_integration_test_fixture(p_portal_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_portal_id !~ '^integration-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or not exists (
      select 1 from public.portal
      where id = p_portal_id and display_name = 'Integration portal'
    )
    or exists (
      select 1 from public.user_settings
      where portal_id = p_portal_id
        and user_id not in ('900000000001', '900000000002')
    ) then
    raise exception 'Integration fixture cleanup scope is invalid.' using errcode = '22023';
  end if;

  perform set_config('task_commander.integration_cleanup', 'enabled', true);
  delete from public.report_artifact as artifact
  using public.report as report, public.bulk_operation as operation
  where artifact.report_id = report.id
    and report.operation_id = operation.id
    and operation.portal_id = p_portal_id;
  delete from public.report as report
  using public.bulk_operation as operation
  where report.operation_id = operation.id and operation.portal_id = p_portal_id;
  delete from public.task_result_refinement as refinement
  using public.task_processing_result as result, public.bulk_operation as operation
  where refinement.source_task_processing_result_id = result.id
    and result.operation_id = operation.id
    and operation.portal_id = p_portal_id;
  delete from public.protected_task_result as protected
  using public.task_processing_result as result, public.bulk_operation as operation
  where protected.task_processing_result_id = result.id
    and result.operation_id = operation.id
    and operation.portal_id = p_portal_id;
  delete from public.task_processing_result as result
  using public.bulk_operation as operation
  where result.operation_id = operation.id and operation.portal_id = p_portal_id;
  delete from public.audit_event where portal_id = p_portal_id;
  delete from public.bulk_operation where portal_id = p_portal_id;
  delete from public.operation_draft where portal_id = p_portal_id;
  delete from public.saved_filter where portal_id = p_portal_id;
  delete from public.user_settings where portal_id = p_portal_id;
  delete from public.portal where id = p_portal_id;
end;
$$;

revoke all on function public.task_processing_result_fingerprint(
  text, text, text, text[], text[], text[], text, text, boolean, text, text
) from public, anon, authenticated;
revoke all on function public.operation_request_fingerprint_with_initial_results(
  text, uuid, jsonb, text[], jsonb, jsonb, integer, integer, integer, integer, jsonb
) from public, anon, authenticated;
revoke all on function public.task_result_refinement_fingerprint(
  text, text[], text[], text, text, boolean, text, text
) from public, anon, authenticated;
revoke all on function public.prevent_task_processing_result_mutation() from public, anon, authenticated;
revoke all on function public.prevent_task_result_refinement_mutation() from public, anon, authenticated;
revoke all on function public.start_bulk_operation_with_attempt(text, uuid, integer, text)
  from public, anon, authenticated;
revoke all on function public.request_bulk_operation_cancellation(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.request_bulk_operation_interruption_with_attempt(
  text, uuid, integer, text, text, text
) from public, anon, authenticated;
revoke all on function public.request_bulk_operation_stop(text, uuid, text, text, text, text)
  from service_role;
revoke all on function public.record_task_processing_result_with_attempt(
  text, uuid, integer, text, text, text, text, text[], text[], text[], text, text, text,
  boolean, bytea, bytea, text, smallint, text, text
) from public, anon, authenticated;
revoke all on function public.record_task_processing_result(
  text, uuid, text, text, text, text, text[], text[], text[], text, text, text, boolean,
  bytea, bytea, text, smallint, text, text
) from service_role;
revoke all on function public.fail_bulk_operation_launch_with_attempt(text, uuid, integer, text)
  from public, anon, authenticated;
revoke all on function public.finalize_bulk_operation_with_attempt(text, uuid, integer, text)
  from public, anon, authenticated;
revoke all on function public.finalize_bulk_operation(text, uuid, text) from service_role;
revoke all on function public.retry_bulk_operation_launch(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.record_task_result_refinement(
  text, uuid, text, text, text[], text[], text, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.record_task_result_refinement_with_versions(
  text, uuid, text, text, text[], text[], text, text, text, boolean, text, text
) from public, anon, authenticated;
revoke all on function public.purge_integration_test_fixture(text)
  from public, anon, authenticated;
revoke delete on table public.task_processing_result from service_role;
revoke delete on table public.protected_task_result from service_role;
revoke all on table public.task_result_refinement from anon, authenticated, service_role;

grant execute on function public.start_bulk_operation_with_attempt(text, uuid, integer, text)
  to service_role;
grant execute on function public.request_bulk_operation_cancellation(text, uuid, text)
  to service_role;
grant execute on function public.request_bulk_operation_interruption_with_attempt(
  text, uuid, integer, text, text, text
) to service_role;
grant execute on function public.record_task_processing_result_with_attempt(
  text, uuid, integer, text, text, text, text, text[], text[], text[], text, text, text,
  boolean, bytea, bytea, text, smallint, text, text
) to service_role;
grant execute on function public.fail_bulk_operation_launch_with_attempt(text, uuid, integer, text)
  to service_role;
grant execute on function public.finalize_bulk_operation_with_attempt(text, uuid, integer, text)
  to service_role;
grant execute on function public.retry_bulk_operation_launch(text, uuid, text) to service_role;
grant execute on function public.record_task_result_refinement(
  text, uuid, text, text, text[], text[], text, text, text, boolean
) to service_role;
grant execute on function public.record_task_result_refinement_with_versions(
  text, uuid, text, text, text[], text[], text, text, text, boolean, text, text
) to service_role;
grant execute on function public.purge_integration_test_fixture(text) to service_role;
grant select on table public.task_result_refinement to service_role;

commit;
