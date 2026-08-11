begin;

create function public.save_operation_draft(
  p_portal_id text,
  p_owner_id text,
  p_expected_revision integer,
  p_status text,
  p_filter_snapshot jsonb,
  p_sort_snapshot jsonb,
  p_selected_task_ids text[],
  p_changes jsonb,
  p_preflight_snapshot jsonb,
  p_replace_expired boolean default false
)
returns public.operation_draft
language plpgsql
security invoker
set search_path = public
as $$
declare
  existing_draft public.operation_draft;
  saved_draft public.operation_draft;
begin
  select *
  into existing_draft
  from public.operation_draft
  where portal_id = p_portal_id and owner_id = p_owner_id
  for update;

  if found and existing_draft.expires_at <= now() then
    if not p_replace_expired then
      raise exception 'TC_DRAFT_EXPIRED' using errcode = 'P0001';
    end if;

    delete from public.operation_draft where id = existing_draft.id;
    found := false;
  end if;

  if found then
    if existing_draft.revision <> p_expected_revision then
      raise exception 'TC_DRAFT_REVISION_CONFLICT' using errcode = 'P0001';
    end if;

    update public.operation_draft
    set
      revision = revision + 1,
      status = p_status,
      filter_snapshot = p_filter_snapshot,
      sort_snapshot = p_sort_snapshot,
      selected_task_ids = p_selected_task_ids,
      changes = p_changes,
      preflight_snapshot = p_preflight_snapshot
    where id = existing_draft.id
    returning * into saved_draft;

    return saved_draft;
  end if;

  if p_expected_revision <> 0 then
    raise exception 'TC_DRAFT_REVISION_CONFLICT' using errcode = 'P0001';
  end if;

  insert into public.operation_draft (
    portal_id,
    owner_id,
    status,
    filter_snapshot,
    sort_snapshot,
    selected_task_ids,
    changes,
    preflight_snapshot
  )
  values (
    p_portal_id,
    p_owner_id,
    p_status,
    p_filter_snapshot,
    p_sort_snapshot,
    p_selected_task_ids,
    p_changes,
    p_preflight_snapshot
  )
  returning * into saved_draft;

  return saved_draft;
end;
$$;

create function public.transition_bulk_operation_status(
  p_portal_id text,
  p_operation_id uuid,
  p_expected_statuses text[],
  p_next_status text,
  p_mark_started boolean default false,
  p_touch_progress boolean default false,
  p_mark_completed boolean default false
)
returns public.bulk_operation
language plpgsql
security invoker
set search_path = public
as $$
declare
  transitioned_operation public.bulk_operation;
begin
  update public.bulk_operation
  set
    status = p_next_status,
    started_at = case when p_mark_started then coalesce(started_at, now()) else started_at end,
    last_progress_at = case when p_touch_progress then now() else last_progress_at end,
    completed_at = case when p_mark_completed then coalesce(completed_at, now()) else completed_at end
  where id = p_operation_id
    and portal_id = p_portal_id
    and status = any (p_expected_statuses)
  returning * into transitioned_operation;

  if not found then
    raise exception 'TC_OPERATION_TRANSITION_CONFLICT' using errcode = 'P0001';
  end if;

  return transitioned_operation;
end;
$$;

create function public.record_task_processing_result(
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
security invoker
set search_path = public
as $$
declare
  locked_operation public.bulk_operation;
  inserted_result public.task_processing_result;
  existing_result public.task_processing_result;
  updated_operation public.bulk_operation;
  has_protected_payload boolean;
begin
  has_protected_payload := p_protected_ciphertext is not null;

  if has_protected_payload <> (
    p_protected_nonce is not null
    and p_protected_key_version is not null
    and p_protected_payload_version is not null
    and p_before_version is not null
    and p_after_version is not null
  ) then
    raise exception 'TC_PROTECTED_RESULT_PAYLOAD_INVALID' using errcode = 'P0001';
  end if;

  select *
  into locked_operation
  from public.bulk_operation
  where id = p_operation_id and portal_id = p_portal_id
  for update;

  if not found then
    raise exception 'TC_OPERATION_UNAVAILABLE' using errcode = 'P0001';
  end if;

  insert into public.task_processing_result (
    operation_id,
    task_id,
    task_title,
    task_url,
    outcome,
    requested_field_ids,
    applied_field_ids,
    failed_field_ids,
    reason_code,
    reason_message,
    correlation_id,
    can_retry
  )
  values (
    p_operation_id,
    p_task_id,
    p_task_title,
    p_task_url,
    p_outcome,
    p_requested_field_ids,
    p_applied_field_ids,
    p_failed_field_ids,
    p_reason_code,
    p_reason_message,
    p_correlation_id,
    p_can_retry
  )
  on conflict (operation_id, task_id) do nothing
  returning * into inserted_result;

  if not found then
    select *
    into existing_result
    from public.task_processing_result
    where operation_id = p_operation_id and task_id = p_task_id;

    if existing_result.task_title is distinct from p_task_title
      or existing_result.task_url is distinct from p_task_url
      or existing_result.outcome is distinct from p_outcome
      or existing_result.requested_field_ids is distinct from p_requested_field_ids
      or existing_result.applied_field_ids is distinct from p_applied_field_ids
      or existing_result.failed_field_ids is distinct from p_failed_field_ids
      or existing_result.reason_code is distinct from p_reason_code
      or existing_result.reason_message is distinct from p_reason_message
      or existing_result.correlation_id is distinct from p_correlation_id
      or existing_result.can_retry is distinct from p_can_retry then
      raise exception 'TC_TASK_RESULT_CONFLICT' using errcode = 'P0001';
    end if;

    return jsonb_build_object(
      'inserted', false,
      'result', to_jsonb(existing_result),
      'summary', jsonb_build_object(
        'successful', locked_operation.successful_count,
        'failed', locked_operation.failed_count,
        'conflicted', locked_operation.conflicted_count,
        'partiallyApplied', locked_operation.partially_applied_count,
        'notProcessed', locked_operation.not_processed_count
      )
    );
  end if;

  if has_protected_payload then
    insert into public.protected_task_result (
      task_processing_result_id,
      ciphertext,
      nonce,
      key_version,
      payload_version,
      before_version,
      after_version
    )
    values (
      inserted_result.id,
      p_protected_ciphertext,
      p_protected_nonce,
      p_protected_key_version,
      p_protected_payload_version,
      p_before_version,
      p_after_version
    );
  end if;

  update public.bulk_operation
  set
    successful_count = successful_count + case
      when p_outcome in ('success', 'restored') then 1 else 0 end,
    failed_count = failed_count + case
      when p_outcome in ('error', 'restore_error') then 1 else 0 end,
    conflicted_count = conflicted_count + case
      when p_outcome = 'conflict' then 1 else 0 end,
    partially_applied_count = partially_applied_count + case
      when p_outcome = 'partially_applied' then 1 else 0 end,
    not_processed_count = not_processed_count + case
      when p_outcome = 'not_processed' then 1 else 0 end,
    last_progress_at = now()
  where id = p_operation_id and portal_id = p_portal_id
  returning * into updated_operation;

  return jsonb_build_object(
    'inserted', true,
    'result', to_jsonb(inserted_result),
    'summary', jsonb_build_object(
      'successful', updated_operation.successful_count,
      'failed', updated_operation.failed_count,
      'conflicted', updated_operation.conflicted_count,
      'partiallyApplied', updated_operation.partially_applied_count,
      'notProcessed', updated_operation.not_processed_count
    )
  );
end;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.set_draft_updated_at_and_expiry() from public, anon, authenticated;
revoke all on function public.prevent_bulk_operation_snapshot_change()
  from public, anon, authenticated;
revoke all on function public.prevent_task_processing_result_identity_change()
  from public, anon, authenticated;
revoke all on function public.prevent_audit_event_mutation() from public, anon, authenticated;

revoke all on function public.save_operation_draft(
  text, text, integer, text, jsonb, jsonb, text[], jsonb, jsonb, boolean
) from public, anon, authenticated;
revoke all on function public.transition_bulk_operation_status(
  text, uuid, text[], text, boolean, boolean, boolean
) from public, anon, authenticated;
revoke all on function public.record_task_processing_result(
  text, uuid, text, text, text, text, text[], text[], text[], text, text, text, boolean,
  bytea, bytea, text, smallint, text, text
) from public, anon, authenticated;

grant execute on function public.save_operation_draft(
  text, text, integer, text, jsonb, jsonb, text[], jsonb, jsonb, boolean
) to service_role;
grant execute on function public.transition_bulk_operation_status(
  text, uuid, text[], text, boolean, boolean, boolean
) to service_role;
grant execute on function public.record_task_processing_result(
  text, uuid, text, text, text, text, text[], text[], text[], text, text, text, boolean,
  bytea, bytea, text, smallint, text, text
) to service_role;

commit;
