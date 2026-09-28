begin;
select plan(2);
\ir ../rollback/20260904020000_task_preflight_confirmation.down.sql
select hasnt_function('public', 'confirm_task_preflight', 'confirmation RPC is removed');
select hasnt_table('public', 'task_preflight_confirmation', 'confirmation table is removed');
select * from finish();
rollback;
