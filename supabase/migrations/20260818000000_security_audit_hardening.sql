begin;

-- This migration deliberately rolls forward only: restoring the previous public grants or
-- destructive fixture RPC would weaken a production database.
revoke create on schema public from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- Existing functions already use qualified application objects. pg_catalog remains available for
-- built-ins while an empty path prevents objects supplied by a caller from being resolved.
do $$
declare
  function_name regprocedure;
begin
  for function_name in
    select p.oid::regprocedure
    from pg_proc as p
    join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    execute format('alter function %s set search_path = ''''', function_name);
  end loop;
end;
$$;

drop function if exists public.purge_integration_test_fixture(text);

alter table public.access_field_set
  add constraint access_field_set_member_count_limit check (member_count <= 256) not valid;

comment on constraint access_field_set_member_count_limit on public.access_field_set is
  'Enforced for new writes. Validate in a later roll-forward after legacy sets over 256 members are quarantined.';

alter table public.audit_event
  add constraint audit_event_code_allowlist check (
    (
      (action in (
        'operation_create', 'operation_start', 'operation_complete', 'operation_cancel',
        'operation_interrupt', 'operation_retry', 'operation_restore'
      ) and details ->> 'kind' = 'operation')
      or (action in (
        'access_grant', 'access_update', 'access_revoke', 'access_auto_revoke',
        'allowed_fields_update'
      ) and details ->> 'kind' = 'access')
      or (action in (
        'report_export', 'report_generate', 'report_store', 'report_download',
        'report_archive', 'report_delete'
      ) and details ->> 'kind' = 'report')
      or (action = 'audit_view' and details ->> 'kind' = 'audit_view')
      or (action = 'audit_retention' and details ->> 'kind' = 'retention')
      or (action in ('system_error', 'system_recovery') and details ->> 'kind' = 'system')
    )
    and (outcome <> 'partial' or action = 'operation_complete')
    and (action <> 'audit_view' or outcome = 'denied')
    and (
      action <> 'audit_retention'
      or (outcome = 'success' and actor_type = 'system' and actor_source = 'retention')
    )
    and (action <> 'system_error' or outcome = 'failure')
    and (action <> 'access_auto_revoke' or actor_type = 'system')
    and (outcome <> 'denied' or actor_type = 'user')
    and (
      action <> 'operation_complete'
      or outcome <> 'partial'
      or jsonb_typeof(details -> 'summary') = 'object'
    )
    and
    case details ->> 'kind'
      when 'operation' then
        details ->> 'reasonCode' is null or details ->> 'reasonCode' = any (array[
          'ACTIVE_OPERATION', 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'INITIAL_RESULTS_COUNT_MISMATCH',
          'INITIAL_RESULTS_INVALID', 'INTERRUPTED', 'LAUNCH_FAILED',
          'OPERATION_FINALIZATION_INCOMPLETE', 'OPERATION_FINALIZATION_REJECTED',
          'OPERATION_LAUNCH_ATTEMPT_STALE', 'OPERATION_LAUNCH_FAILURE_REJECTED',
          'OPERATION_LAUNCH_RETRY_REJECTED', 'OPERATION_REQUEST_INVALID',
          'OPERATION_START_REJECTED', 'OPERATION_UNAVAILABLE',
          'PROTECTED_RESULT_PAYLOAD_INVALID', 'STOP_KIND_INVALID', 'TASK_RESULT_CONFLICT',
          'TASK_RESULT_FIELDS_INVALID', 'TASK_RESULT_REFINEMENT_CONFLICT',
          'TASK_RESULT_REFINEMENT_FIELDS_INVALID', 'TASK_RESULT_REFINEMENT_REJECTED',
          'TASK_RESULT_REFINEMENT_VERSIONS_INVALID', 'TASK_RESULT_REJECTED',
          'UNCONFIRMED_RESULT_RETRY_FORBIDDEN', 'UPSTREAM_FAILURE', 'UPSTREAM_OUTCOME_UNKNOWN'
        ])
      when 'access' then
        details ->> 'reasonCode' is null or details ->> 'reasonCode' = any (array[
          'role_change', 'responsibility_change', 'security_policy', 'access_cleanup',
          'employee_request', 'other', 'EMPLOYEE_INACTIVE', 'EMPLOYEE_MISSING',
          'LEGACY_ACCESS_STATE_AMBIGUOUS', 'MANAGER_ROLE_LOST'
        ])
      when 'report' then
        details ->> 'errorCode' is null or details ->> 'errorCode' = any (array[
          'UPSTREAM_FAILURE', 'REPORT_GENERATION_FAILED', 'REPORT_STORAGE_FAILED',
          'REPORT_DOWNLOAD_FAILED', 'REPORT_ARCHIVE_FAILED', 'REPORT_DELETE_FAILED'
        ])
      when 'audit_view' then details ->> 'reasonCode' = 'ACCESS_DENIED'
      when 'system' then
        details ->> 'component' = any (array[
          'operation-state-machine', 'operation-result-refinement'
        ]) and details ->> 'errorCode' = any (array[
          'ACTIVE_OPERATION', 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'INITIAL_RESULTS_COUNT_MISMATCH',
          'INITIAL_RESULTS_INVALID', 'INTERRUPTED', 'LAUNCH_FAILED',
          'OPERATION_FINALIZATION_INCOMPLETE', 'OPERATION_FINALIZATION_REJECTED',
          'OPERATION_LAUNCH_ATTEMPT_STALE', 'OPERATION_LAUNCH_FAILURE_REJECTED',
          'OPERATION_LAUNCH_RETRY_REJECTED', 'OPERATION_REQUEST_INVALID',
          'OPERATION_START_REJECTED', 'OPERATION_UNAVAILABLE',
          'PROTECTED_RESULT_PAYLOAD_INVALID', 'STOP_KIND_INVALID', 'TASK_RESULT_CONFLICT',
          'TASK_RESULT_FIELDS_INVALID', 'TASK_RESULT_REFINEMENT_CONFLICT',
          'TASK_RESULT_REFINEMENT_FIELDS_INVALID', 'TASK_RESULT_REFINEMENT_REJECTED',
          'TASK_RESULT_REFINEMENT_VERSIONS_INVALID', 'TASK_RESULT_REJECTED',
          'TASK_RESULT_REFINED', 'UNCONFIRMED_RESULT_RETRY_FORBIDDEN', 'UPSTREAM_FAILURE',
          'UPSTREAM_OUTCOME_UNKNOWN'
        ])
      when 'retention' then true
      else false
    end and
    case details ->> 'kind'
      when 'operation' then
        details ?& array['kind', 'reasonCode', 'summary']::text[]
        and details - array['kind', 'reasonCode', 'summary']::text[] = '{}'::jsonb
        and (
          jsonb_typeof(details -> 'summary') = 'null'
          or (
            jsonb_typeof(details -> 'summary') = 'object'
            and details -> 'summary' ?& array[
              'selected', 'successful', 'failed', 'unconfirmed', 'conflicted',
              'partiallyApplied', 'notProcessed'
            ]::text[]
            and (details -> 'summary') - array[
              'selected', 'successful', 'failed', 'unconfirmed', 'conflicted',
              'partiallyApplied', 'notProcessed'
            ]::text[] = '{}'::jsonb
            and jsonb_typeof(details -> 'summary' -> 'selected') = 'number'
            and (details -> 'summary' ->> 'selected')::numeric >= 0
            and scale((details -> 'summary' ->> 'selected')::numeric) = 0
            and jsonb_typeof(details -> 'summary' -> 'successful') = 'number'
            and (details -> 'summary' ->> 'successful')::numeric >= 0
            and scale((details -> 'summary' ->> 'successful')::numeric) = 0
            and jsonb_typeof(details -> 'summary' -> 'failed') = 'number'
            and (details -> 'summary' ->> 'failed')::numeric >= 0
            and scale((details -> 'summary' ->> 'failed')::numeric) = 0
            and jsonb_typeof(details -> 'summary' -> 'unconfirmed') = 'number'
            and (details -> 'summary' ->> 'unconfirmed')::numeric >= 0
            and scale((details -> 'summary' ->> 'unconfirmed')::numeric) = 0
            and jsonb_typeof(details -> 'summary' -> 'conflicted') = 'number'
            and (details -> 'summary' ->> 'conflicted')::numeric >= 0
            and scale((details -> 'summary' ->> 'conflicted')::numeric) = 0
            and jsonb_typeof(details -> 'summary' -> 'partiallyApplied') = 'number'
            and (details -> 'summary' ->> 'partiallyApplied')::numeric >= 0
            and scale((details -> 'summary' ->> 'partiallyApplied')::numeric) = 0
            and jsonb_typeof(details -> 'summary' -> 'notProcessed') = 'number'
            and (details -> 'summary' ->> 'notProcessed')::numeric >= 0
            and scale((details -> 'summary' ->> 'notProcessed')::numeric) = 0
          )
        )
      when 'access' then
        details ->> 'version' = '2'
        and details ?& array[
          'kind', 'version', 'previousAccessVersion', 'newAccessVersion', 'accessState',
          'addedPermissions', 'removedPermissions', 'addedFieldCount', 'removedFieldCount',
          'reasonCode'
        ]::text[]
        and details - array[
          'kind', 'version', 'previousAccessVersion', 'newAccessVersion', 'accessState',
          'addedPermissions', 'removedPermissions', 'addedFieldCount', 'removedFieldCount',
          'reasonCode'
        ]::text[] = '{}'::jsonb
        and jsonb_typeof(details -> 'version') = 'number'
        and (details ->> 'version')::numeric = 2
        and jsonb_typeof(details -> 'previousAccessVersion') in ('number', 'null')
        and (
          jsonb_typeof(details -> 'previousAccessVersion') = 'null'
          or (
            (details ->> 'previousAccessVersion')::numeric > 0
            and scale((details ->> 'previousAccessVersion')::numeric) = 0
          )
        )
        and jsonb_typeof(details -> 'newAccessVersion') = 'number'
        and (details ->> 'newAccessVersion')::numeric > 0
        and scale((details ->> 'newAccessVersion')::numeric) = 0
        and details ->> 'accessState' in ('active', 'revoked')
        and jsonb_typeof(details -> 'addedPermissions') = 'array'
        and jsonb_typeof(details -> 'removedPermissions') = 'array'
        and jsonb_array_length(details -> 'addedPermissions') <= 10
        and jsonb_array_length(details -> 'removedPermissions') <= 10
        and details -> 'addedPermissions' <@ '[
          "app_access", "run_bulk_operations", "change_allowed_fields", "retry_operations",
          "restore_operations", "view_own_reports", "view_all_reports", "export_reports",
          "view_audit", "manage_access"
        ]'::jsonb
        and details -> 'removedPermissions' <@ '[
          "app_access", "run_bulk_operations", "change_allowed_fields", "retry_operations",
          "restore_operations", "view_own_reports", "view_all_reports", "export_reports",
          "view_audit", "manage_access"
        ]'::jsonb
        and jsonb_typeof(details -> 'addedFieldCount') = 'number'
        and (details ->> 'addedFieldCount')::numeric >= 0
        and scale((details ->> 'addedFieldCount')::numeric) = 0
        and jsonb_typeof(details -> 'removedFieldCount') = 'number'
        and (details ->> 'removedFieldCount')::numeric >= 0
        and scale((details ->> 'removedFieldCount')::numeric) = 0
      when 'report' then
        details ?& array['kind', 'formats', 'stage', 'errorCode', 'retryable']::text[]
        and details - array['kind', 'formats', 'stage', 'errorCode', 'retryable']::text[] = '{}'::jsonb
        and jsonb_typeof(details -> 'formats') = 'array'
        and jsonb_array_length(details -> 'formats') <= 2
        and details -> 'formats' <@ '["xlsx", "csv"]'::jsonb
        and (details ->> 'stage' is null or details ->> 'stage' in (
          'request', 'generate', 'store', 'download', 'archive', 'delete'
        ))
        and jsonb_typeof(details -> 'retryable') in ('boolean', 'null')
      when 'audit_view' then
        details ?& array['kind', 'reasonCode']::text[]
        and details - array['kind', 'reasonCode']::text[] = '{}'::jsonb
      when 'retention' then
        details ?& array['kind', 'cutoffAt', 'deletedCount']::text[]
        and details - array['kind', 'cutoffAt', 'deletedCount']::text[] = '{}'::jsonb
        and case
          when details ->> 'cutoffAt' ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
          then (details ->> 'cutoffAt')::timestamptz is not null
          else false
        end
        and jsonb_typeof(details -> 'deletedCount') = 'number'
        and (details ->> 'deletedCount')::numeric > 0
        and scale((details ->> 'deletedCount')::numeric) = 0
      when 'system' then
        details ?& array['kind', 'component', 'errorCode', 'retryable']::text[]
        and details - array['kind', 'component', 'errorCode', 'retryable']::text[] = '{}'::jsonb
        and jsonb_typeof(details -> 'retryable') = 'boolean'
      else false
    end
  ) not valid;

-- Preserve the established implementation under an internal name and put a lease check in front
-- of every cron/queue reconciliation. The locked job row prevents a replacement lease from being
-- acquired after the check and before the access/audit side effects in the delegated function.
alter function public.apply_automatic_access_reconciliation(text, text, text, text, boolean, text, text, uuid)
  rename to apply_automatic_access_reconciliation_unchecked;

-- The wrapper owner may delegate internally, but no runtime role may call the bypass directly.
revoke all on function public.apply_automatic_access_reconciliation_unchecked(text, text, text, text, boolean, text, text, uuid)
  from public, anon, authenticated, service_role;

create function public.apply_automatic_access_reconciliation(
  p_portal_id text,
  p_user_id text,
  p_display_name text,
  p_employment_state text,
  p_is_manager boolean,
  p_source text,
  p_correlation_id text,
  p_lease_token uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_source not in ('request', 'cron', 'queue') then
    raise exception 'TC_ACCESS_RECONCILIATION_INPUT_INVALID' using errcode = '22023';
  end if;

  if p_source = 'request' then
    if p_lease_token is not null then
      raise exception 'TC_ACCESS_RECONCILIATION_INPUT_INVALID' using errcode = '22023';
    end if;
  else
    if p_lease_token is null then
      raise exception 'TC_ACCESS_RECONCILIATION_INPUT_INVALID' using errcode = '22023';
    end if;
    -- Keep the same user_settings -> reconciliation_job lock order as access-change triggers.
    perform 1
    from public.user_settings
    where portal_id = p_portal_id
      and user_id = p_user_id
    for update;

    perform 1
    from public.access_reconciliation_job
    where portal_id = p_portal_id
      and user_id = p_user_id
      and lease_token = p_lease_token
      and lease_expires_at > now()
    for update;
    if not found then
      return jsonb_build_object('disposition', 'stale_lease');
    end if;
  end if;

  return public.apply_automatic_access_reconciliation_unchecked(
    p_portal_id,
    p_user_id,
    p_display_name,
    p_employment_state,
    p_is_manager,
    p_source,
    p_correlation_id,
    p_lease_token
  );
end;
$$;

create or replace function public.record_access_reconciliation_unknown(
  p_portal_id text,
  p_user_id text,
  p_lease_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.access_reconciliation_job
  set available_at = now() + interval '5 minutes',
      lease_token = null,
      lease_expires_at = null,
      last_checked_at = now(),
      last_outcome = 'unknown'
  where portal_id = p_portal_id
    and user_id = p_user_id
    and lease_token = p_lease_token
    and lease_expires_at > now();
end;
$$;

create function public.save_access_draft_with_field_set(
  p_portal_id text,
  p_manager_user_id text,
  p_expected_revision bigint,
  p_field_ids text[],
  p_draft_payload jsonb
)
returns public.access_management_draft
language plpgsql
security definer
set search_path = ''
as $$
declare
  field_set_id uuid;
  payload jsonb;
begin
  if cardinality(p_field_ids) > 256 then
    raise exception 'TC_ACCESS_FIELD_SET_INVALID' using errcode = '22023';
  end if;
  field_set_id := public.access_field_set_for_fields(p_portal_id, p_field_ids);
  payload := jsonb_set(
    p_draft_payload,
    '{fieldScope}',
    jsonb_build_object('fieldSetId', field_set_id, 'version', 1),
    true
  );
  return public.save_access_draft(
    p_portal_id,
    p_manager_user_id,
    p_expected_revision,
    payload
  );
end;
$$;

revoke all on function public.apply_automatic_access_reconciliation(text, text, text, text, boolean, text, text, uuid) from public, anon, authenticated;
revoke all on function public.save_access_draft_with_field_set(text, text, bigint, text[], jsonb) from public, anon, authenticated;
grant execute on function public.apply_automatic_access_reconciliation(text, text, text, text, boolean, text, text, uuid) to service_role;
grant execute on function public.save_access_draft_with_field_set(text, text, bigint, text[], jsonb) to service_role;

commit;
