begin;
select plan(5);
insert into public.portal(id,display_name) values ('restore-rollback-test','Restore rollback');
insert into public.user_settings(portal_id,user_id,display_name,access_active,
  permissions,allowed_field_ids,granted_at)
values ('restore-rollback-test','8001','Operator',true,
  array['app_access','run_bulk_operations','change_allowed_fields',
    'restore_operations','view_own_reports']::text[],array['title']::text[],now());
insert into public.bulk_operation(id,portal_id,operation_type,status,initiator_id,
  initiator_display_name,idempotency_key,request_fingerprint,selected_task_ids,
  changes,preflight_snapshot,selected_count,eligible_count,completed_at)
values ('10000000-0000-4000-8000-000000000026','restore-rollback-test',
  'bulk_change','completed','8001','Operator','source-rollback',repeat('a',64),
  array['42'],'[{"fieldId":"title"}]'::jsonb,'{}'::jsonb,1,0,now());
insert into public.operation_draft(id,portal_id,owner_id,selected_task_ids,changes,
  restore_source_operation_id,restore_source_state_version,restore_intents)
values ('20000000-0000-4000-8000-000000000026','restore-rollback-test','8001',
  array['42'],'[{"fieldId":"title","kind":"text","action":"clear"}]'::jsonb,
  '10000000-0000-4000-8000-000000000026',1,
  '[{"taskId":"42","fieldIds":["title"],"afterVersion":"mock:2"}]'::jsonb);
insert into public.private_restore_draft(draft_id,portal_id,owner_id,
  source_operation_id,source_state_version,intent_ciphertext,intent_nonce)
values ('20000000-0000-4000-8000-000000000026','restore-rollback-test','8001',
  '10000000-0000-4000-8000-000000000026',1,repeat('x',16)::bytea,repeat('n',12)::bytea);
insert into public.task_preflight_confirmation(portal_id,owner_id,draft_id,
  draft_revision,token,snapshot_fingerprint,expires_at)
values ('restore-rollback-test','8001','20000000-0000-4000-8000-000000000026',
  1,'30000000-0000-4000-8000-000000000026',repeat('b',64),now()+interval '1 hour');
\ir ../rollback/20260904070000_restore_operation.down.sql
select is((select count(*)::integer from public.operation_draft
  where portal_id='restore-rollback-test'),0,'rollback purges restore draft');
select is((select count(*)::integer from public.task_preflight_confirmation
  where portal_id='restore-rollback-test'),0,'rollback revokes confirmation');
select ok(to_regprocedure('public.read_restore_source(text,text,uuid,bigint,boolean)') is null,
  'restore source reader removed');
select ok(to_regclass('public.private_restore_draft') is null,
  'private restore table removed');
select ok(not exists(select 1 from information_schema.columns
  where table_schema='public' and table_name='operation_draft'
    and column_name='restore_intents'),'restore metadata removed');
select * from finish();
rollback;
