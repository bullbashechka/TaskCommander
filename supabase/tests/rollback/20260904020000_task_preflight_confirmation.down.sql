drop function if exists public.confirm_task_preflight(
  text, text, uuid, integer, timestamptz, bigint, boolean, jsonb, text
);
drop trigger if exists operation_draft_clear_confirmation on public.operation_draft;
drop function if exists public.clear_task_preflight_confirmation();
drop table if exists public.task_preflight_confirmation;
