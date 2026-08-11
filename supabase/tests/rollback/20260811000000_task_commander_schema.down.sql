drop trigger if exists audit_event_prevent_delete on public.audit_event;
drop trigger if exists audit_event_prevent_update on public.audit_event;
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
