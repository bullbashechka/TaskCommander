begin;
select plan(12);

insert into public.portal(id,display_name) values ('restore-operation-test','Restore test');
insert into public.user_settings(portal_id,user_id,display_name,access_active,
  permissions,allowed_field_ids,granted_at)
values ('restore-operation-test','8001','Operator',true,
  array['app_access','run_bulk_operations','change_allowed_fields','restore_operations',
    'view_own_reports']::text[],array['title']::text[],now()),
  ('restore-operation-test','8002','Other',true,
  array['app_access','run_bulk_operations','change_allowed_fields','restore_operations',
    'view_own_reports']::text[],array['title']::text[],now());
insert into public.bulk_operation(id,portal_id,operation_type,status,initiator_id,
  initiator_display_name,idempotency_key,request_fingerprint,selected_task_ids,changes,
  preflight_snapshot,selected_count,eligible_count,successful_count,completed_at)
values ('10000000-0000-4000-8000-000000000025','restore-operation-test',
  'bulk_change','completed','8001','Operator','source-restore',repeat('a',64),array['42'],
  '[{"fieldId":"title"}]'::jsonb,'{}'::jsonb,1,1,1,now());
insert into public.task_processing_result(operation_id,task_id,task_title,outcome,
  requested_field_ids,applied_field_ids,can_retry)
values ('10000000-0000-4000-8000-000000000025','42','Source task','success',
  array['title'],array['title'],false);
insert into public.protected_task_result(task_processing_result_id,ciphertext,nonce,
  key_version,payload_version,before_version,after_version)
select id,repeat('x',32)::bytea,repeat('n',12)::bytea,'v1',1,'mock:1','mock:2'
from public.task_processing_result
where operation_id='10000000-0000-4000-8000-000000000025';
insert into public.report(operation_id,active_until,delete_after)
values ('10000000-0000-4000-8000-000000000025',now()+interval '30 days',
  now()+interval '1 year');

select ok(not has_function_privilege('authenticated',
  'public.read_restore_source(text,text,uuid,bigint,boolean)','EXECUTE'),
  'browser cannot read protected source');
select is((public.read_restore_source('restore-operation-test','8001',
  '10000000-0000-4000-8000-000000000025',1,false)->'tasks'->0->>'afterVersion'),
  'mock:2','owner sees server-only source version');
select is(public.read_restore_source('restore-operation-test','8002',
  '10000000-0000-4000-8000-000000000025',1,false),null::jsonb,
  'other user without all-reports right cannot read source');

savepoint archived;
update public.report set storage_status='archived_pending_artifact'
where operation_id='10000000-0000-4000-8000-000000000025';
select is(public.read_restore_source('restore-operation-test','8001',
  '10000000-0000-4000-8000-000000000025',1,false),null::jsonb,
  'pending archive blocks restore');
rollback to savepoint archived;

select throws_ok($$select public.save_restore_operation_draft('restore-operation-test',
  '8001','20000000-0000-4000-8000-000000000025',
  '10000000-0000-4000-8000-000000000025',1,1,false,array['42'],
  '[{"fieldId":"title","kind":"text","action":"clear"}]'::jsonb,
  '[{"taskId":"42","fieldIds":["title"],"afterVersion":"mock:2", "targetValues":{"title":"secret"}}]'::jsonb,
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'))$$,
  '22023','TC_RESTORE_DRAFT_INVALID','plaintext target is rejected from metadata');

select is((public.save_restore_operation_draft('restore-operation-test','8001',
  '20000000-0000-4000-8000-000000000025',
  '10000000-0000-4000-8000-000000000025',1,1,false,array['42'],
  '[{"fieldId":"title","kind":"text","action":"clear"}]'::jsonb,
  '[{"taskId":"42","fieldIds":["title"],"afterVersion":"mock:2"}]'::jsonb,
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'))).id::text,
  '20000000-0000-4000-8000-000000000025','encrypted restore draft saved');
select ok((select changes::text not like '%secret%'
  and restore_intents::text not like '%secret%'
  from public.operation_draft where id='20000000-0000-4000-8000-000000000025'),
  'public draft has no previous values');
select is(public.read_private_restore_draft('restore-operation-test','8002',
  '20000000-0000-4000-8000-000000000025',1,false),null::jsonb,
  'another owner cannot read private draft');

create temporary table restore_fixture(snapshot jsonb);
insert into restore_fixture values (jsonb_build_object(
  'draftId','20000000-0000-4000-8000-000000000025',
  'sourceDraftRevision',1,'draftRevision',2,'actorAccessVersion',1,
  'checkedAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'canProceed',false,'entries',jsonb_build_array(jsonb_build_object(
    'taskId','42','title','Source task','taskUrl',null,
    'disposition','conflict','changedFieldIds','[]'::jsonb,
    'reasonCode','RESTORE_VERSION_CHANGED','reasonMessage','Version changed',
    'relevantVersion','mock:3','currentValues',null,'targetValues',null)),
  'summary',jsonb_build_object('selected',1,'eligible',0,'excluded',0,
    'unchanged',0,'successful',0,'failed',0,'unconfirmed',0,'conflicted',1,
    'partiallyApplied',0,'notProcessed',0)));
select is((public.save_restore_preflight('restore-operation-test','8001',
  '20000000-0000-4000-8000-000000000025',1,1,false,
  (select snapshot from restore_fixture),encode(repeat('y',32)::bytea,'base64'),
  encode(repeat('m',12)::bytea,'base64'),repeat('c',64))).revision,2,
  'redacted preview saved with private ciphertext');
select is((public.launch_confirmed_restore_preflight('restore-operation-test','8001',
  'Operator','20000000-0000-4000-8000-000000000025',2,
  ((select snapshot from restore_fixture)->>'checkedAt')::timestamptz,null,1,false,
  (select snapshot from restore_fixture),repeat('b',64),repeat('c',64),
  null,null,null,'30000000-0000-4000-8000-000000000025')->'operation'->>'status'),
  'completed_with_errors','zero-write conflict completes synchronously');
select is((select outcome from public.task_processing_result where operation_id=
  (select id from public.bulk_operation where operation_type='restore'
    and portal_id='restore-operation-test')),'conflict',
  'preflight conflict is a persisted initial outcome');
select is((public.launch_confirmed_restore_preflight('restore-operation-test','8001',
  'Operator','20000000-0000-4000-8000-000000000025',2,
  ((select snapshot from restore_fixture)->>'checkedAt')::timestamptz,null,1,false,
  (select snapshot from restore_fixture),repeat('b',64),repeat('c',64),
  null,null,null,'30000000-0000-4000-8000-000000000025')->>'disposition'),
  'existing','same exact request replays after draft deletion');

select * from finish();
rollback;
