begin;

select plan(15);

\ir ../rollback/20260811000000_task_commander_schema.down.sql

select hasnt_table('public', 'portal', 'portal is removed by rollback');
select hasnt_table('public', 'user_settings', 'user settings are removed by rollback');
select hasnt_table('public', 'saved_filter', 'saved filters are removed by rollback');
select hasnt_table('public', 'operation_draft', 'operation drafts are removed by rollback');
select hasnt_table('public', 'bulk_operation', 'bulk operations are removed by rollback');
select hasnt_table('public', 'task_processing_result', 'task results are removed by rollback');
select hasnt_table('public', 'protected_task_result', 'protected results are removed by rollback');
select hasnt_table('public', 'report', 'reports are removed by rollback');
select hasnt_table('public', 'report_artifact', 'report artifacts are removed by rollback');
select hasnt_table('public', 'audit_event', 'audit events are removed by rollback');
select hasnt_function('public', 'set_updated_at', 'timestamp helper is removed by rollback');
select hasnt_function(
  'public',
  'set_draft_updated_at_and_expiry',
  'draft timestamp helper is removed by rollback'
);
select hasnt_function(
  'public',
  'prevent_bulk_operation_snapshot_change',
  'bulk operation immutability helper is removed by rollback'
);
select hasnt_function(
  'public',
  'prevent_task_processing_result_identity_change',
  'task result immutability helper is removed by rollback'
);
select hasnt_function(
  'public',
  'prevent_audit_event_mutation',
  'audit immutability helper is removed by rollback'
);

select * from finish();

rollback;
