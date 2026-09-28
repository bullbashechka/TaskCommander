begin;
select plan(22);

insert into public.portal(id,display_name) values ('retry-operation-test','Retry operation test');
insert into public.user_settings(portal_id,user_id,display_name,access_active,
  permissions,allowed_field_ids,granted_at)
values ('retry-operation-test','8001','Operator',true,
  array['app_access','run_bulk_operations','change_allowed_fields','retry_operations',
    'view_own_reports']::text[],array['title']::text[],now());

insert into public.bulk_operation(id,portal_id,operation_type,status,initiator_id,
  initiator_display_name,idempotency_key,request_fingerprint,selected_task_ids,changes,
  preflight_snapshot,selected_count,eligible_count,failed_count,completed_at)
values ('10000000-0000-4000-8000-000000000024','retry-operation-test','bulk_change',
  'completed_with_errors','8001','Operator',
  'confirmation:20000000-0000-4000-8000-000000000024',repeat('a',64),array['42'],
  '[{"fieldId":"title"},{"fieldId":"tags"}]'::jsonb,
  '{"draftId":"30000000-0000-4000-8000-000000000024","draftRevision":2}'::jsonb,
  1,1,1,now());
insert into public.private_operation_execution_plan(operation_id,ciphertext,nonce,key_version)
values ('10000000-0000-4000-8000-000000000024',repeat('x',32)::bytea,
  repeat('n',12)::bytea,'v1');
insert into public.task_processing_result(operation_id,task_id,outcome,
  requested_field_ids,failed_field_ids,can_retry)
values ('10000000-0000-4000-8000-000000000024','42','error',
  array['title'],array['title'],true);
insert into public.report(operation_id,active_until,delete_after)
values ('10000000-0000-4000-8000-000000000024',now()+interval '30 days',
  now()+interval '1 year');

savepoint archived_pending;
update public.report set storage_status='archived_pending_artifact'
  where operation_id='10000000-0000-4000-8000-000000000024';
select is((select public.read_retry_source('retry-operation-test','8001',
  '10000000-0000-4000-8000-000000000024',1,false)),null::jsonb,
  'pending archive hides source even before archived_at');
select throws_ok($$select public.save_retry_operation_draft('retry-operation-test','8001',
  '10000000-0000-4000-8000-000000000024',1,1,false,array['42'],
  '[{"fieldId":"title"}]'::jsonb,
  '[{"taskId":"42","targetValues":{"title":"After"}}]'::jsonb)$$,
  '40001','TC_RETRY_SOURCE_CHANGED','pending archive blocks retry preparation');
rollback to savepoint archived_pending;

select ok(not has_function_privilege('authenticated',
  'public.read_retry_source(text,text,uuid,bigint,boolean)','EXECUTE'),
  'browser role cannot read encrypted source plan');
select is((select public.read_retry_source('retry-operation-test','8001',
  '10000000-0000-4000-8000-000000000024',1,false)->'operation'->>'id'),
  '10000000-0000-4000-8000-000000000024','owner can read terminal source');
select is((select public.read_retry_source('retry-operation-test','8002',
  '10000000-0000-4000-8000-000000000024',1,false)),null::jsonb,
  'other user cannot read source');

create temporary table retry_fixture(draft public.operation_draft,snapshot jsonb,token uuid);
insert into retry_fixture(draft)
select public.save_retry_operation_draft('retry-operation-test','8001',
  '10000000-0000-4000-8000-000000000024',1,1,false,array['42'],
  '[{"fieldId":"title","kind":"text","action":"set","value":"After"}]'::jsonb,
  '[{"taskId":"42","targetValues":{"title":"After"}}]'::jsonb);
select is((select (draft).retry_source_operation_id::text from retry_fixture),
  '10000000-0000-4000-8000-000000000024','title-only retry ignores unrelated source tags');
select is((select (draft).retry_intents->0->'targetValues'->>'title' from retry_fixture),
  'After','draft stores absolute per-task target');
select throws_ok($$select public.save_retry_operation_draft('retry-operation-test','8001',
  '10000000-0000-4000-8000-000000000024',1,1,false,array['42'],
  '[{"fieldId":"title"}]'::jsonb,
  '[{"taskId":"42","targetValues":{"title":"After"}}]'::jsonb)$$,
  '40001','TC_RETRY_DRAFT_EXISTS','another draft cannot overwrite live retry');
select throws_ok($$select public.save_retry_operation_draft('retry-operation-test','8001',
  '10000000-0000-4000-8000-000000000024',1,1,false,array['42'],
  '[{"fieldId":"hidden","kind":"text","action":"set","value":"Secret"}]'::jsonb,
  '[{"taskId":"42","targetValues":{"title":"After"}}]'::jsonb)$$,
  '22023','TC_RETRY_DRAFT_INVALID','metadata outside selected intent is rejected');
select is(public.discard_retry_operation_draft('retry-operation-test','8001',
  '30000000-0000-4000-8000-000000000024',1,1,false),false,
  'CAS cannot discard a different draft');
select is(public.discard_retry_operation_draft('retry-operation-test','8001',
  (select (draft).id from retry_fixture),2,1,false),false,
  'CAS cannot discard a newer retry revision');
savepoint unrelated_normal_draft;
update public.operation_draft set retry_source_operation_id=null,
  retry_source_state_version=null,retry_intents=null
  where id=(select (draft).id from retry_fixture);
select is(public.discard_retry_operation_draft('retry-operation-test','8001',
  (select (draft).id from retry_fixture),1,1,false),false,
  'recovery cannot delete a normal draft even when ID and revision match');
rollback to savepoint unrelated_normal_draft;
savepoint revoked_retry_cleanup;
update public.user_settings set permissions=array['app_access','run_bulk_operations',
  'change_allowed_fields','view_own_reports']::text[],access_version=access_version+1
  where portal_id='retry-operation-test' and user_id='8001';
select is(public.discard_retry_operation_draft('retry-operation-test','8001',
  (select (draft).id from retry_fixture),1,2,false),true,
  'base editor rights can discard matching retry after retry permission revocation');
select is((select count(*) from public.operation_draft
  where id=(select (draft).id from retry_fixture)),0::bigint,
  'only the matching retry draft is removed');
rollback to savepoint revoked_retry_cleanup;
savepoint source_refined_before_prepare;
update public.bulk_operation set state_version=state_version+1
  where id='10000000-0000-4000-8000-000000000024';
select isnt((select (public.save_retry_operation_draft('retry-operation-test','8001',
  '10000000-0000-4000-8000-000000000024',2,1,false,array['42'],
  '[{"fieldId":"title","kind":"text","action":"set","value":"After"}]'::jsonb,
  '[{"taskId":"42","targetValues":{"title":"After"}}]'::jsonb)).id::text),
  (select (draft).id::text from retry_fixture),
  'source refinement permits replacement of only stale retry draft');
rollback to savepoint source_refined_before_prepare;

update retry_fixture set snapshot=jsonb_build_object(
  'draftId',(draft).id,'sourceDraftRevision',1,'draftRevision',2,
  'actorAccessVersion',1,
  'checkedAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'canProceed',true,'entries',jsonb_build_array(jsonb_build_object(
    'taskId','42','title','Task','taskUrl','https://portal.bitrix24.ru/tasks/42',
    'disposition','eligible','changedFieldIds',jsonb_build_array('title'),
    'reasonCode',null,'reasonMessage',null,'relevantVersion','v2',
    'currentValues',jsonb_build_object('title','Before'),
    'targetValues',jsonb_build_object('title','After'))),
  'summary',jsonb_build_object('selected',1,'eligible',1,'excluded',0,'unchanged',0,
    'successful',0,'failed',0,'unconfirmed',0,'conflicted',0,'partiallyApplied',0,
    'notProcessed',0));
update public.operation_draft set revision=2,status='awaiting_confirmation',
  preflight_snapshot=(select snapshot from retry_fixture)
where id=(select (draft).id from retry_fixture);
update retry_fixture set token=(public.confirm_task_preflight(
  'retry-operation-test','8001',(draft).id,2,(snapshot->>'checkedAt')::timestamptz,
  1,false,snapshot,repeat('b',64))->>'token')::uuid;

savepoint source_changed;
update public.bulk_operation set state_version=state_version+1
  where id='10000000-0000-4000-8000-000000000024';
select throws_ok($$select public.launch_confirmed_task_preflight(
  'retry-operation-test','8001','Operator',(draft).id,2,
  (snapshot->>'checkedAt')::timestamptz,token,1,false,snapshot,repeat('b',64),
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),
  'v1','TC-123e4567-e89b-42d3-a456-426614174a24') from retry_fixture$$,
  '40001','TC_RETRY_SOURCE_CHANGED','source refinement drift blocks new launch');
rollback to savepoint source_changed;
savepoint archive_before_launch;
update public.report set storage_status='archived_pending_artifact'
  where operation_id='10000000-0000-4000-8000-000000000024';
select throws_ok($$select public.launch_confirmed_task_preflight(
  'retry-operation-test','8001','Operator',(draft).id,2,
  (snapshot->>'checkedAt')::timestamptz,token,1,false,snapshot,repeat('b',64),
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),
  'v1','TC-123e4567-e89b-42d3-a456-426614174a24') from retry_fixture$$,
  '40001','TC_RETRY_SOURCE_CHANGED','pending archive blocks atomic launch');
rollback to savepoint archive_before_launch;

create temporary table retry_launch(result jsonb);
insert into retry_launch select public.launch_confirmed_task_preflight(
  'retry-operation-test','8001','Operator',(draft).id,2,
  (snapshot->>'checkedAt')::timestamptz,token,1,false,snapshot,repeat('b',64),
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),
  'v1','TC-123e4567-e89b-42d3-a456-426614174a24') from retry_fixture;
select is((select result->'operation'->>'operation_type' from retry_launch),'retry',
  'atomic launch creates retry operation');
select is((select result->'operation'->>'source_operation_id' from retry_launch),
  '10000000-0000-4000-8000-000000000024','retry links terminal source');
select is((select count(*)::integer from public.operation_launch_dispatch where operation_id=
  (select (result->'operation'->>'id')::uuid from retry_launch)),1,
  'retry dispatch is durable');
select is((select public.launch_confirmed_task_preflight(
  'retry-operation-test','8001','Operator',(draft).id,2,
  (snapshot->>'checkedAt')::timestamptz,token,1,false,snapshot,repeat('b',64),
  encode(repeat('y',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),
  'v1','TC-123e4567-e89b-42d3-a456-426614174a24')->'operation'->>'id'
  from retry_fixture),(select result->'operation'->>'id' from retry_launch),
  'same confirmation replays retry after draft purge');
select is((select count(*)::integer from public.operation_draft
  where portal_id='retry-operation-test' and owner_id='8001'),0,
  'plaintext retry targets are removed after launch');
select * from finish();
rollback;
