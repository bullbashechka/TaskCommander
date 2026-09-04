begin;

select plan(1);

\ir ../rollback/20260904010000_task_preflight_snapshot.down.sql

select hasnt_function(
  'public',
  'save_task_preflight',
  'task preflight RPC is removed by rollback'
);

select * from finish();

rollback;
