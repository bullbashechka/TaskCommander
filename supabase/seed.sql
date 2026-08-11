insert into public.portal (id, display_name)
values ('local-demo', 'Локальный демонстрационный портал')
on conflict (id) do update
set display_name = excluded.display_name;

insert into public.user_settings (
  portal_id,
  user_id,
  display_name,
  access_active,
  permissions,
  allowed_field_ids,
  granted_at
)
values
  (
    'local-demo',
    '1001',
    'Тестовый администратор',
    true,
    array[
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
    ]::text[],
    array['deadline', 'priority']::text[],
    now()
  ),
  (
    'local-demo',
    '1002',
    'Тестовый оператор',
    true,
    array['app_access', 'run_bulk_operations', 'view_own_reports']::text[],
    array['deadline']::text[],
    now()
  )
on conflict (portal_id, user_id) do update
set
  display_name = excluded.display_name,
  access_active = excluded.access_active,
  permissions = excluded.permissions,
  allowed_field_ids = excluded.allowed_field_ids,
  granted_at = excluded.granted_at,
  granted_by_user_id = null,
  access_revoked_at = null;

insert into public.saved_filter (portal_id, owner_id, name, filter_payload)
values (
  'local-demo',
  '1002',
  'Просроченные задачи',
  '[{"kind":"date_time","fieldId":"deadline","operator":"before","values":["2026-08-11T00:00:00+05:00"]}]'::jsonb
)
on conflict (portal_id, owner_id, normalized_name) do update
set filter_payload = excluded.filter_payload;

insert into public.operation_draft (
  portal_id,
  owner_id,
  revision,
  status,
  filter_snapshot,
  sort_snapshot,
  selected_task_ids,
  changes,
  preflight_snapshot
)
values (
  'local-demo',
  '1002',
  1,
  'preparing',
  '{"filters":[]}'::jsonb,
  '{"fieldId":"deadline","direction":"asc"}'::jsonb,
  array['5001'],
  '[{"fieldId":"deadline","kind":"date_time","action":"set","value":"2026-08-20T09:00:00+05:00"}]'::jsonb,
  '{"summary":{"selected":1}}'::jsonb
)
on conflict (portal_id, owner_id) do update
set
  revision = excluded.revision,
  status = excluded.status,
  filter_snapshot = excluded.filter_snapshot,
  sort_snapshot = excluded.sort_snapshot,
  selected_task_ids = excluded.selected_task_ids,
  changes = excluded.changes,
  preflight_snapshot = excluded.preflight_snapshot;

insert into public.bulk_operation (
  id,
  portal_id,
  operation_type,
  status,
  initiator_id,
  initiator_display_name,
  idempotency_key,
  filter_snapshot,
  selected_task_ids,
  changes,
  preflight_snapshot,
  selected_count,
  eligible_count,
  successful_count,
  failed_count,
  started_at,
  last_progress_at,
  completed_at
)
values (
  '11111111-1111-4111-8111-111111111111',
  'local-demo',
  'bulk_change',
  'completed_with_errors',
  '1001',
  'Тестовый администратор',
  'seed-completed-operation',
  '{"filters":[]}'::jsonb,
  array['5001', '5002'],
  '[{"fieldId":"deadline","kind":"date_time","action":"set","value":"2026-08-20T09:00:00+05:00"}]'::jsonb,
  '{"summary":{"selected":2,"eligible":2}}'::jsonb,
  2,
  2,
  1,
  1,
  now(),
  now(),
  now()
)
on conflict (id) do update
set
  status = excluded.status,
  selected_count = excluded.selected_count,
  eligible_count = excluded.eligible_count,
  successful_count = excluded.successful_count,
  failed_count = excluded.failed_count,
  started_at = excluded.started_at,
  last_progress_at = excluded.last_progress_at,
  completed_at = excluded.completed_at;

insert into public.task_processing_result (
  id,
  operation_id,
  task_id,
  task_title,
  outcome,
  requested_field_ids,
  applied_field_ids,
  can_retry
)
values
  (
    '22222222-2222-4222-8222-222222222221',
    '11111111-1111-4111-8111-111111111111',
    '5001',
    'Тестовая задача',
    'success',
    array['deadline'],
    array['deadline'],
    false
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    '5002',
    null,
    'error',
    array['deadline'],
    '{}'::text[],
    true
  )
on conflict (operation_id, task_id) do update
set
  task_title = excluded.task_title,
  outcome = excluded.outcome,
  requested_field_ids = excluded.requested_field_ids,
  applied_field_ids = excluded.applied_field_ids,
  can_retry = excluded.can_retry;

insert into public.report (id, operation_id, storage_status, active_until, delete_after)
values (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  'active',
  now() + interval '1 year',
  now() + interval '2 years'
)
on conflict (operation_id) do update
set
  storage_status = excluded.storage_status,
  active_until = excluded.active_until,
  archived_at = null,
  delete_after = excluded.delete_after;

insert into public.report_artifact (
  report_id,
  format,
  status,
  disk_file_id,
  disk_path,
  last_error_code,
  ready_at
)
values
  (
    '33333333-3333-4333-8333-333333333333',
    'xlsx',
    'ready',
    'local-demo-xlsx',
    'Task Commander/seed-report.xlsx',
    null,
    now()
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    'csv',
    'failed',
    null,
    null,
    'SEED_GENERATION_FAILED',
    null
  )
on conflict (report_id, format) do update
set
  status = excluded.status,
  disk_file_id = excluded.disk_file_id,
  disk_path = excluded.disk_path,
  last_error_code = excluded.last_error_code,
  ready_at = excluded.ready_at;
