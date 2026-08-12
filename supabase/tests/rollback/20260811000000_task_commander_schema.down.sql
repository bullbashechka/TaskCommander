drop trigger if exists audit_event_prevent_delete on public.audit_event;
drop trigger if exists audit_event_prevent_update on public.audit_event;
drop trigger if exists bulk_operation_prevent_status_bypass on public.bulk_operation;
drop trigger if exists task_result_refinement_prevent_delete on public.task_result_refinement;
drop trigger if exists task_result_refinement_prevent_update on public.task_result_refinement;
drop trigger if exists z_task_processing_result_prevent_mutation on public.task_processing_result;
drop function if exists public.record_task_result_refinement(
  text, uuid, text, text, text[], text[], text, text, text, boolean
);
drop function if exists public.record_task_result_refinement_with_versions(
  text, uuid, text, text, text[], text[], text, text, text, boolean, text, text
);
drop function if exists public.purge_integration_test_fixture(text);
drop function if exists public.retry_bulk_operation_launch(text, uuid, text);
drop function if exists public.request_bulk_operation_cancellation(text, uuid, text);
drop function if exists public.request_bulk_operation_interruption_with_attempt(
  text, uuid, integer, text, text, text
);
drop function if exists public.finalize_bulk_operation_with_attempt(text, uuid, integer, text);
drop function if exists public.start_bulk_operation_with_attempt(text, uuid, integer, text);
drop function if exists public.prevent_task_result_refinement_mutation();
drop function if exists public.prevent_task_processing_result_mutation();
drop function if exists public.task_result_refinement_fingerprint(
  text, text[], text[], text, text, boolean, text, text
);
drop function if exists public.task_processing_result_fingerprint(
  text, text, text, text[], text[], text[], text, text, boolean, text, text
);
drop function if exists public.operation_request_fingerprint_with_initial_results(
  text, uuid, jsonb, text[], jsonb, jsonb, integer, integer, integer, integer, jsonb
);
drop function if exists public.fail_bulk_operation_launch_with_attempt(text, uuid, integer, text);
drop function if exists public.fail_bulk_operation_launch(text, uuid, text);
drop function if exists public.record_task_processing_result_with_attempt(
  text, uuid, integer, text, text, text, text, text[], text[], text[], text, text, text,
  boolean, bytea, bytea, text, smallint, text, text
);
drop function if exists public.record_task_processing_result(
  text, uuid, text, text, text, text, text[], text[], text[], text, text, text, boolean,
  bytea, bytea, text, smallint, text, text
);
drop function if exists public.finalize_bulk_operation(text, uuid, text);
drop function if exists public.request_bulk_operation_stop(text, uuid, text, text, text, text);
drop function if exists public.start_bulk_operation(text, uuid, text);
drop function if exists public.create_bulk_operation_idempotent(
  text, text, text, text, uuid, text, jsonb, text[], jsonb, jsonb, integer, integer, integer,
  integer, text, jsonb
);
drop function if exists public.append_operation_state_error(text, uuid, text, text);
drop function if exists public.prevent_bulk_operation_status_bypass();
drop function if exists public.set_bulk_operation_state_machine_context();
drop function if exists public.operation_request_fingerprint(
  text, uuid, jsonb, text[], jsonb, jsonb, integer, integer, integer, integer
);
drop function if exists public.purge_expired_audit_events(text, uuid);
drop function if exists public.append_audit_event(
  text, timestamptz, text, text, text, text, text, text, text, text, jsonb, text, text, text, text, jsonb
);
drop trigger if exists report_artifact_set_updated_at on public.report_artifact;
drop trigger if exists report_set_updated_at on public.report;
drop trigger if exists task_processing_result_prevent_identity_change on public.task_processing_result;
drop trigger if exists task_processing_result_set_updated_at on public.task_processing_result;
drop trigger if exists bulk_operation_prevent_snapshot_change on public.bulk_operation;
drop trigger if exists bulk_operation_set_updated_at on public.bulk_operation;
drop trigger if exists operation_draft_set_updated_at_and_expiry on public.operation_draft;
drop trigger if exists saved_filter_set_updated_at on public.saved_filter;
drop trigger if exists user_settings_set_updated_at on public.user_settings;
drop trigger if exists portal_set_updated_at on public.portal;

drop table if exists public.task_result_refinement;
drop table if exists public.protected_task_result;
drop table if exists public.task_processing_result;
drop table if exists public.report_artifact;
drop table if exists public.report;
drop table if exists public.audit_event;
drop table if exists public.bulk_operation;
drop table if exists public.operation_draft;
drop table if exists public.saved_filter;
drop table if exists public.user_settings;
drop table if exists public.portal;

drop function if exists public.prevent_audit_event_mutation();
drop function if exists public.prevent_task_processing_result_identity_change();
drop function if exists public.prevent_bulk_operation_snapshot_change();
drop function if exists public.set_draft_updated_at_and_expiry();
drop function if exists public.set_updated_at();
