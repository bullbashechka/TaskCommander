begin;

create function public.access_text_array_is_canonical(
  p_values text[],
  p_max_element_length integer
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_values is not null
    and cardinality(p_values) = cardinality(array(select distinct value from unnest(p_values) as value))
    and not coalesce(
      exists (
        select 1
        from unnest(p_values) as value
        where value is null
          or value <> btrim(value)
          or char_length(value) not between 1 and p_max_element_length
      ),
      true
    );
$$;

create function public.access_permissions_are_valid(p_permissions text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select public.access_text_array_is_canonical(p_permissions, 64)
    and p_permissions <@ array[
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
    and ('app_access' = any(p_permissions) or cardinality(p_permissions) = 0)
    and (not ('run_bulk_operations' = any(p_permissions)) or (
      'app_access' = any(p_permissions) and 'change_allowed_fields' = any(p_permissions)
    ))
    and (not ('retry_operations' = any(p_permissions)) or (
      'app_access' = any(p_permissions)
      and 'run_bulk_operations' = any(p_permissions)
      and 'change_allowed_fields' = any(p_permissions)
      and 'view_own_reports' = any(p_permissions)
    ))
    and (not ('restore_operations' = any(p_permissions)) or (
      'app_access' = any(p_permissions)
      and 'run_bulk_operations' = any(p_permissions)
      and 'change_allowed_fields' = any(p_permissions)
      and 'view_own_reports' = any(p_permissions)
    ))
    and (not ('view_all_reports' = any(p_permissions)) or (
      'app_access' = any(p_permissions) and 'view_own_reports' = any(p_permissions)
    ))
    and (not ('export_reports' = any(p_permissions)) or (
      'app_access' = any(p_permissions) and 'view_own_reports' = any(p_permissions)
    ))
    and (not ('view_audit' = any(p_permissions)) or 'app_access' = any(p_permissions))
    and (not ('manage_access' = any(p_permissions)) or 'app_access' = any(p_permissions));
$$;

alter table public.user_settings
  drop constraint user_settings_allowed_fields_limit,
  add column access_state text not null default 'review_required',
  add column access_version bigint not null default 1,
  add column permission_matrix_version integer not null default 1,
  add column field_set_id uuid;

create table public.access_field_set (
  id uuid not null default gen_random_uuid(),
  portal_id text not null,
  version bigint not null default 1,
  member_count integer not null,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  primary key (id),
  unique (portal_id, id),
  unique (portal_id, fingerprint),
  foreign key (portal_id) references public.portal (id) on delete restrict,
  constraint access_field_set_version_positive check (version > 0),
  constraint access_field_set_member_count_nonnegative check (member_count >= 0),
  constraint access_field_set_fingerprint_format check (fingerprint ~ '^[0-9a-f]{64}$')
);

create table public.access_field_set_member (
  portal_id text not null,
  field_set_id uuid not null,
  field_id text not null,
  ordinal integer not null,
  created_at timestamptz not null default now(),
  primary key (portal_id, field_set_id, field_id),
  unique (portal_id, field_set_id, ordinal),
  foreign key (portal_id, field_set_id)
    references public.access_field_set (portal_id, id) on delete restrict,
  constraint access_field_set_member_field_format check (
    field_id = btrim(field_id) and char_length(field_id) between 1 and 128
  ),
  constraint access_field_set_member_ordinal_positive check (ordinal > 0)
);

create table public.access_management_draft (
  id uuid not null default gen_random_uuid(),
  portal_id text not null,
  manager_user_id text not null,
  revision bigint not null default 1,
  status text not null default 'editing',
  draft_payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (id),
  unique (portal_id, id),
  unique (portal_id, manager_user_id),
  foreign key (portal_id) references public.portal (id) on delete restrict,
  constraint access_management_draft_manager_format check (
    manager_user_id ~ '^[0-9]+$' and char_length(manager_user_id) between 1 and 32
  ),
  constraint access_management_draft_revision_positive check (revision > 0),
  constraint access_management_draft_status_allowed check (
    status in ('editing', 'preflighted', 'submitted', 'expired')
  ),
  constraint access_management_draft_payload_shape check (
    jsonb_typeof(draft_payload) = 'object'
    and octet_length(draft_payload::text) <= 131072
  ),
  constraint access_management_draft_timestamps check (
    created_at <= updated_at and updated_at <= expires_at
  )
);

create table public.access_preflight (
  id uuid not null default gen_random_uuid(),
  portal_id text not null,
  draft_id uuid not null,
  manager_user_id text not null,
  draft_revision bigint not null,
  manager_access_version bigint not null,
  permission_matrix_version integer not null,
  mode text not null,
  request_fingerprint text not null,
  status text not null default 'valid',
  summary jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  primary key (id),
  unique (portal_id, id),
  foreign key (portal_id, draft_id)
    references public.access_management_draft (portal_id, id) on delete restrict,
  constraint access_preflight_manager_format check (
    manager_user_id ~ '^[0-9]+$' and char_length(manager_user_id) between 1 and 32
  ),
  constraint access_preflight_versions_positive check (
    draft_revision > 0 and manager_access_version > 0 and permission_matrix_version > 0
  ),
  constraint access_preflight_mode_allowed check (
    mode in ('grant', 'replace_managed', 'revoke_managed', 'full_revoke', 'repair')
  ),
  constraint access_preflight_fingerprint_format check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint access_preflight_status_allowed check (status in ('valid', 'stale', 'consumed')),
  constraint access_preflight_summary_shape check (
    jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 8192
  ),
  constraint access_preflight_expiry check (created_at < expires_at),
  constraint access_preflight_consumption check ((status = 'consumed') = (consumed_at is not null))
);

create table public.access_preflight_target (
  portal_id text not null,
  preflight_id uuid not null,
  target_user_id text not null,
  target_display_name text not null,
  target_department_name text,
  target_is_portal_admin boolean not null,
  target_is_manager boolean not null,
  expected_access_version bigint,
  expected_access_state text not null,
  expected_permission_count integer not null,
  desired_access_state text not null,
  desired_permissions text[] not null,
  desired_field_set_id uuid,
  state text not null,
  reason_code text,
  issue_message text,
  requested_delta jsonb not null,
  automatic_delta jsonb not null,
  redacted_delta jsonb not null,
  created_at timestamptz not null default now(),
  primary key (portal_id, preflight_id, target_user_id),
  foreign key (portal_id, preflight_id)
    references public.access_preflight (portal_id, id) on delete restrict,
  foreign key (portal_id, desired_field_set_id)
    references public.access_field_set (portal_id, id) on delete restrict,
  constraint access_preflight_target_user_format check (
    target_user_id ~ '^[0-9]+$' and char_length(target_user_id) between 1 and 32
  ),
  constraint access_preflight_target_display_name_format check (
    target_display_name = btrim(target_display_name)
    and char_length(target_display_name) between 1 and 256
  ),
  constraint access_preflight_target_optional_text_format check (
    (target_department_name is null or (
      target_department_name = btrim(target_department_name)
      and char_length(target_department_name) between 1 and 256
    ))
    and (issue_message is null or (
      issue_message = btrim(issue_message) and char_length(issue_message) between 1 and 512
    ))
  ),
  constraint access_preflight_target_version_positive check (
    expected_access_version is null or expected_access_version > 0
  ),
  constraint access_preflight_target_access_state_allowed check (
    desired_access_state in ('active', 'revoked')
    and expected_access_state in ('active', 'revoked', 'quarantined', 'review_required')
    and expected_permission_count between 0 and 10
    and (desired_access_state = 'active') = ('app_access' = any(desired_permissions))
  ),
  constraint access_preflight_target_permissions_valid check (
    public.access_permissions_are_valid(desired_permissions)
  ),
  constraint access_preflight_target_state_allowed check (
    state in ('ready', 'excluded', 'conflict', 'no_change')
  ),
  constraint access_preflight_target_reason check (
    (state in ('ready', 'no_change') and reason_code is null)
    or (
      state in ('excluded', 'conflict')
      and reason_code = btrim(reason_code)
      and char_length(reason_code) between 1 and 128
    )
  ),
  constraint access_preflight_target_delta_shape check (
    jsonb_typeof(requested_delta) = 'object'
    and jsonb_typeof(automatic_delta) = 'object'
    and jsonb_typeof(redacted_delta) = 'object'
    and octet_length(requested_delta::text) <= 16384
    and octet_length(automatic_delta::text) <= 16384
    and octet_length(redacted_delta::text) <= 16384
  )
);

create table public.access_command (
  id uuid not null,
  portal_id text not null,
  preflight_id uuid not null,
  actor_user_id text not null,
  actor_display_name text not null,
  actor_is_portal_admin boolean not null,
  state text not null default 'accepted',
  state_version bigint not null default 1,
  total_count integer not null,
  ready_count integer not null,
  excluded_count integer not null default 0,
  conflict_count integer not null default 0,
  applied_count integer not null default 0,
  failed_count integer not null default 0,
  no_change_count integer not null default 0,
  idempotency_key text not null,
  confirmation_id uuid,
  correlation_id text not null,
  accepted_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  primary key (id),
  unique (portal_id, id),
  unique (portal_id, idempotency_key),
  foreign key (portal_id, preflight_id)
    references public.access_preflight (portal_id, id) on delete restrict,
  constraint access_command_actor_format check (
    actor_user_id ~ '^[0-9]+$' and char_length(actor_user_id) between 1 and 32
  ),
  constraint access_command_actor_name_format check (
    actor_display_name = btrim(actor_display_name)
    and char_length(actor_display_name) between 1 and 256
  ),
  constraint access_command_state_allowed check (
    state in (
      'accepted', 'validating', 'in_progress', 'succeeded',
      'partially_succeeded', 'failed', 'no_change'
    )
  ),
  constraint access_command_state_version_positive check (state_version > 0),
  constraint access_command_counts_valid check (
    total_count between 1 and 100
    and ready_count between 0 and total_count
    and excluded_count between 0 and total_count
    and conflict_count between 0 and total_count
    and applied_count between 0 and total_count
    and failed_count between 0 and total_count
    and no_change_count between 0 and total_count
  ),
  constraint access_command_idempotency_format check (
    idempotency_key = btrim(idempotency_key) and char_length(idempotency_key) between 1 and 128
  ),
  constraint access_command_correlation_format check (
    correlation_id ~ '^TC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  constraint access_command_terminal_timestamps check (
    (state in ('succeeded', 'partially_succeeded', 'failed', 'no_change'))
      = (completed_at is not null)
  )
);

create table public.access_command_target (
  portal_id text not null,
  command_id uuid not null,
  target_user_id text not null,
  target_display_name text not null,
  target_is_portal_admin boolean not null,
  target_is_manager boolean not null,
  expected_access_version bigint,
  desired_access_state text not null,
  desired_permissions text[] not null,
  desired_field_set_id uuid,
  request_fingerprint text not null,
  state text not null,
  reason_code text,
  requested_delta jsonb not null,
  automatic_delta jsonb not null,
  redacted_delta jsonb not null,
  before_access_version bigint,
  after_access_version bigint,
  access_change_id uuid,
  notification_state text not null default 'not_required',
  received_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (portal_id, command_id, target_user_id),
  foreign key (portal_id, command_id)
    references public.access_command (portal_id, id) on delete restrict,
  foreign key (portal_id, desired_field_set_id)
    references public.access_field_set (portal_id, id) on delete restrict,
  constraint access_command_target_version_positive check (
    expected_access_version is null or expected_access_version > 0
  ),
  constraint access_command_target_access_state_allowed check (
    desired_access_state in ('active', 'revoked')
    and (desired_access_state = 'active') = ('app_access' = any(desired_permissions))
  ),
  constraint access_command_target_permissions_valid check (
    public.access_permissions_are_valid(desired_permissions)
  ),
  constraint access_command_target_fingerprint_format check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint access_command_target_state_allowed check (
    state in ('ready', 'excluded', 'conflict', 'applying', 'applied', 'failed', 'no_change')
  ),
  constraint access_command_target_notification_allowed check (
    notification_state in ('not_required', 'queued', 'sent', 'failed')
  ),
  constraint access_command_target_delta_shape check (
    jsonb_typeof(requested_delta) = 'object'
    and jsonb_typeof(automatic_delta) = 'object'
    and jsonb_typeof(redacted_delta) = 'object'
    and octet_length(requested_delta::text) <= 16384
    and octet_length(automatic_delta::text) <= 16384
    and octet_length(redacted_delta::text) <= 16384
  )
);

create table public.access_command_dispatch_outbox (
  portal_id text not null,
  command_id uuid not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  primary key (portal_id, command_id),
  foreign key (portal_id, command_id)
    references public.access_command (portal_id, id) on delete restrict,
  constraint access_command_dispatch_status_allowed check (status in ('pending', 'dispatched')),
  constraint access_command_dispatch_attempts_valid check (attempt_count >= 0),
  constraint access_command_dispatch_timestamp check (
    (status = 'dispatched') = (dispatched_at is not null)
  )
);

create table public.access_change (
  id uuid not null default gen_random_uuid(),
  portal_id text not null,
  command_id uuid,
  target_user_id text not null,
  actor_type text not null,
  actor_user_id text,
  actor_display_name text not null,
  change_kind text not null,
  previous_access_version bigint,
  new_access_version bigint not null,
  before_snapshot jsonb not null,
  after_snapshot jsonb not null,
  audit_event_id uuid,
  field_audit_event_id uuid,
  correlation_id text,
  changed_at timestamptz not null default now(),
  primary key (id),
  unique (portal_id, id),
  unique (portal_id, command_id, target_user_id),
  foreign key (portal_id, command_id)
    references public.access_command (portal_id, id) on delete restrict,
  foreign key (portal_id, target_user_id)
    references public.user_settings (portal_id, user_id) on delete restrict,
  -- Audit retention may remove the referenced event after two years. These immutable UUID links
  -- deliberately are not foreign keys so retention never has to mutate access evidence.
  constraint access_change_actor_valid check (
    (
      actor_type = 'user'
      and actor_user_id ~ '^[0-9]+$'
      and char_length(actor_user_id) between 1 and 32
    )
    or (actor_type = 'system' and actor_user_id is null and actor_display_name = 'Система')
  ),
  constraint access_change_actor_name_format check (
    actor_display_name = btrim(actor_display_name)
    and char_length(actor_display_name) between 1 and 256
  ),
  constraint access_change_kind_allowed check (
    change_kind in ('grant', 'update', 'revoke', 'repair', 'migration_quarantine')
  ),
  constraint access_change_version_progression check (
    (previous_access_version is null and new_access_version = 1)
    or new_access_version = previous_access_version + 1
  ),
  constraint access_change_snapshots_shape check (
    jsonb_typeof(before_snapshot) = 'object'
    and jsonb_typeof(after_snapshot) = 'object'
    and octet_length(before_snapshot::text) <= 32768
    and octet_length(after_snapshot::text) <= 32768
  ),
  constraint access_change_correlation_format check (
    correlation_id is null
    or correlation_id ~ '^TC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  )
);

alter table public.access_command_target
  add foreign key (portal_id, access_change_id)
    references public.access_change (portal_id, id) on delete restrict;

create table public.access_change_evidence (
  id uuid not null default gen_random_uuid(),
  portal_id text not null,
  access_change_id uuid not null,
  evidence_type text not null,
  evidence_payload jsonb not null,
  recorded_at timestamptz not null default now(),
  primary key (id),
  unique (portal_id, id),
  foreign key (portal_id, access_change_id)
    references public.access_change (portal_id, id) on delete restrict,
  constraint access_change_evidence_type_format check (
    evidence_type = btrim(evidence_type)
    and char_length(evidence_type) between 1 and 128
  ),
  constraint access_change_evidence_payload_shape check (
    jsonb_typeof(evidence_payload) = 'object'
    and octet_length(evidence_payload::text) <= 65536
  )
);

-- Exact rollback material is kept in typed columns, not in size-limited audit JSON.
create table public.access_legacy_quarantine_backup (
  portal_id text not null,
  user_id text not null,
  access_active boolean not null,
  permissions text[] not null,
  allowed_field_ids text[] not null,
  granted_at timestamptz,
  granted_by_user_id text,
  access_revoked_at timestamptz,
  updated_at timestamptz not null,
  primary key (portal_id, user_id),
  foreign key (portal_id, user_id)
    references public.user_settings (portal_id, user_id) on delete restrict
);

create table public.notification_outbox (
  id uuid not null default gen_random_uuid(),
  portal_id text not null,
  access_change_id uuid not null,
  recipient_user_id text not null,
  notification_kind text not null,
  payload jsonb not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  delivered_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  primary key (id),
  unique (portal_id, id),
  unique (portal_id, access_change_id),
  foreign key (portal_id, access_change_id)
    references public.access_change (portal_id, id) on delete restrict,
  foreign key (portal_id, recipient_user_id)
    references public.user_settings (portal_id, user_id) on delete restrict,
  constraint notification_outbox_recipient_format check (
    recipient_user_id ~ '^[0-9]+$' and char_length(recipient_user_id) between 1 and 32
  ),
  constraint notification_outbox_kind_allowed check (
    notification_kind in ('access_granted', 'access_updated', 'access_revoked')
  ),
  constraint notification_outbox_payload_shape check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 16384
  ),
  constraint notification_outbox_status_allowed check (
    status in ('pending', 'claimed', 'delivered', 'failed')
  ),
  constraint notification_outbox_attempts_nonnegative check (attempt_count >= 0),
  constraint notification_outbox_delivery_state check (
    (status = 'delivered') = (delivered_at is not null)
  )
);

create table public.access_rate_limit_bucket (
  portal_id text not null,
  actor_user_id text not null,
  action text not null,
  bucket_started_at timestamptz not null,
  request_count integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (portal_id, actor_user_id, action, bucket_started_at),
  foreign key (portal_id) references public.portal (id) on delete restrict,
  constraint access_rate_limit_actor_format check (
    actor_user_id ~ '^[0-9]+$' and char_length(actor_user_id) between 1 and 32
  ),
  constraint access_rate_limit_action_allowed check (
    action in (
      'draft_save', 'preflight_create', 'command_accept', 'target_apply',
      'filtered_employee_search'
    )
  ),
  constraint access_rate_limit_bucket_aligned check (
    bucket_started_at = date_trunc('minute', bucket_started_at)
  ),
  constraint access_rate_limit_count_positive check (request_count > 0)
);

create function public.prevent_access_immutable_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Access management evidence is immutable.' using errcode = '23514';
end;
$$;

create trigger access_field_set_prevent_mutation
before update or delete on public.access_field_set
for each row execute function public.prevent_access_immutable_mutation();

create trigger access_field_set_member_prevent_mutation
before update or delete on public.access_field_set_member
for each row execute function public.prevent_access_immutable_mutation();

create trigger access_change_prevent_mutation
before update or delete on public.access_change
for each row execute function public.prevent_access_immutable_mutation();

create trigger access_change_evidence_prevent_mutation
before update or delete on public.access_change_evidence
for each row execute function public.prevent_access_immutable_mutation();

create trigger access_legacy_quarantine_backup_prevent_mutation
before update or delete on public.access_legacy_quarantine_backup
for each row execute function public.prevent_access_immutable_mutation();

create function public.access_field_set_for_fields(p_portal_id text, p_field_ids text[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  canonical_fields text[];
  computed_fingerprint text;
  field_set_id uuid;
begin
  if p_portal_id is null
    or not public.access_text_array_is_canonical(p_field_ids, 128) then
    raise exception 'TC_ACCESS_FIELD_SET_INVALID' using errcode = '22023';
  end if;

  select coalesce(array_agg(field_id order by field_id), '{}'::text[])
  into canonical_fields
  from unnest(p_field_ids) as field_id;

  computed_fingerprint := encode(
    extensions.digest(
      convert_to(pg_catalog.to_json(canonical_fields)::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_portal_id || ':' || computed_fingerprint, 0)
  );

  select id into field_set_id
  from public.access_field_set
  where portal_id = p_portal_id and fingerprint = computed_fingerprint;
  if found then
    return field_set_id;
  end if;

  insert into public.access_field_set (portal_id, member_count, fingerprint)
  values (p_portal_id, cardinality(canonical_fields), computed_fingerprint)
  returning id into field_set_id;

  insert into public.access_field_set_member (portal_id, field_set_id, field_id, ordinal)
  select p_portal_id, field_set_id, field_id, ordinality::integer
  from unnest(canonical_fields) with ordinality as fields(field_id, ordinality);

  return field_set_id;
end;
$$;

create function public.resolve_access_field_set(p_portal_id text, p_field_ids text[])
returns uuid
language sql
security definer
set search_path = ''
as $$
  select public.access_field_set_for_fields(p_portal_id, p_field_ids);
$$;

-- Preserve every contradictory legacy row before denying access. The migration never infers
-- intent from conflicting flags, permissions, fields, or timestamps.
with ambiguous as (
  select settings.*
  from public.user_settings as settings
  where not (
    (
      settings.access_active
      and 'app_access' = any(settings.permissions)
      and settings.granted_at is not null
      and settings.access_revoked_at is null
      and public.access_permissions_are_valid(settings.permissions)
      and public.access_text_array_is_canonical(settings.allowed_field_ids, 128)
      and (
        cardinality(settings.allowed_field_ids) = 0
        or 'change_allowed_fields' = any(settings.permissions)
      )
    )
    or (
      not settings.access_active
      and cardinality(settings.permissions) = 0
      and cardinality(settings.allowed_field_ids) = 0
    )
  )
)
insert into public.access_change (
  portal_id,
  target_user_id,
  actor_type,
  actor_display_name,
  change_kind,
  previous_access_version,
  new_access_version,
  before_snapshot,
  after_snapshot
)
select
  portal_id,
  user_id,
  'system',
  'Система',
  'migration_quarantine',
  1,
  2,
  jsonb_build_object(
    'accessActive', access_active,
    'permissions', to_jsonb(permissions),
    'allowedFieldCount', cardinality(allowed_field_ids),
    'allowedFieldFingerprint', encode(extensions.digest(
      convert_to(to_jsonb(allowed_field_ids)::text, 'UTF8'), 'sha256'
    ), 'hex'),
    'grantedAt', granted_at,
    'grantedByUserId', granted_by_user_id,
    'accessRevokedAt', access_revoked_at,
    'updatedAt', updated_at
  ),
  jsonb_build_object(
    'accessState', 'quarantined',
    'accessActive', false,
    'accessVersion', 2,
    'permissionMatrixVersion', 1,
    'permissions', '[]'::jsonb,
    'fieldSetId', null
  )
from ambiguous;

insert into public.access_legacy_quarantine_backup (
  portal_id, user_id, access_active, permissions, allowed_field_ids,
  granted_at, granted_by_user_id, access_revoked_at, updated_at
)
select
  settings.portal_id, settings.user_id, settings.access_active, settings.permissions,
  settings.allowed_field_ids, settings.granted_at, settings.granted_by_user_id,
  settings.access_revoked_at, settings.updated_at
from public.user_settings as settings
where exists (
  select 1 from public.access_change as change
  where change.portal_id = settings.portal_id
    and change.target_user_id = settings.user_id
    and change.change_kind = 'migration_quarantine'
    and change.command_id is null
);

insert into public.access_change_evidence (
  portal_id,
  access_change_id,
  evidence_type,
  evidence_payload
)
select
  change.portal_id,
  change.id,
  'legacy_user_settings_ambiguity',
  jsonb_build_object(
    'classification', 'quarantined',
    'reasonCode', 'LEGACY_ACCESS_STATE_AMBIGUOUS',
    'originalSummary', change.before_snapshot
  )
from public.access_change as change
where change.change_kind = 'migration_quarantine' and change.command_id is null;

alter table public.user_settings disable trigger user_settings_set_updated_at;

update public.user_settings as settings
set
  access_state = 'active',
  access_version = 1,
  permission_matrix_version = 1,
  field_set_id = public.access_field_set_for_fields(settings.portal_id, settings.allowed_field_ids)
where settings.access_active
  and 'app_access' = any(settings.permissions)
  and settings.granted_at is not null
  and settings.access_revoked_at is null
  and public.access_permissions_are_valid(settings.permissions)
  and public.access_text_array_is_canonical(settings.allowed_field_ids, 128)
  and (
    cardinality(settings.allowed_field_ids) = 0
    or 'change_allowed_fields' = any(settings.permissions)
  );

update public.user_settings as settings
set
  access_state = 'revoked',
  access_version = 1,
  permission_matrix_version = 1,
  access_revoked_at = coalesce(settings.access_revoked_at, settings.updated_at, now())
where not settings.access_active
  and cardinality(settings.permissions) = 0
  and cardinality(settings.allowed_field_ids) = 0;

update public.user_settings as settings
set
  access_state = 'quarantined',
  access_version = 2,
  permission_matrix_version = 1,
  access_active = false,
  permissions = '{}'::text[],
  allowed_field_ids = '{}'::text[],
  field_set_id = null,
  granted_at = null,
  granted_by_user_id = null,
  access_revoked_at = null
where exists (
  select 1
  from public.access_change as change
  where change.portal_id = settings.portal_id
    and change.target_user_id = settings.user_id
    and change.change_kind = 'migration_quarantine'
    and change.command_id is null
);

alter table public.user_settings enable trigger user_settings_set_updated_at;

alter table public.user_settings
  add constraint user_settings_access_state_allowed check (
    access_state in ('active', 'revoked', 'quarantined', 'review_required')
  ),
  add constraint user_settings_access_version_positive check (access_version > 0),
  add constraint user_settings_permission_matrix_version_positive check (
    permission_matrix_version > 0
  ),
  add constraint user_settings_permissions_distinct_and_valid check (
    public.access_permissions_are_valid(permissions)
  ),
  add constraint user_settings_allowed_fields_distinct_and_valid check (
    public.access_text_array_is_canonical(allowed_field_ids, 128)
    and (
      cardinality(allowed_field_ids) = 0
      or 'change_allowed_fields' = any(permissions)
    )
  ),
  add constraint user_settings_access_active_app_access_equivalence check (
    access_active = ('app_access' = any(permissions))
  ),
  add constraint user_settings_access_state_canonical check (
    (
      access_state = 'active'
      and access_active
      and granted_at is not null
      and access_revoked_at is null
      and field_set_id is not null
    )
    or (
      access_state = 'revoked'
      and not access_active
      and cardinality(permissions) = 0
      and cardinality(allowed_field_ids) = 0
      and field_set_id is null
      and access_revoked_at is not null
    )
    or (
      access_state in ('quarantined', 'review_required')
      and not access_active
      and cardinality(permissions) = 0
      and cardinality(allowed_field_ids) = 0
      and field_set_id is null
      and granted_at is null
      and granted_by_user_id is null
      and access_revoked_at is null
    )
  ),
  add foreign key (portal_id, field_set_id)
    references public.access_field_set (portal_id, id) on delete restrict;

create function public.prepare_user_settings_access_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  referenced_fields text[];
begin
  if tg_op = 'UPDATE' then
    if (
      new.access_active,
      new.permissions,
      new.allowed_field_ids,
      new.access_state,
      new.permission_matrix_version,
      new.field_set_id,
      new.granted_at,
      new.granted_by_user_id,
      new.access_revoked_at
    ) is distinct from (
      old.access_active,
      old.permissions,
      old.allowed_field_ids,
      old.access_state,
      old.permission_matrix_version,
      old.field_set_id,
      old.granted_at,
      old.granted_by_user_id,
      old.access_revoked_at
    ) then
      if new.access_version <> old.access_version + 1 then
        raise exception 'TC_ACCESS_VERSION_INCREMENT_REQUIRED' using errcode = '23514';
      end if;
    elsif new.access_version <> old.access_version then
      raise exception 'TC_ACCESS_VERSION_CHANGE_FORBIDDEN' using errcode = '23514';
    end if;
  end if;

  if new.access_active
    and 'app_access' = any(new.permissions)
    and new.granted_at is not null
    and new.access_revoked_at is null
    and public.access_permissions_are_valid(new.permissions)
    and public.access_text_array_is_canonical(new.allowed_field_ids, 128)
    and (
      cardinality(new.allowed_field_ids) = 0
      or 'change_allowed_fields' = any(new.permissions)
    ) then
    new.access_state := 'active';
    if new.field_set_id is null then
      new.field_set_id := public.access_field_set_for_fields(new.portal_id, new.allowed_field_ids);
    else
      select coalesce(array_agg(member.field_id order by member.ordinal), '{}'::text[])
      into referenced_fields
      from public.access_field_set_member as member
      where member.portal_id = new.portal_id and member.field_set_id = new.field_set_id;
      if referenced_fields is distinct from (
        select coalesce(array_agg(field_id order by field_id), '{}'::text[])
        from unnest(new.allowed_field_ids) as field_id
      ) then
        raise exception 'TC_ACCESS_FIELD_SET_MISMATCH' using errcode = '23514';
      end if;
    end if;
    return new;
  end if;

  if not new.access_active and new.access_state = 'revoked' then
    new.permissions := '{}'::text[];
    new.allowed_field_ids := '{}'::text[];
    new.field_set_id := null;
    new.access_revoked_at := coalesce(new.access_revoked_at, now());
    return new;
  end if;

  if not new.access_active and new.access_state in ('quarantined', 'review_required') then
    new.permissions := '{}'::text[];
    new.allowed_field_ids := '{}'::text[];
    new.field_set_id := null;
    new.granted_at := null;
    new.granted_by_user_id := null;
    new.access_revoked_at := null;
    return new;
  end if;

  -- New contradictory rows fail closed but remain insertable for identity/FK materialization.
  if tg_op = 'INSERT' then
    new.access_state := 'quarantined';
    new.access_active := false;
    new.permissions := '{}'::text[];
    new.allowed_field_ids := '{}'::text[];
    new.field_set_id := null;
    new.granted_at := null;
    new.granted_by_user_id := null;
    new.access_revoked_at := null;
    return new;
  end if;

  raise exception 'TC_ACCESS_STATE_INVALID' using errcode = '23514';
end;
$$;

create trigger user_settings_prepare_access_state
before insert or update of access_active, permissions, allowed_field_ids, granted_at,
  granted_by_user_id, access_revoked_at, access_state, field_set_id,
  permission_matrix_version, access_version
on public.user_settings
for each row execute function public.prepare_user_settings_access_state();

create function public.consume_access_rate_limit(
  p_portal_id text,
  p_actor_user_id text,
  p_action text,
  p_limit integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_count integer;
begin
  insert into public.access_rate_limit_bucket (
    portal_id, actor_user_id, action, bucket_started_at, request_count
  ) values (
    p_portal_id, p_actor_user_id, p_action, date_trunc('minute', now()), 1
  )
  on conflict (portal_id, actor_user_id, action, bucket_started_at)
  do update set
    request_count = public.access_rate_limit_bucket.request_count + 1,
    updated_at = now()
  returning request_count into new_count;
  if new_count > p_limit then
    raise exception 'TC_ACCESS_RATE_LIMITED' using errcode = 'P0001';
  end if;
end;
$$;

create function public.save_access_draft(
  p_portal_id text,
  p_manager_user_id text,
  p_expected_revision bigint,
  p_draft_payload jsonb
)
returns public.access_management_draft
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_draft public.access_management_draft;
  saved_draft public.access_management_draft;
begin
  if p_expected_revision < 0
    or jsonb_typeof(p_draft_payload) <> 'object'
    or octet_length(p_draft_payload::text) > 131072 then
    raise exception 'TC_ACCESS_DRAFT_INVALID' using errcode = '22023';
  end if;
  perform public.consume_access_rate_limit(p_portal_id, p_manager_user_id, 'draft_save', 60);

  select * into current_draft
  from public.access_management_draft
  where portal_id = p_portal_id and manager_user_id = p_manager_user_id
  for update;
  if not found then
    if p_expected_revision <> 0 then
      raise exception 'TC_ACCESS_DRAFT_REVISION_CONFLICT' using errcode = '40001';
    end if;
    insert into public.access_management_draft (
      portal_id, manager_user_id, revision, status, draft_payload
    ) values (
      p_portal_id, p_manager_user_id, 1, 'editing', p_draft_payload
    ) returning * into saved_draft;
    return saved_draft;
  end if;

  if p_expected_revision = 0
    and (current_draft.status in ('submitted', 'expired') or current_draft.expires_at <= now()) then
    update public.access_management_draft
    set
      revision = revision + 1,
      status = 'editing',
      draft_payload = p_draft_payload,
      updated_at = now(),
      expires_at = now() + interval '24 hours'
    where portal_id = p_portal_id and id = current_draft.id
    returning * into saved_draft;
    return saved_draft;
  end if;

  -- A lost HTTP response must be safely retryable with the original revision zero request.
  if p_expected_revision = 0
    and current_draft.status = 'editing'
    and current_draft.draft_payload = p_draft_payload
    and current_draft.expires_at > now() then
    return current_draft;
  end if;

  -- If preflight creation succeeded but its response was lost, the same intent starts a fresh
  -- revision and makes the previous short-lived result unusable.
  if p_expected_revision = 0
    and current_draft.status = 'preflighted'
    and current_draft.draft_payload = p_draft_payload
    and current_draft.expires_at > now() then
    update public.access_preflight
    set status = 'stale'
    where portal_id = p_portal_id and draft_id = current_draft.id and status = 'valid';
    update public.access_management_draft
    set revision = revision + 1, status = 'editing', updated_at = now(),
        expires_at = now() + interval '24 hours'
    where portal_id = p_portal_id and id = current_draft.id
    returning * into saved_draft;
    return saved_draft;
  end if;

  if current_draft.revision <> p_expected_revision
    or current_draft.status not in ('editing', 'preflighted')
    or current_draft.expires_at <= now() then
    raise exception 'TC_ACCESS_DRAFT_REVISION_CONFLICT' using errcode = '40001';
  end if;

  if current_draft.status = 'preflighted' then
    update public.access_preflight
    set status = 'stale'
    where portal_id = p_portal_id
      and draft_id = current_draft.id
      and status = 'valid';
  end if;

  update public.access_management_draft
  set
    revision = revision + 1,
    status = 'editing',
    draft_payload = p_draft_payload,
    updated_at = now(),
    expires_at = now() + interval '24 hours'
  where portal_id = p_portal_id and id = current_draft.id
  returning * into saved_draft;
  return saved_draft;
end;
$$;

create function public.consume_access_management_read_limit(
  p_portal_id text,
  p_actor_user_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.consume_access_rate_limit(
    p_portal_id,
    p_actor_user_id,
    'filtered_employee_search',
    12
  );
end;
$$;

create function public.create_access_preflight(
  p_portal_id text,
  p_draft_id uuid,
  p_expected_draft_revision bigint,
  p_manager_user_id text,
  p_manager_access_version bigint,
  p_permission_matrix_version integer,
  p_mode text,
  p_request_fingerprint text,
  p_summary jsonb,
  p_targets jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft_record public.access_management_draft;
  created_preflight public.access_preflight;
  target_item jsonb;
  expected_version bigint;
begin
  if jsonb_typeof(p_targets) <> 'array'
    or jsonb_array_length(p_targets) not between 1 and 100
    or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'TC_ACCESS_PREFLIGHT_INVALID' using errcode = '22023';
  end if;
  perform public.consume_access_rate_limit(p_portal_id, p_manager_user_id, 'preflight_create', 30);
  select * into draft_record
  from public.access_management_draft
  where portal_id = p_portal_id and id = p_draft_id
  for update;
  if not found
    or draft_record.manager_user_id <> p_manager_user_id
    or draft_record.revision <> p_expected_draft_revision
    or draft_record.status <> 'editing'
    or draft_record.expires_at <= now() then
    raise exception 'TC_ACCESS_DRAFT_REVISION_CONFLICT' using errcode = '40001';
  end if;

  insert into public.access_preflight (
    portal_id, draft_id, manager_user_id, draft_revision, manager_access_version,
    permission_matrix_version, mode, request_fingerprint, summary, expires_at
  ) values (
    p_portal_id, p_draft_id, p_manager_user_id, p_expected_draft_revision,
    p_manager_access_version, p_permission_matrix_version, p_mode, p_request_fingerprint,
    p_summary, now() + interval '10 minutes'
  ) returning * into created_preflight;

  for target_item in select value from jsonb_array_elements(p_targets)
  loop
    expected_version := nullif(target_item ->> 'expectedAccessVersion', '')::bigint;
    insert into public.access_preflight_target (
      portal_id, preflight_id, target_user_id, target_display_name, target_department_name,
      target_is_portal_admin, target_is_manager, expected_access_version,
      expected_access_state, expected_permission_count,
      desired_access_state, desired_permissions, desired_field_set_id,
      state, reason_code, issue_message, requested_delta, automatic_delta, redacted_delta
    ) values (
      p_portal_id,
      created_preflight.id,
      target_item ->> 'targetUserId',
      target_item ->> 'targetDisplayName',
      target_item ->> 'targetDepartmentName',
      coalesce((target_item ->> 'targetIsPortalAdmin')::boolean, false),
      coalesce((target_item ->> 'targetIsManager')::boolean, false),
      expected_version,
      target_item ->> 'expectedAccessState',
      (target_item ->> 'expectedPermissionCount')::integer,
      target_item ->> 'desiredAccessState',
      array(select jsonb_array_elements_text(target_item -> 'desiredPermissions')),
      nullif(target_item ->> 'desiredFieldSetId', '')::uuid,
      target_item ->> 'state',
      target_item ->> 'reasonCode',
      target_item ->> 'issueMessage',
      coalesce(target_item -> 'requestedDelta', '{}'::jsonb),
      coalesce(target_item -> 'automaticDelta', '{}'::jsonb),
      coalesce(target_item -> 'redactedDelta', '{}'::jsonb)
    );
  end loop;

  update public.access_management_draft
  set status = 'preflighted', updated_at = now()
  where portal_id = p_portal_id and id = p_draft_id;
  return jsonb_build_object(
    'preflight', to_jsonb(created_preflight),
    'targets', (
      select jsonb_agg(to_jsonb(target) order by target.target_user_id)
      from public.access_preflight_target as target
      where target.portal_id = p_portal_id and target.preflight_id = created_preflight.id
    )
  );
end;
$$;

create function public.accept_access_command(
  p_portal_id text,
  p_command_id uuid,
  p_idempotency_key text,
  p_preflight_id uuid,
  p_actor_user_id text,
  p_actor_display_name text,
  p_actor_is_portal_admin boolean,
  p_confirmation_id uuid,
  p_correlation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  preflight_record public.access_preflight;
  command_record public.access_command;
  existing_command public.access_command;
  total_targets integer;
  ready_targets integer;
begin
  select * into existing_command
  from public.access_command
  where portal_id = p_portal_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_command.id <> p_command_id
      or existing_command.preflight_id <> p_preflight_id
      or existing_command.actor_user_id <> p_actor_user_id
      or existing_command.actor_is_portal_admin <> p_actor_is_portal_admin
      or existing_command.confirmation_id is distinct from p_confirmation_id then
      raise exception 'TC_ACCESS_COMMAND_CONFLICT' using errcode = 'P0001';
    end if;
    return jsonb_build_object('disposition', 'idempotent', 'command', to_jsonb(existing_command));
  end if;
  perform public.consume_access_rate_limit(p_portal_id, p_actor_user_id, 'command_accept', 30);
  select * into preflight_record
  from public.access_preflight
  where portal_id = p_portal_id and id = p_preflight_id
  for update;
  if found and preflight_record.status = 'consumed' then
    select * into existing_command
    from public.access_command
    where portal_id = p_portal_id and idempotency_key = p_idempotency_key;
    if found
      and existing_command.id = p_command_id
      and existing_command.preflight_id = p_preflight_id
      and existing_command.actor_user_id = p_actor_user_id
      and existing_command.actor_is_portal_admin = p_actor_is_portal_admin
      and existing_command.confirmation_id is not distinct from p_confirmation_id then
      return jsonb_build_object('disposition', 'idempotent', 'command', to_jsonb(existing_command));
    end if;
    raise exception 'TC_ACCESS_PREFLIGHT_STALE' using errcode = 'P0001';
  end if;
  if not found
    or preflight_record.status <> 'valid'
    or preflight_record.expires_at <= now()
    or preflight_record.manager_user_id <> p_actor_user_id then
    raise exception 'TC_ACCESS_PREFLIGHT_STALE' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.access_management_draft as draft
    where draft.portal_id = p_portal_id
      and draft.id = preflight_record.draft_id
      and draft.revision = preflight_record.draft_revision
      and draft.status = 'preflighted'
  ) then
    raise exception 'TC_ACCESS_PREFLIGHT_STALE' using errcode = 'P0001';
  end if;

  select count(*)::integer,
    count(*) filter (where state = 'ready')::integer
  into total_targets, ready_targets
  from public.access_preflight_target
  where portal_id = p_portal_id and preflight_id = p_preflight_id;

  insert into public.access_command (
    id, portal_id, preflight_id, actor_user_id, actor_display_name,
    actor_is_portal_admin, total_count, ready_count, excluded_count,
    conflict_count, no_change_count, idempotency_key, confirmation_id, correlation_id
  )
  select
    p_command_id, p_portal_id, p_preflight_id, p_actor_user_id, p_actor_display_name,
    p_actor_is_portal_admin, total_targets, ready_targets,
    count(*) filter (where state = 'excluded')::integer,
    count(*) filter (where state = 'conflict')::integer,
    count(*) filter (where state = 'no_change')::integer,
    p_idempotency_key, p_confirmation_id, p_correlation_id
  from public.access_preflight_target
  where portal_id = p_portal_id and preflight_id = p_preflight_id
  on conflict (portal_id, idempotency_key) do nothing
  returning * into command_record;

  if not found then
    select * into existing_command
    from public.access_command
    where portal_id = p_portal_id and idempotency_key = p_idempotency_key;
    if existing_command.id <> p_command_id
      or existing_command.preflight_id <> p_preflight_id
      or existing_command.actor_user_id <> p_actor_user_id
      or existing_command.actor_is_portal_admin <> p_actor_is_portal_admin
      or existing_command.confirmation_id is distinct from p_confirmation_id then
      raise exception 'TC_ACCESS_COMMAND_CONFLICT' using errcode = 'P0001';
    end if;
    return jsonb_build_object('disposition', 'idempotent', 'command', to_jsonb(existing_command));
  end if;

  insert into public.access_command_target (
    portal_id, command_id, target_user_id, target_display_name, target_is_portal_admin,
    target_is_manager, expected_access_version, desired_access_state, desired_permissions,
    desired_field_set_id, request_fingerprint, state, reason_code,
    requested_delta, automatic_delta, redacted_delta,
    before_access_version, after_access_version, completed_at
  )
  select
    target.portal_id,
    command_record.id,
    target.target_user_id,
    target.target_display_name,
    target.target_is_portal_admin,
    target.target_is_manager,
    target.expected_access_version,
    target.desired_access_state,
    target.desired_permissions,
    target.desired_field_set_id,
    encode(extensions.digest(convert_to(jsonb_build_object(
      'targetUserId', target.target_user_id,
      'expectedAccessVersion', target.expected_access_version,
      'desiredAccessState', target.desired_access_state,
      'desiredPermissions', to_jsonb(target.desired_permissions),
      'desiredFieldSetId', target.desired_field_set_id
    )::text, 'UTF8'), 'sha256'), 'hex'),
    target.state,
    target.reason_code,
    target.requested_delta,
    target.automatic_delta,
    target.redacted_delta,
    target.expected_access_version,
    case when target.state = 'no_change' then target.expected_access_version else null end,
    case when target.state in ('excluded', 'conflict', 'no_change') then now() else null end
  from public.access_preflight_target as target
  where target.portal_id = p_portal_id and target.preflight_id = p_preflight_id;

  if ready_targets > 0 then
    insert into public.access_command_dispatch_outbox (portal_id, command_id)
    values (p_portal_id, command_record.id)
    on conflict (portal_id, command_id) do nothing;
  end if;

  update public.access_preflight
  set status = 'consumed', consumed_at = now()
  where portal_id = p_portal_id and id = p_preflight_id;
  update public.access_management_draft
  set status = 'submitted', updated_at = now()
  where portal_id = p_portal_id and id = preflight_record.draft_id;

  if ready_targets = 0 then
    update public.access_command
    set
      state = case
        when command_record.no_change_count > 0
          and command_record.excluded_count = 0
          and command_record.conflict_count = 0 then 'no_change'
        when command_record.no_change_count > 0 then 'partially_succeeded'
        else 'failed'
      end,
      state_version = 2,
      completed_at = now()
    where portal_id = p_portal_id and id = p_command_id
    returning * into command_record;
  end if;
  return jsonb_build_object('disposition', 'accepted', 'command', to_jsonb(command_record));
end;
$$;

create function public.claim_access_command(
  p_portal_id text,
  p_command_id uuid,
  p_expected_state_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  command_record public.access_command;
begin
  update public.access_command
  set state = 'validating', state_version = state_version + 1, started_at = now()
  where portal_id = p_portal_id
    and id = p_command_id
    and state = 'accepted'
    and state_version = p_expected_state_version
  returning * into command_record;
  if not found then
    select * into command_record from public.access_command
    where portal_id = p_portal_id and id = p_command_id;
    return jsonb_build_object('disposition', 'stale', 'command', to_jsonb(command_record));
  end if;
  return jsonb_build_object('disposition', 'claimed', 'command', to_jsonb(command_record));
end;
$$;

create function public.read_access_command(
  p_portal_id text,
  p_command_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'command', to_jsonb(command),
    'targets', coalesce((
      select jsonb_agg(to_jsonb(target) order by target.target_user_id)
      from public.access_command_target as target
      where target.portal_id = p_portal_id and target.command_id = p_command_id
    ), '[]'::jsonb)
  )
  from public.access_command as command
  where command.portal_id = p_portal_id and command.id = p_command_id;
$$;

create function public.apply_access_command_target(
  p_portal_id text,
  p_command_id uuid,
  p_expected_state_version bigint,
  p_target_user_id text,
  p_actor_is_active boolean,
  p_actor_is_portal_admin boolean,
  p_actor_is_manager boolean,
  p_target_is_active boolean,
  p_target_is_manager boolean,
  p_target_is_portal_admin boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  command_record public.access_command;
  preflight_record public.access_preflight;
  target_record public.access_command_target;
  actor_settings public.user_settings;
  settings_record public.user_settings;
  desired_fields text[];
  previous_fields text[] := '{}'::text[];
  before_state jsonb;
  after_state jsonb;
  change_record public.access_change;
  audit_result jsonb;
  field_audit_result jsonb;
  audit_action text;
  notification_kind text;
  business_reason jsonb;
  settings_exists boolean;
begin
  select * into command_record from public.access_command
  where portal_id = p_portal_id and id = p_command_id for update;
  if not found or command_record.state not in ('validating', 'in_progress')
    or command_record.state_version <> p_expected_state_version then
    return jsonb_build_object('disposition', 'stale', 'command', to_jsonb(command_record));
  end if;
  select * into target_record from public.access_command_target
  where portal_id = p_portal_id and command_id = p_command_id and target_user_id = p_target_user_id
  for update;
  if not found then
    raise exception 'TC_ACCESS_COMMAND_TARGET_NOT_FOUND' using errcode = 'P0001';
  end if;
  if target_record.state = 'applied' then
    return jsonb_build_object('disposition', 'idempotent', 'target', to_jsonb(target_record));
  end if;
  if target_record.state <> 'ready' then
    return jsonb_build_object('disposition', target_record.state, 'target', to_jsonb(target_record));
  end if;
  if not p_actor_is_active
    or p_actor_is_portal_admin <> command_record.actor_is_portal_admin then
    update public.access_command_target set state = 'failed', reason_code = 'ACTOR_ACCESS_CHANGED', completed_at = now()
    where portal_id = p_portal_id and command_id = p_command_id and target_user_id = p_target_user_id
    returning * into target_record;
    update public.access_command set failed_count = failed_count + 1,
      ready_count = greatest(ready_count - 1, 0), state = 'in_progress',
      state_version = state_version + 1 where portal_id = p_portal_id and id = p_command_id
      returning * into command_record;
    return jsonb_build_object('disposition', 'failed', 'target', to_jsonb(target_record), 'command', to_jsonb(command_record));
  end if;
  if not command_record.actor_is_portal_admin and not p_actor_is_manager then
    update public.access_command_target set state = 'failed', reason_code = 'MANAGER_STATUS_REQUIRED', completed_at = now()
    where portal_id = p_portal_id and command_id = p_command_id and target_user_id = p_target_user_id
    returning * into target_record;
    update public.access_command set failed_count = failed_count + 1,
      ready_count = greatest(ready_count - 1, 0), state = 'in_progress',
      state_version = state_version + 1 where portal_id = p_portal_id and id = p_command_id
      returning * into command_record;
    return jsonb_build_object('disposition', 'failed', 'target', to_jsonb(target_record), 'command', to_jsonb(command_record));
  end if;
  if p_target_is_active is not true then
    update public.access_command_target set state = 'failed',
      reason_code = case when p_target_is_active is null
        then 'EMPLOYMENT_STATE_UNKNOWN' else 'EMPLOYEE_INACTIVE' end,
      completed_at = now()
    where portal_id = p_portal_id and command_id = p_command_id and target_user_id = p_target_user_id
    returning * into target_record;
    update public.access_command set failed_count = failed_count + 1,
      ready_count = greatest(ready_count - 1, 0), state = 'in_progress',
      state_version = state_version + 1 where portal_id = p_portal_id and id = p_command_id
      returning * into command_record;
    return jsonb_build_object('disposition', 'failed', 'target', to_jsonb(target_record), 'command', to_jsonb(command_record));
  end if;
  if 'manage_access' = any(target_record.desired_permissions) and not p_target_is_manager then
    update public.access_command_target set state = 'failed', reason_code = 'MANAGER_STATUS_REQUIRED', completed_at = now()
    where portal_id = p_portal_id and command_id = p_command_id and target_user_id = p_target_user_id
    returning * into target_record;
    update public.access_command set failed_count = failed_count + 1,
      ready_count = greatest(ready_count - 1, 0), state = 'in_progress',
      state_version = state_version + 1 where portal_id = p_portal_id and id = p_command_id
      returning * into command_record;
    return jsonb_build_object('disposition', 'failed', 'target', to_jsonb(target_record), 'command', to_jsonb(command_record));
  end if;
  if p_target_is_portal_admin or target_record.target_is_portal_admin then
    update public.access_command_target set state = 'failed', reason_code = 'ADMIN_ACCESS_IMMUTABLE', completed_at = now()
    where portal_id = p_portal_id and command_id = p_command_id and target_user_id = p_target_user_id
    returning * into target_record;
    update public.access_command set failed_count = failed_count + 1,
      ready_count = greatest(ready_count - 1, 0), state = 'in_progress',
      state_version = state_version + 1 where portal_id = p_portal_id and id = p_command_id
      returning * into command_record;
    return jsonb_build_object('disposition', 'failed', 'target', to_jsonb(target_record), 'command', to_jsonb(command_record));
  end if;
  if command_record.actor_user_id = p_target_user_id then
    update public.access_command_target set state = 'failed', reason_code = 'ACTOR_ACCESS_CHANGED', completed_at = now()
    where portal_id = p_portal_id and command_id = p_command_id and target_user_id = p_target_user_id
    returning * into target_record;
    update public.access_command set failed_count = failed_count + 1,
      ready_count = greatest(ready_count - 1, 0), state = 'in_progress',
      state_version = state_version + 1 where portal_id = p_portal_id and id = p_command_id
      returning * into command_record;
    return jsonb_build_object('disposition', 'failed', 'target', to_jsonb(target_record), 'command', to_jsonb(command_record));
  end if;

  select * into preflight_record from public.access_preflight
  where portal_id = p_portal_id and id = command_record.preflight_id;
  business_reason := preflight_record.summary -> 'reason';
  -- Lock actor and target settings in a stable order so authority cannot change after it is
  -- checked, while reciprocal manager operations cannot deadlock each other.
  perform 1
  from public.user_settings
  where portal_id = p_portal_id
    and user_id in (command_record.actor_user_id, p_target_user_id)
  order by user_id
  for update;
  if not command_record.actor_is_portal_admin then
    select * into actor_settings from public.user_settings
    where portal_id = p_portal_id and user_id = command_record.actor_user_id;
    if not found or actor_settings.access_state <> 'active'
      or actor_settings.access_version <> preflight_record.manager_access_version
      or not ('manage_access' = any(actor_settings.permissions)) then
      update public.access_command_target set state = 'failed', reason_code = 'ACTOR_ACCESS_CHANGED', completed_at = now()
      where portal_id = p_portal_id and command_id = p_command_id and target_user_id = p_target_user_id
      returning * into target_record;
      update public.access_command set failed_count = failed_count + 1,
        ready_count = greatest(ready_count - 1, 0), state = 'in_progress',
        state_version = state_version + 1 where portal_id = p_portal_id and id = p_command_id
        returning * into command_record;
      return jsonb_build_object('disposition', 'failed', 'target', to_jsonb(target_record), 'command', to_jsonb(command_record));
    end if;
  end if;

  desired_fields := '{}'::text[];
  if target_record.desired_field_set_id is not null then
    select coalesce(array_agg(member.field_id order by member.ordinal), '{}'::text[])
    into desired_fields from public.access_field_set_member as member
    where member.portal_id = p_portal_id and member.field_set_id = target_record.desired_field_set_id;
  end if;
  select * into settings_record from public.user_settings
  where portal_id = p_portal_id and user_id = p_target_user_id for update;
  settings_exists := found;
  if (not settings_exists and target_record.expected_access_version is not null)
    or (settings_exists and settings_record.access_version is distinct from target_record.expected_access_version) then
    update public.access_command_target set state = 'conflict', reason_code = 'TARGET_ACCESS_CHANGED', completed_at = now()
    where portal_id = p_portal_id and command_id = p_command_id and target_user_id = p_target_user_id
    returning * into target_record;
    update public.access_command set conflict_count = conflict_count + 1,
      ready_count = greatest(ready_count - 1, 0), state = 'in_progress',
      state_version = state_version + 1 where portal_id = p_portal_id and id = p_command_id
      returning * into command_record;
    return jsonb_build_object('disposition', 'conflict', 'target', to_jsonb(target_record), 'command', to_jsonb(command_record));
  end if;

  if not command_record.actor_is_portal_admin
    and not ('manage_access' = any(coalesce(settings_record.permissions, '{}'::text[])))
    and 'manage_access' = any(target_record.desired_permissions) then
    update public.access_command_target set state = 'failed', reason_code = 'PERMISSION_NOT_DELEGABLE', completed_at = now()
    where portal_id = p_portal_id and command_id = p_command_id and target_user_id = p_target_user_id
    returning * into target_record;
    update public.access_command set failed_count = failed_count + 1,
      ready_count = greatest(ready_count - 1, 0), state = 'in_progress',
      state_version = state_version + 1 where portal_id = p_portal_id and id = p_command_id
      returning * into command_record;
    return jsonb_build_object('disposition', 'failed', 'target', to_jsonb(target_record), 'command', to_jsonb(command_record));
  end if;

  if not command_record.actor_is_portal_admin and (
    exists (
      select 1
      from (
        select permission from unnest(target_record.desired_permissions) as permission
        except
        select permission from unnest(coalesce(settings_record.permissions, '{}'::text[])) as permission
      ) as added
      where not (added.permission = any(actor_settings.permissions))
    )
    or exists (
      select 1
      from (
        select permission from unnest(coalesce(settings_record.permissions, '{}'::text[])) as permission
        except
        select permission from unnest(target_record.desired_permissions) as permission
      ) as removed
      where not (removed.permission = any(actor_settings.permissions))
    )
  ) then
    update public.access_command_target set state = 'failed', reason_code = 'PERMISSION_NOT_DELEGABLE', completed_at = now()
    where portal_id = p_portal_id and command_id = p_command_id and target_user_id = p_target_user_id
    returning * into target_record;
    update public.access_command set failed_count = failed_count + 1,
      ready_count = greatest(ready_count - 1, 0), state = 'in_progress',
      state_version = state_version + 1 where portal_id = p_portal_id and id = p_command_id
      returning * into command_record;
    return jsonb_build_object('disposition', 'failed', 'target', to_jsonb(target_record), 'command', to_jsonb(command_record));
  end if;
  if not command_record.actor_is_portal_admin and (
    exists (
      select 1
      from (
        select field_id from unnest(desired_fields) as field_id
        except
        select field_id from unnest(coalesce(settings_record.allowed_field_ids, '{}'::text[])) as field_id
      ) as added
      where not (added.field_id = any(actor_settings.allowed_field_ids))
    )
    or exists (
      select 1
      from (
        select field_id from unnest(coalesce(settings_record.allowed_field_ids, '{}'::text[])) as field_id
        except
        select field_id from unnest(desired_fields) as field_id
      ) as removed
      where not (removed.field_id = any(actor_settings.allowed_field_ids))
    )
  ) then
    update public.access_command_target set state = 'failed', reason_code = 'FIELD_SCOPE_NOT_DELEGABLE', completed_at = now()
    where portal_id = p_portal_id and command_id = p_command_id and target_user_id = p_target_user_id
    returning * into target_record;
    update public.access_command set failed_count = failed_count + 1,
      ready_count = greatest(ready_count - 1, 0), state = 'in_progress',
      state_version = state_version + 1 where portal_id = p_portal_id and id = p_command_id
      returning * into command_record;
    return jsonb_build_object('disposition', 'failed', 'target', to_jsonb(target_record), 'command', to_jsonb(command_record));
  end if;

  if not settings_exists then
    insert into public.user_settings (
      portal_id, user_id, display_name, access_active, permissions, allowed_field_ids,
      granted_at, granted_by_user_id, access_state, access_version,
      permission_matrix_version, field_set_id
    ) values (
      p_portal_id, p_target_user_id, target_record.target_display_name,
      target_record.desired_access_state = 'active', target_record.desired_permissions,
      desired_fields, case when target_record.desired_access_state = 'active' then now() end,
      case when target_record.desired_access_state = 'active'
        and not command_record.actor_is_portal_admin then command_record.actor_user_id end,
      target_record.desired_access_state, 1, preflight_record.permission_matrix_version,
      target_record.desired_field_set_id
    ) returning * into settings_record;
    target_record.before_access_version := null;
  else
    before_state := jsonb_build_object(
      'accessState', settings_record.access_state,
      'accessVersion', settings_record.access_version,
      'permissionMatrixVersion', settings_record.permission_matrix_version,
      'permissions', to_jsonb(settings_record.permissions),
      'fieldSetId', settings_record.field_set_id
    );
    previous_fields := settings_record.allowed_field_ids;
    update public.user_settings set
      access_active = target_record.desired_access_state = 'active',
      access_state = target_record.desired_access_state,
      access_version = access_version + 1,
      permission_matrix_version = preflight_record.permission_matrix_version,
      permissions = target_record.desired_permissions,
      allowed_field_ids = desired_fields,
      field_set_id = target_record.desired_field_set_id,
      granted_at = case
        when target_record.desired_access_state = 'active' and settings_record.access_state = 'active'
          then settings_record.granted_at
        when target_record.desired_access_state = 'active' then now()
        else settings_record.granted_at
      end,
      granted_by_user_id = case
        when target_record.desired_access_state = 'active' and settings_record.access_state = 'active'
          then settings_record.granted_by_user_id
        when target_record.desired_access_state = 'active' and not command_record.actor_is_portal_admin
          then command_record.actor_user_id
        else null
      end,
      access_revoked_at = case when target_record.desired_access_state = 'revoked' then now() else null end
    where portal_id = p_portal_id and user_id = p_target_user_id returning * into settings_record;
  end if;

  before_state := coalesce(before_state, jsonb_build_object('accessState', 'revoked', 'accessVersion', null, 'permissions', '[]'::jsonb, 'fieldSetId', null));
  after_state := jsonb_build_object(
    'accessState', settings_record.access_state,
    'accessVersion', settings_record.access_version,
    'permissionMatrixVersion', settings_record.permission_matrix_version,
    'permissions', to_jsonb(settings_record.permissions),
    'fieldSetId', settings_record.field_set_id
  );
  audit_action := case when target_record.desired_access_state = 'revoked' then 'access_revoke'
    when before_state ->> 'accessState' <> 'active' then 'access_grant' else 'access_update' end;
  notification_kind := case audit_action when 'access_grant' then 'access_granted'
    when 'access_revoke' then 'access_revoked' else 'access_updated' end;

  audit_result := public.append_audit_event(
    p_portal_id, now(), audit_action, 'user', command_record.actor_user_id,
    command_record.actor_display_name, null, 'access', p_target_user_id,
    settings_record.display_name, '[]'::jsonb, 'success', command_record.correlation_id,
    p_command_id::text, 'target:' || p_target_user_id,
    jsonb_build_object(
      'kind', 'access',
      'version', 2,
      'previousAccessVersion', target_record.before_access_version,
      'newAccessVersion', settings_record.access_version,
      'accessState', settings_record.access_state,
      'addedPermissions', target_record.redacted_delta -> 'permissions' -> 'added',
      'removedPermissions', target_record.redacted_delta -> 'permissions' -> 'removed',
      'addedFieldCount', coalesce((target_record.redacted_delta -> 'fields' ->> 'addedCount')::integer, 0),
      'removedFieldCount', coalesce((target_record.redacted_delta -> 'fields' ->> 'removedCount')::integer, 0),
      'reasonCode', business_reason ->> 'code'
    )
  );
  if exists (
      select field_id from unnest(previous_fields) as field_id
      except
      select field_id from unnest(desired_fields) as field_id
    ) or exists (
      select field_id from unnest(desired_fields) as field_id
      except
      select field_id from unnest(previous_fields) as field_id
    ) then
    field_audit_result := public.append_audit_event(
      p_portal_id, now(), 'allowed_fields_update', 'user', command_record.actor_user_id,
      command_record.actor_display_name, null, 'settings', p_target_user_id,
      settings_record.display_name, '[]'::jsonb, 'success', command_record.correlation_id,
      p_command_id::text, 'target-fields:' || p_target_user_id,
      jsonb_build_object(
        'kind', 'access',
        'version', 2,
        'previousAccessVersion', target_record.before_access_version,
        'newAccessVersion', settings_record.access_version,
        'accessState', settings_record.access_state,
        'addedPermissions', '[]'::jsonb,
        'removedPermissions', '[]'::jsonb,
        'addedFieldCount', coalesce((target_record.redacted_delta -> 'fields' ->> 'addedCount')::integer, 0),
        'removedFieldCount', coalesce((target_record.redacted_delta -> 'fields' ->> 'removedCount')::integer, 0),
        'reasonCode', business_reason ->> 'code'
      )
    );
  end if;

  insert into public.access_change (
    portal_id, command_id, target_user_id, actor_type, actor_user_id, actor_display_name,
    change_kind, previous_access_version, new_access_version, before_snapshot, after_snapshot,
    audit_event_id, field_audit_event_id, correlation_id
  ) values (
    p_portal_id, p_command_id, p_target_user_id, 'user', command_record.actor_user_id,
    command_record.actor_display_name,
    case audit_action when 'access_grant' then 'grant' when 'access_revoke' then 'revoke' else 'update' end,
    target_record.before_access_version,
    settings_record.access_version, before_state, after_state,
    (audit_result -> 'event' ->> 'id')::uuid,
    nullif(field_audit_result -> 'event' ->> 'id', '')::uuid,
    command_record.correlation_id
  ) returning * into change_record;

  insert into public.notification_outbox (
    portal_id, access_change_id, recipient_user_id, notification_kind, payload
  ) values (
    p_portal_id, change_record.id, p_target_user_id, notification_kind,
    jsonb_build_object('accessChangeId', change_record.id, 'accessVersion', settings_record.access_version,
      'accessState', settings_record.access_state, 'correlationId', command_record.correlation_id)
  );
  update public.access_command_target set state = 'applied', access_change_id = change_record.id,
    before_access_version = target_record.before_access_version,
    after_access_version = settings_record.access_version, notification_state = 'queued', completed_at = now()
  where portal_id = p_portal_id and command_id = p_command_id and target_user_id = p_target_user_id
  returning * into target_record;
  update public.access_command set applied_count = applied_count + 1,
    ready_count = greatest(ready_count - 1, 0), state = 'in_progress',
    state_version = state_version + 1 where portal_id = p_portal_id and id = p_command_id
    returning * into command_record;
  return jsonb_build_object('disposition', 'applied', 'target', to_jsonb(target_record),
    'command', to_jsonb(command_record), 'userSettings', to_jsonb(settings_record));
end;
$$;

create function public.fail_access_command(
  p_portal_id text,
  p_command_id uuid,
  p_expected_state_version bigint,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  command_record public.access_command;
  failed_targets integer;
begin
  if p_reason_code not in (
    'ACTOR_ACCESS_CHANGED', 'PERMISSION_CATALOG_CHANGED', 'INTERNAL_ERROR'
  ) then
    raise exception 'TC_ACCESS_FAILURE_REASON_INVALID' using errcode = '22023';
  end if;
  select * into command_record from public.access_command
  where portal_id = p_portal_id and id = p_command_id for update;
  if not found
    or command_record.state not in ('validating', 'in_progress')
    or command_record.state_version <> p_expected_state_version then
    return jsonb_build_object('disposition', 'stale', 'command', to_jsonb(command_record));
  end if;
  update public.access_command_target
  set state = 'failed', reason_code = p_reason_code, completed_at = now()
  where portal_id = p_portal_id and command_id = p_command_id and state = 'ready';
  get diagnostics failed_targets = row_count;
  update public.access_command
  set state = case when applied_count > 0 then 'partially_succeeded' else 'failed' end,
      state_version = state_version + 1,
      ready_count = greatest(ready_count - failed_targets, 0),
      failed_count = failed_count + failed_targets,
      completed_at = now()
  where portal_id = p_portal_id and id = p_command_id
  returning * into command_record;
  return jsonb_build_object('disposition', 'failed', 'command', to_jsonb(command_record));
end;
$$;

create function public.finalize_access_command(
  p_portal_id text,
  p_command_id uuid,
  p_expected_state_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  command_record public.access_command;
  pending_count integer;
  terminal_state text;
begin
  select * into command_record from public.access_command
  where portal_id = p_portal_id and id = p_command_id for update;
  if not found or command_record.state not in ('validating', 'in_progress')
    or command_record.state_version <> p_expected_state_version then
    return jsonb_build_object('disposition', 'stale', 'command', to_jsonb(command_record));
  end if;
  select count(*)::integer into pending_count from public.access_command_target
  where portal_id = p_portal_id and command_id = p_command_id
    and state in ('ready', 'applying');
  if pending_count > 0 then
    return jsonb_build_object('disposition', 'pending', 'command', to_jsonb(command_record));
  end if;
  terminal_state := case
    when command_record.applied_count > 0
      and command_record.failed_count = 0
      and command_record.conflict_count = 0
      and command_record.excluded_count = 0 then 'succeeded'
    when command_record.applied_count > 0 then 'partially_succeeded'
    when command_record.no_change_count > 0
      and command_record.failed_count = 0
      and command_record.conflict_count = 0
      and command_record.excluded_count = 0 then 'no_change'
    else 'failed'
  end;
  update public.access_command set state = terminal_state, state_version = state_version + 1,
    completed_at = now() where portal_id = p_portal_id and id = p_command_id
  returning * into command_record;
  return jsonb_build_object('disposition', 'finalized', 'command', to_jsonb(command_record));
end;
$$;

create index access_management_draft_by_expiry on public.access_management_draft (expires_at);
create index access_preflight_by_expiry on public.access_preflight (portal_id, status, expires_at);
create index access_command_by_actor_time on public.access_command (portal_id, actor_user_id, accepted_at desc);
create index access_command_dispatch_pending
  on public.access_command_dispatch_outbox (status, available_at, created_at);
create index access_change_by_target_time on public.access_change (portal_id, target_user_id, changed_at desc);
create index notification_outbox_delivery on public.notification_outbox (status, available_at, created_at);
create index access_rate_limit_bucket_expiry on public.access_rate_limit_bucket (bucket_started_at);

alter table public.access_field_set enable row level security;
alter table public.access_field_set_member enable row level security;
alter table public.access_management_draft enable row level security;
alter table public.access_preflight enable row level security;
alter table public.access_preflight_target enable row level security;
alter table public.access_command enable row level security;
alter table public.access_command_target enable row level security;
alter table public.access_command_dispatch_outbox enable row level security;
alter table public.access_change enable row level security;
alter table public.access_change_evidence enable row level security;
alter table public.access_legacy_quarantine_backup enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.access_rate_limit_bucket enable row level security;

revoke all on table public.access_field_set from anon, authenticated, service_role;
revoke all on table public.access_field_set_member from anon, authenticated, service_role;
revoke all on table public.access_management_draft from anon, authenticated, service_role;
revoke all on table public.access_preflight from anon, authenticated, service_role;
revoke all on table public.access_preflight_target from anon, authenticated, service_role;
revoke all on table public.access_command from anon, authenticated, service_role;
revoke all on table public.access_command_target from anon, authenticated, service_role;
revoke all on table public.access_command_dispatch_outbox from anon, authenticated, service_role;
revoke all on table public.access_change from anon, authenticated, service_role;
revoke all on table public.access_change_evidence from anon, authenticated, service_role;
revoke all on table public.access_legacy_quarantine_backup from anon, authenticated, service_role;
revoke all on table public.notification_outbox from anon, authenticated, service_role;
revoke all on table public.access_rate_limit_bucket from anon, authenticated, service_role;

grant select on table public.access_field_set, public.access_field_set_member,
  public.access_management_draft, public.access_preflight, public.access_preflight_target,
  public.access_command, public.access_command_target, public.access_command_dispatch_outbox,
  public.access_change,
  public.access_change_evidence, public.notification_outbox, public.access_rate_limit_bucket
  to service_role;
grant update on table public.notification_outbox, public.access_command_dispatch_outbox
  to service_role;

revoke all on function public.access_text_array_is_canonical(text[], integer)
  from public, anon, authenticated, service_role;
revoke all on function public.access_permissions_are_valid(text[])
  from public, anon, authenticated, service_role;
revoke all on function public.prevent_access_immutable_mutation()
  from public, anon, authenticated, service_role;
revoke all on function public.access_field_set_for_fields(text, text[])
  from public, anon, authenticated, service_role;
revoke all on function public.prepare_user_settings_access_state()
  from public, anon, authenticated, service_role;
revoke all on function public.consume_access_rate_limit(text, text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.resolve_access_field_set(text, text[])
  from public, anon, authenticated;
revoke all on function public.save_access_draft(text, text, bigint, jsonb)
  from public, anon, authenticated;
revoke all on function public.consume_access_management_read_limit(text, text)
  from public, anon, authenticated;
revoke all on function public.create_access_preflight(
  text, uuid, bigint, text, bigint, integer, text, text, jsonb, jsonb
) from public, anon, authenticated;
revoke all on function public.accept_access_command(
  text, uuid, text, uuid, text, text, boolean, uuid, text
) from public, anon, authenticated;
revoke all on function public.claim_access_command(text, uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.read_access_command(text, uuid)
  from public, anon, authenticated;
revoke all on function public.apply_access_command_target(
  text, uuid, bigint, text, boolean, boolean, boolean, boolean, boolean, boolean
)
  from public, anon, authenticated;
revoke all on function public.fail_access_command(text, uuid, bigint, text)
  from public, anon, authenticated;
revoke all on function public.finalize_access_command(text, uuid, bigint)
  from public, anon, authenticated;

grant execute on function public.resolve_access_field_set(text, text[]) to service_role;
grant execute on function public.save_access_draft(text, text, bigint, jsonb) to service_role;
grant execute on function public.consume_access_management_read_limit(text, text) to service_role;
grant execute on function public.create_access_preflight(
  text, uuid, bigint, text, bigint, integer, text, text, jsonb, jsonb
) to service_role;
grant execute on function public.accept_access_command(
  text, uuid, text, uuid, text, text, boolean, uuid, text
) to service_role;
grant execute on function public.claim_access_command(text, uuid, bigint) to service_role;
grant execute on function public.read_access_command(text, uuid) to service_role;
grant execute on function public.apply_access_command_target(
  text, uuid, bigint, text, boolean, boolean, boolean, boolean, boolean, boolean
)
  to service_role;
grant execute on function public.fail_access_command(text, uuid, bigint, text) to service_role;
grant execute on function public.finalize_access_command(text, uuid, bigint) to service_role;

commit;
