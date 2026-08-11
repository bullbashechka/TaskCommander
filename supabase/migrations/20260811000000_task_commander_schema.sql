begin;

create extension if not exists pgcrypto with schema extensions;

create table public.portal (
  id text primary key,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portal_id_format check (id = btrim(id) and char_length(id) between 1 and 128),
  constraint portal_display_name_format check (
    display_name = btrim(display_name) and char_length(display_name) between 1 and 256
  )
);

create table public.user_settings (
  portal_id text not null,
  user_id text not null,
  display_name text not null,
  access_active boolean not null default false,
  permissions text[] not null default '{}'::text[],
  allowed_field_ids text[] not null default '{}'::text[],
  granted_at timestamptz,
  granted_by_user_id text,
  access_revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (portal_id, user_id),
  foreign key (portal_id) references public.portal (id) on delete restrict,
  foreign key (portal_id, granted_by_user_id)
    references public.user_settings (portal_id, user_id) on delete restrict,
  constraint user_settings_user_id_format check (
    user_id ~ '^[0-9]+$' and char_length(user_id) between 1 and 32
  ),
  constraint user_settings_display_name_format check (
    display_name = btrim(display_name) and char_length(display_name) between 1 and 256
  ),
  constraint user_settings_permissions_allowed check (
    permissions <@ array[
      'app_access',
      'run_bulk_operations',
      'change_allowed_fields',
      'retry_operations',
      'restore_operations',
      'view_own_reports',
      'view_all_reports',
      'export_reports',
      'view_audit',
      'manage_access'
    ]::text[]
  ),
  constraint user_settings_allowed_fields_limit check (cardinality(allowed_field_ids) <= 256),
  constraint user_settings_access_timestamps check (
    granted_at is null or access_revoked_at is null or granted_at <= access_revoked_at
  )
);

create table public.saved_filter (
  id uuid primary key default gen_random_uuid(),
  portal_id text not null,
  owner_id text not null,
  name text not null,
  normalized_name text generated always as (lower(btrim(name))) stored,
  revision integer not null default 1,
  filter_payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (portal_id, owner_id)
    references public.user_settings (portal_id, user_id) on delete restrict,
  constraint saved_filter_name_format check (
    name = btrim(name) and char_length(name) between 1 and 120
  ),
  constraint saved_filter_revision_positive check (revision > 0),
  constraint saved_filter_payload_shape check (
    jsonb_typeof(filter_payload) = 'array'
    and jsonb_array_length(filter_payload) <= 256
    and octet_length(filter_payload::text) <= 65536
  ),
  constraint saved_filter_owner_name_key unique (portal_id, owner_id, normalized_name)
);

create table public.operation_draft (
  id uuid primary key default gen_random_uuid(),
  portal_id text not null,
  owner_id text not null,
  revision integer not null default 1,
  status text not null default 'preparing',
  filter_snapshot jsonb,
  sort_snapshot jsonb,
  selected_task_ids text[] not null,
  changes jsonb not null,
  preflight_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  foreign key (portal_id, owner_id)
    references public.user_settings (portal_id, user_id) on delete restrict,
  constraint operation_draft_owner_key unique (portal_id, owner_id),
  constraint operation_draft_revision_positive check (revision > 0),
  constraint operation_draft_status_allowed check (status in ('preparing', 'awaiting_confirmation')),
  constraint operation_draft_selection_limit check (cardinality(selected_task_ids) between 1 and 1000),
  constraint operation_draft_changes_shape check (
    jsonb_typeof(changes) = 'array'
    and jsonb_array_length(changes) between 1 and 64
    and octet_length(changes::text) <= 65536
  ),
  constraint operation_draft_filter_shape check (
    filter_snapshot is null or jsonb_typeof(filter_snapshot) = 'object'
  ),
  constraint operation_draft_sort_shape check (
    sort_snapshot is null or jsonb_typeof(sort_snapshot) = 'object'
  ),
  constraint operation_draft_preflight_shape check (
    preflight_snapshot is null or jsonb_typeof(preflight_snapshot) = 'object'
  ),
  constraint operation_draft_timestamps check (created_at <= updated_at and updated_at <= expires_at)
);

create table public.bulk_operation (
  id uuid primary key default gen_random_uuid(),
  portal_id text not null,
  operation_type text not null,
  status text not null default 'launching',
  initiator_id text not null,
  initiator_display_name text not null,
  source_operation_id uuid,
  idempotency_key text not null,
  filter_snapshot jsonb,
  selected_task_ids text[] not null,
  changes jsonb not null,
  preflight_snapshot jsonb not null,
  cancel_requested_at timestamptz,
  interruption_reason_code text,
  interruption_reason_message text,
  selected_count integer not null default 0,
  eligible_count integer not null default 0,
  excluded_count integer not null default 0,
  unchanged_count integer not null default 0,
  successful_count integer not null default 0,
  failed_count integer not null default 0,
  conflicted_count integer not null default 0,
  partially_applied_count integer not null default 0,
  not_processed_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  last_progress_at timestamptz,
  completed_at timestamptz,
  foreign key (portal_id) references public.portal (id) on delete restrict,
  foreign key (portal_id, initiator_id)
    references public.user_settings (portal_id, user_id) on delete restrict,
  foreign key (portal_id, source_operation_id)
    references public.bulk_operation (portal_id, id) on delete restrict,
  constraint bulk_operation_portal_id_id_key unique (portal_id, id),
  constraint bulk_operation_type_allowed check (operation_type in ('bulk_change', 'retry', 'restore')),
  constraint bulk_operation_status_allowed check (
    status in (
      'launching',
      'running',
      'completed',
      'completed_with_errors',
      'cancelled',
      'interrupted',
      'launch_failed'
    )
  ),
  constraint bulk_operation_initiator_id_format check (
    initiator_id ~ '^[0-9]+$' and char_length(initiator_id) between 1 and 32
  ),
  constraint bulk_operation_initiator_name_format check (
    initiator_display_name = btrim(initiator_display_name)
    and char_length(initiator_display_name) between 1 and 256
  ),
  constraint bulk_operation_idempotency_key_format check (
    idempotency_key = btrim(idempotency_key) and char_length(idempotency_key) between 1 and 128
  ),
  constraint bulk_operation_source_type check (
    (operation_type = 'bulk_change' and source_operation_id is null)
    or (operation_type in ('retry', 'restore') and source_operation_id is not null)
  ),
  constraint bulk_operation_source_not_self check (source_operation_id is distinct from id),
  constraint bulk_operation_selection_limit check (cardinality(selected_task_ids) between 1 and 1000),
  constraint bulk_operation_changes_shape check (
    jsonb_typeof(changes) = 'array'
    and jsonb_array_length(changes) between 1 and 64
    and octet_length(changes::text) <= 65536
  ),
  constraint bulk_operation_filter_shape check (
    filter_snapshot is null or jsonb_typeof(filter_snapshot) = 'object'
  ),
  constraint bulk_operation_preflight_shape check (jsonb_typeof(preflight_snapshot) = 'object'),
  constraint bulk_operation_nonnegative_counts check (
    selected_count >= 0
    and eligible_count >= 0
    and excluded_count >= 0
    and unchanged_count >= 0
    and successful_count >= 0
    and failed_count >= 0
    and conflicted_count >= 0
    and partially_applied_count >= 0
    and not_processed_count >= 0
  ),
  constraint bulk_operation_summary_bounds check (
    eligible_count + excluded_count + unchanged_count <= selected_count
    and successful_count + failed_count + conflicted_count + partially_applied_count
      + not_processed_count <= eligible_count
  ),
  constraint bulk_operation_timestamps check (
    (started_at is null or started_at >= created_at)
    and (last_progress_at is null or last_progress_at >= created_at)
    and (completed_at is null or completed_at >= created_at)
    and (completed_at is null or started_at is null or completed_at >= started_at)
  ),
  constraint bulk_operation_idempotency_key unique (portal_id, initiator_id, idempotency_key)
);

create unique index bulk_operation_one_active_per_initiator
  on public.bulk_operation (portal_id, initiator_id)
  where status in ('launching', 'running');

create table public.task_processing_result (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null,
  task_id text not null,
  task_title text,
  task_url text,
  outcome text not null,
  requested_field_ids text[] not null default '{}'::text[],
  applied_field_ids text[] not null default '{}'::text[],
  failed_field_ids text[] not null default '{}'::text[],
  reason_code text,
  reason_message text,
  correlation_id text,
  can_retry boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (operation_id) references public.bulk_operation (id) on delete restrict,
  constraint task_processing_result_task_id_format check (
    task_id ~ '^[0-9]+$' and char_length(task_id) between 1 and 32
  ),
  constraint task_processing_result_title_format check (
    task_title is null or (task_title = btrim(task_title) and char_length(task_title) between 1 and 1024)
  ),
  constraint task_processing_result_url_format check (
    task_url is null or char_length(task_url) between 1 and 2048
  ),
  constraint task_processing_result_outcome_allowed check (
    outcome in (
      'success',
      'error',
      'conflict',
      'excluded_by_preflight',
      'not_processed',
      'restored',
      'restore_error',
      'no_change',
      'partially_applied'
    )
  ),
  constraint task_processing_result_field_limits check (
    cardinality(requested_field_ids) <= 256
    and cardinality(applied_field_ids) <= 256
    and cardinality(failed_field_ids) <= 256
  ),
  constraint task_processing_result_reason_code_format check (
    reason_code is null or (reason_code = btrim(reason_code) and char_length(reason_code) between 1 and 128)
  ),
  constraint task_processing_result_reason_message_format check (
    reason_message is null
    or (reason_message = btrim(reason_message) and char_length(reason_message) between 1 and 512)
  ),
  constraint task_processing_result_correlation_format check (
    correlation_id is null
    or correlation_id ~ '^TC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  constraint task_processing_result_operation_task_key unique (operation_id, task_id)
);

create table public.protected_task_result (
  task_processing_result_id uuid primary key,
  ciphertext bytea not null,
  nonce bytea not null,
  key_version text not null,
  payload_version smallint not null default 1,
  before_version text not null,
  after_version text not null,
  created_at timestamptz not null default now(),
  foreign key (task_processing_result_id)
    references public.task_processing_result (id) on delete restrict,
  constraint protected_task_result_ciphertext_present check (octet_length(ciphertext) > 0),
  constraint protected_task_result_nonce_length check (octet_length(nonce) = 12),
  constraint protected_task_result_key_version_format check (
    key_version = btrim(key_version) and char_length(key_version) between 1 and 64
  ),
  constraint protected_task_result_payload_version_positive check (payload_version > 0),
  constraint protected_task_result_before_version_format check (
    before_version = btrim(before_version) and char_length(before_version) between 1 and 256
  ),
  constraint protected_task_result_after_version_format check (
    after_version = btrim(after_version) and char_length(after_version) between 1 and 256
  )
);

create table public.report (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null,
  storage_status text not null default 'active',
  active_until timestamptz not null,
  archived_at timestamptz,
  delete_after timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (operation_id) references public.bulk_operation (id) on delete restrict,
  constraint report_operation_key unique (operation_id),
  constraint report_storage_status_allowed check (
    storage_status in ('active', 'archived', 'archived_pending_artifact')
  ),
  constraint report_retention_timestamps check (
    active_until <= delete_after and (archived_at is null or archived_at >= active_until)
  )
);

create table public.report_artifact (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null,
  format text not null,
  status text not null default 'pending',
  disk_file_id text,
  disk_path text,
  r2_key text,
  attempt_count integer not null default 0,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ready_at timestamptz,
  foreign key (report_id) references public.report (id) on delete restrict,
  constraint report_artifact_format_allowed check (format in ('xlsx', 'csv')),
  constraint report_artifact_status_allowed check (
    status in ('pending', 'generating', 'awaiting_upload', 'ready', 'failed', 'unavailable')
  ),
  constraint report_artifact_attempt_count_nonnegative check (attempt_count >= 0),
  constraint report_artifact_disk_file_id_format check (
    disk_file_id is null or (disk_file_id = btrim(disk_file_id) and char_length(disk_file_id) <= 256)
  ),
  constraint report_artifact_disk_path_format check (
    disk_path is null or (disk_path = btrim(disk_path) and char_length(disk_path) <= 1024)
  ),
  constraint report_artifact_r2_key_format check (
    r2_key is null or (r2_key = btrim(r2_key) and char_length(r2_key) <= 1024)
  ),
  constraint report_artifact_error_code_format check (
    last_error_code is null
    or (last_error_code = btrim(last_error_code) and char_length(last_error_code) between 1 and 128)
  ),
  constraint report_artifact_ready_requires_disk_file check (
    status <> 'ready' or disk_file_id is not null
  ),
  constraint report_artifact_report_format_key unique (report_id, format)
);

create table public.audit_event (
  id uuid primary key default gen_random_uuid(),
  portal_id text not null,
  occurred_at timestamptz not null default now(),
  action text not null,
  actor_id text,
  actor_display_name text,
  subject_type text,
  subject_id text,
  outcome text not null,
  correlation_id text,
  metadata jsonb not null default '{}'::jsonb,
  foreign key (portal_id) references public.portal (id) on delete restrict,
  constraint audit_event_action_allowed check (
    action in (
      'operation_created',
      'operation_started',
      'operation_completed',
      'operation_cancelled',
      'operation_interrupted',
      'operation_retried',
      'operation_restored',
      'access_granted',
      'access_updated',
      'access_revoked',
      'allowed_fields_updated',
      'report_exported',
      'report_downloaded',
      'access_auto_revoked',
      'report_generation_failed',
      'system_error'
    )
  ),
  constraint audit_event_actor_id_format check (
    actor_id is null or (actor_id ~ '^[0-9]+$' and char_length(actor_id) between 1 and 32)
  ),
  constraint audit_event_actor_name_format check (
    actor_display_name is null
    or (actor_display_name = btrim(actor_display_name)
      and char_length(actor_display_name) between 1 and 256)
  ),
  constraint audit_event_subject_type_format check (
    subject_type is null
    or (subject_type = btrim(subject_type) and char_length(subject_type) between 1 and 64)
  ),
  constraint audit_event_subject_id_format check (
    subject_id is null
    or (subject_id = btrim(subject_id) and char_length(subject_id) between 1 and 256)
  ),
  constraint audit_event_outcome_allowed check (outcome in ('success', 'failure')),
  constraint audit_event_correlation_format check (
    correlation_id is null
    or correlation_id ~ '^TC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  constraint audit_event_metadata_shape check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384
  )
);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create function public.set_draft_updated_at_and_expiry()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  new.expires_at = new.updated_at + interval '24 hours';
  return new;
end;
$$;

create function public.prevent_bulk_operation_snapshot_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.portal_id is distinct from old.portal_id
    or new.operation_type is distinct from old.operation_type
    or new.initiator_id is distinct from old.initiator_id
    or new.initiator_display_name is distinct from old.initiator_display_name
    or new.source_operation_id is distinct from old.source_operation_id
    or new.idempotency_key is distinct from old.idempotency_key
    or new.filter_snapshot is distinct from old.filter_snapshot
    or new.selected_task_ids is distinct from old.selected_task_ids
    or new.changes is distinct from old.changes
    or new.preflight_snapshot is distinct from old.preflight_snapshot then
    raise exception 'Bulk operation snapshots are immutable.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function public.prevent_task_processing_result_identity_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.operation_id is distinct from old.operation_id or new.task_id is distinct from old.task_id then
    raise exception 'Task processing result identity is immutable.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function public.prevent_audit_event_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Audit events are append-only.' using errcode = '23514';
end;
$$;

create trigger portal_set_updated_at
before update on public.portal
for each row execute function public.set_updated_at();

create trigger user_settings_set_updated_at
before update on public.user_settings
for each row execute function public.set_updated_at();

create trigger saved_filter_set_updated_at
before update on public.saved_filter
for each row execute function public.set_updated_at();

create trigger operation_draft_set_updated_at_and_expiry
before update on public.operation_draft
for each row execute function public.set_draft_updated_at_and_expiry();

create trigger bulk_operation_set_updated_at
before update on public.bulk_operation
for each row execute function public.set_updated_at();

create trigger bulk_operation_prevent_snapshot_change
before update on public.bulk_operation
for each row execute function public.prevent_bulk_operation_snapshot_change();

create trigger task_processing_result_set_updated_at
before update on public.task_processing_result
for each row execute function public.set_updated_at();

create trigger task_processing_result_prevent_identity_change
before update on public.task_processing_result
for each row execute function public.prevent_task_processing_result_identity_change();

create trigger report_set_updated_at
before update on public.report
for each row execute function public.set_updated_at();

create trigger report_artifact_set_updated_at
before update on public.report_artifact
for each row execute function public.set_updated_at();

create trigger audit_event_prevent_update
before update on public.audit_event
for each row execute function public.prevent_audit_event_mutation();

create trigger audit_event_prevent_delete
before delete on public.audit_event
for each row execute function public.prevent_audit_event_mutation();

create index bulk_operation_history_by_initiator
  on public.bulk_operation (portal_id, initiator_id, created_at desc);

create index bulk_operation_history_by_portal
  on public.bulk_operation (portal_id, created_at desc);

create index bulk_operation_history_by_type_status
  on public.bulk_operation (portal_id, operation_type, status, created_at desc);

create index task_processing_result_by_operation_outcome
  on public.task_processing_result (operation_id, outcome);

create index report_retention_by_status
  on public.report (storage_status, active_until, delete_after);

create index operation_draft_by_expiry
  on public.operation_draft (expires_at);

create index saved_filter_by_owner
  on public.saved_filter (portal_id, owner_id, normalized_name);

create index audit_event_by_portal_time
  on public.audit_event (portal_id, occurred_at desc);

create index audit_event_by_actor_time
  on public.audit_event (portal_id, actor_id, occurred_at desc);

create index audit_event_by_action_time
  on public.audit_event (portal_id, action, occurred_at desc);

create index audit_event_by_subject
  on public.audit_event (portal_id, subject_type, subject_id, occurred_at desc);

alter table public.portal enable row level security;
alter table public.user_settings enable row level security;
alter table public.saved_filter enable row level security;
alter table public.operation_draft enable row level security;
alter table public.bulk_operation enable row level security;
alter table public.task_processing_result enable row level security;
alter table public.protected_task_result enable row level security;
alter table public.report enable row level security;
alter table public.report_artifact enable row level security;
alter table public.audit_event enable row level security;

revoke all on table public.portal from anon, authenticated;
revoke all on table public.user_settings from anon, authenticated;
revoke all on table public.saved_filter from anon, authenticated;
revoke all on table public.operation_draft from anon, authenticated;
revoke all on table public.bulk_operation from anon, authenticated;
revoke all on table public.task_processing_result from anon, authenticated;
revoke all on table public.protected_task_result from anon, authenticated;
revoke all on table public.report from anon, authenticated;
revoke all on table public.report_artifact from anon, authenticated;
revoke all on table public.audit_event from anon, authenticated;

commit;
