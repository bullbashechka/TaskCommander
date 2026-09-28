begin;
select plan(7);
insert into public.portal(id,display_name) values ('retry-rollback-test','Retry rollback');
insert into public.user_settings(portal_id,user_id,display_name,access_active,
  permissions,allowed_field_ids,granted_at)
values ('retry-rollback-test','8001','Operator',true,
  array['app_access','run_bulk_operations','change_allowed_fields','retry_operations',
    'view_own_reports']::text[],array['title']::text[],now());
insert into public.bulk_operation(id,portal_id,operation_type,status,initiator_id,
  initiator_display_name,idempotency_key,request_fingerprint,selected_task_ids,changes,
  preflight_snapshot,selected_count,eligible_count,failed_count,completed_at)
values ('10000000-0000-4000-8000-000000000025','retry-rollback-test','bulk_change',
  'completed_with_errors','8001','Operator','rollback-source',repeat('a',64),array['42'],
  '[{"fieldId":"title"}]'::jsonb,'{}'::jsonb,1,1,1,now());
insert into public.operation_draft(id,portal_id,owner_id,selected_task_ids,changes,
  retry_source_operation_id,retry_source_state_version,retry_intents)
values ('20000000-0000-4000-8000-000000000025','retry-rollback-test','8001',array['42'],
  '[{"fieldId":"title","kind":"text","action":"set","value":"After"}]'::jsonb,
  '10000000-0000-4000-8000-000000000025',1,
  '[{"taskId":"42","targetValues":{"title":"After"}}]'::jsonb);
insert into public.task_preflight_confirmation(portal_id,owner_id,draft_id,
  draft_revision,token,snapshot_fingerprint,expires_at)
values ('retry-rollback-test','8001','20000000-0000-4000-8000-000000000025',
  1,'30000000-0000-4000-8000-000000000025',repeat('b',64),now()+interval '1 hour');
\ir ../rollback/20260904060000_retry_operation.down.sql
select is((select count(*)::integer from public.operation_draft
  where portal_id='retry-rollback-test'),0,'rollback removes live retry draft');
select is((select count(*)::integer from public.task_preflight_confirmation
  where portal_id='retry-rollback-test'),0,'rollback revokes retry confirmation');
select ok(to_regprocedure('public.read_retry_source(text,text,uuid,bigint,boolean)') is null,
  'retry source reader removed');
select ok(to_regprocedure('public.save_retry_operation_draft(text,text,uuid,bigint,bigint,boolean,text[],jsonb,jsonb)') is null,
  'retry draft writer removed');
select ok(to_regprocedure('public.discard_retry_operation_draft(text,text,uuid,integer,bigint,boolean)') is null,
  'retry draft recovery removed');
select ok(not exists(select 1 from information_schema.columns
  where table_schema='public' and table_name='operation_draft'
    and column_name='retry_intents'),'retry intents column removed');
select ok(to_regprocedure('public.launch_confirmed_task_preflight(text,text,text,uuid,integer,timestamptz,uuid,bigint,boolean,jsonb,text,text,text,text,text)') is not null,
  'prior launch implementation restored');
select * from finish();
rollback;
