drop function if exists public.retry_confirmed_operation_launch(text,text,uuid,text,bigint,boolean);
drop function if exists public.complete_operation_launch_dispatch(text,uuid,integer,uuid,uuid,boolean,text);
drop function if exists public.list_recoverable_operation_dispatches(integer);
drop function if exists public.claim_operation_launch_dispatch(text,uuid);
drop function if exists public.read_confirmed_operation_receipt(text,text,uuid);
drop function if exists public.launch_confirmed_task_preflight(
  text,text,text,uuid,integer,timestamptz,uuid,bigint,boolean,jsonb,text,text,text,text,text
);
drop table if exists public.operation_launch_dispatch;
drop table if exists public.private_operation_execution_plan;
