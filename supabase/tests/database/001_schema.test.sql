begin;

select plan(25);

select has_table('public', 'portal', 'portal table exists');
select has_table('public', 'user_settings', 'user settings table exists');
select has_table('public', 'saved_filter', 'saved filter table exists');
select has_table('public', 'operation_draft', 'operation draft table exists');
select has_table('public', 'bulk_operation', 'bulk operation table exists');
select has_table('public', 'task_processing_result', 'task processing result table exists');
select has_table('public', 'protected_task_result', 'protected result table exists');
select has_table('public', 'report', 'report table exists');
select has_table('public', 'report_artifact', 'report artifact table exists');
select has_table('public', 'audit_event', 'audit event table exists');
select has_index(
  'public',
  'bulk_operation',
  'bulk_operation_one_active_per_initiator',
  'one active operation index exists'
);
select has_index(
  'public',
  'task_processing_result',
  'task_processing_result_operation_task_key',
  'one result per task index exists'
);
select has_index(
  'public',
  'report_artifact',
  'report_artifact_report_format_key',
  'one artifact per report format index exists'
);
select has_function('public', 'set_updated_at', 'timestamp helper exists');
select hasnt_column(
  'public',
  'protected_task_result',
  'previous_values',
  'protected results have no plaintext values column'
);

insert into public.portal (id, display_name)
values ('test-constraints', 'Тестовые ограничения');

insert into public.user_settings (portal_id, user_id, display_name, access_active)
values
  ('test-constraints', '2001', 'Первый оператор', true),
  ('test-constraints', '2002', 'Второй оператор', true);

insert into public.saved_filter (portal_id, owner_id, name, filter_payload)
values ('test-constraints', '2001', 'Аналитика', '[]'::jsonb);

select throws_ok(
  $$insert into public.saved_filter (portal_id, owner_id, name, filter_payload)
    values ('test-constraints', '2001', 'АНАЛИТИКА', '[]'::jsonb);$$,
  '23505',
  '.*saved_filter_owner_name_key.*',
  'duplicate normalized filter name is rejected'
);

insert into public.operation_draft (portal_id, owner_id, selected_task_ids, changes)
values ('test-constraints', '2001', array['8001'], '[{}]'::jsonb);

select throws_ok(
  $$insert into public.operation_draft (portal_id, owner_id, selected_task_ids, changes)
    values ('test-constraints', '2001', array['8002'], '[{}]'::jsonb);$$,
  '23505',
  '.*operation_draft_owner_key.*',
  'second draft for the same owner is rejected'
);

insert into public.bulk_operation (
  id,
  portal_id,
  operation_type,
  status,
  initiator_id,
  initiator_display_name,
  idempotency_key,
  selected_task_ids,
  changes,
  preflight_snapshot
)
values (
  '00000000-0000-4000-8000-000000000001',
  'test-constraints',
  'bulk_change',
  'running',
  '2001',
  'Первый оператор',
  'constraint-active-one',
  array['8001'],
  '[{}]'::jsonb,
  '{}'::jsonb
);

select throws_ok(
  $$insert into public.bulk_operation (
      portal_id,
      operation_type,
      status,
      initiator_id,
      initiator_display_name,
      idempotency_key,
      selected_task_ids,
      changes,
      preflight_snapshot
    )
    values (
      'test-constraints',
      'bulk_change',
      'running',
      '2001',
      'Первый оператор',
      'constraint-active-two',
      array['8002'],
      '[{}]'::jsonb,
      '{}'::jsonb
    );$$,
  '23505',
  '.*bulk_operation_one_active_per_initiator.*',
  'second active operation for the same initiator is rejected'
);

select lives_ok(
  $$insert into public.bulk_operation (
      portal_id,
      operation_type,
      status,
      initiator_id,
      initiator_display_name,
      idempotency_key,
      selected_task_ids,
      changes,
      preflight_snapshot
    )
    values (
      'test-constraints',
      'bulk_change',
      'running',
      '2002',
      'Второй оператор',
      'constraint-active-other-user',
      array['8003'],
      '[{}]'::jsonb,
      '{}'::jsonb
    );$$,
  'different initiators can have active operations concurrently'
);

select throws_ok(
  $$insert into public.task_processing_result (operation_id, task_id, outcome)
    values ('00000000-0000-4000-8000-000000000099', '8001', 'success');$$,
  '23503',
  '.*task_processing_result_operation_id_fkey.*',
  'orphaned task result is rejected'
);

select throws_ok(
  $$insert into public.bulk_operation (
      portal_id,
      operation_type,
      status,
      initiator_id,
      initiator_display_name,
      idempotency_key,
      selected_task_ids,
      changes,
      preflight_snapshot
    )
    values (
      'test-constraints',
      'bulk_change',
      'queued',
      '2001',
      'Первый оператор',
      'constraint-invalid-status',
      array['8004'],
      '[{}]'::jsonb,
      '{}'::jsonb
    );$$,
  '23514',
  '.*bulk_operation_status_allowed.*',
  'unknown operation status is rejected'
);

insert into public.task_processing_result (operation_id, task_id, outcome)
values ('00000000-0000-4000-8000-000000000001', '8001', 'success');

select throws_ok(
  $$insert into public.task_processing_result (operation_id, task_id, outcome)
    values ('00000000-0000-4000-8000-000000000001', '8001', 'success');$$,
  '23505',
  '.*task_processing_result_operation_task_key.*',
  'duplicate task result is rejected'
);

insert into public.report (id, operation_id, active_until, delete_after)
values (
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000001',
  now() + interval '1 year',
  now() + interval '2 years'
);

insert into public.report_artifact (report_id, format, status, disk_file_id)
values ('00000000-0000-4000-8000-000000000010', 'xlsx', 'ready', 'test-xlsx-file');

select throws_ok(
  $$insert into public.report_artifact (report_id, format, status, disk_file_id)
    values ('00000000-0000-4000-8000-000000000010', 'xlsx', 'ready', 'duplicate-xlsx-file');$$,
  '23505',
  '.*report_artifact_report_format_key.*',
  'duplicate artifact format is rejected'
);

select lives_ok(
  $$insert into public.report_artifact (report_id, format, status, last_error_code)
    values ('00000000-0000-4000-8000-000000000010', 'csv', 'failed', 'GENERATION_FAILED');$$,
  'one failed artifact does not prevent another report format'
);

insert into public.audit_event (portal_id, action, outcome)
values ('test-constraints', 'operation_created', 'success');

select throws_ok(
  $$update public.audit_event set outcome = 'failure' where portal_id = 'test-constraints';$$,
  '23514',
  'Audit events are append-only.',
  'audit events cannot be updated'
);

select * from finish();

rollback;
