begin;
select plan(3);
\ir ../rollback/20260904040000_operation_consumer.down.sql
select ok(to_regclass('public.operation_task_claim') is null,'claim table removed');
select ok(to_regclass('public.mock_task_state') is null,'mock state removed');
select ok(to_regprocedure('public.apply_claimed_mock_task_change(text,uuid,integer,text,uuid,bigint,jsonb,jsonb)') is null,
  'fenced mock CAS removed');
select * from finish();
rollback;
