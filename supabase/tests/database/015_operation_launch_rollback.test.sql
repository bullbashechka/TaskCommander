begin;
select plan(4);
\ir ../rollback/20260904030000_operation_launch.down.sql
select ok(to_regclass('public.private_operation_execution_plan') is null,
  'private execution plan removed');
select ok(to_regclass('public.operation_launch_dispatch') is null,
  'launch outbox removed');
select ok(to_regprocedure('public.launch_confirmed_task_preflight(text,text,text,uuid,integer,timestamptz,uuid,bigint,boolean,jsonb,text,text,text,text,text)') is null,
  'launch function removed');
select ok(to_regprocedure('public.read_confirmed_operation_receipt(text,text,uuid)') is null,
  'owner receipt function removed');
select * from finish();
rollback;
