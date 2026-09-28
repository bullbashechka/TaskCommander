begin;
select plan(4);
\ir ../rollback/20260904050000_operation_progress_lease.down.sql
select ok(to_regclass('public.operation_execution_lease') is null,
  'execution lease table removed');
select ok(to_regprocedure('public.acquire_operation_execution_lease(text,uuid,integer,uuid)') is null,
  'acquire RPC removed');
select ok(to_regprocedure('public.expire_operation_execution_leases(integer)') is null,
  'watchdog RPC removed');
select ok(to_regprocedure('public.request_owned_operation_cancellation(text,text,uuid,text,bigint,boolean)') is null,
  'owner cancellation RPC removed');
select * from finish();
rollback;
