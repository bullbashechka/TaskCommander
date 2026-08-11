begin;

select plan(14);

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

select * from finish();

rollback;
