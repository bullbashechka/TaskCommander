begin;
select plan(29);

insert into public.portal (id, display_name) values ('operation-launch-test', 'Operation launch test');
insert into public.user_settings (
  portal_id,user_id,display_name,access_active,permissions,allowed_field_ids,granted_at
) values (
  'operation-launch-test','8001','Operator',true,
  array['app_access','run_bulk_operations','change_allowed_fields','view_own_reports',
    'retry_operations']::text[],
  array['title']::text[],now()
);
create temporary table launch_fixture (snapshot jsonb not null, token uuid);
insert into launch_fixture(snapshot) values (jsonb_build_object(
  'draftId','10000000-0000-4000-8000-000000000021',
  'sourceDraftRevision',1,'draftRevision',2,'actorAccessVersion',1,
  'checkedAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'canProceed',true,
  'entries',jsonb_build_array(jsonb_build_object(
    'taskId','42','title','Task','taskUrl','https://portal.bitrix24.ru/tasks/42',
    'disposition','eligible','changedFieldIds',jsonb_build_array('title'),
    'reasonCode',null,'reasonMessage',null,'relevantVersion','version-1',
    'currentValues',jsonb_build_object('title','Before'),
    'targetValues',jsonb_build_object('title','After')
  )),
  'summary',jsonb_build_object('selected',1,'eligible',1,'excluded',0,'unchanged',0,
    'successful',0,'failed',0,'unconfirmed',0,'conflicted',0,'partiallyApplied',0,
    'notProcessed',0)
));
insert into public.operation_draft (
  id,portal_id,owner_id,revision,status,selected_task_ids,changes,preflight_snapshot
) values (
  '10000000-0000-4000-8000-000000000021','operation-launch-test','8001',2,
  'awaiting_confirmation',array['42'],
  '[{"fieldId":"title","kind":"text","action":"set","value":"After"}]'::jsonb,
  (select snapshot from launch_fixture)
);
update launch_fixture set token = (public.confirm_task_preflight(
  'operation-launch-test','8001','10000000-0000-4000-8000-000000000021',2,
  (snapshot->>'checkedAt')::timestamptz,1,false,snapshot,repeat('a',64)
)->>'token')::uuid;

select ok(not has_function_privilege('authenticated',
  'public.launch_confirmed_task_preflight(text,text,text,uuid,integer,timestamptz,uuid,bigint,boolean,jsonb,text,text,text,text,text)',
  'EXECUTE'), 'client roles cannot launch directly');
select throws_ok($$select public.launch_confirmed_task_preflight(
  'operation-launch-test','8001','Operator','10000000-0000-4000-8000-000000000021',2,
  (select (snapshot->>'checkedAt')::timestamptz from launch_fixture),
  (select token from launch_fixture),1,false,(select snapshot from launch_fixture),null,
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),'v1','TC-00000000-0000-4000-8000-000000000021'
);$$,'22023','TC_OPERATION_LAUNCH_INVALID','null fingerprint rejected');
select throws_ok($$select public.launch_confirmed_task_preflight(
  'operation-launch-test','8002','Other','10000000-0000-4000-8000-000000000021',2,
  (select (snapshot->>'checkedAt')::timestamptz from launch_fixture),
  (select token from launch_fixture),null,true,(select snapshot from launch_fixture),repeat('a',64),
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),'v1','TC-00000000-0000-4000-8000-000000000021'
);$$,'40001','TC_OPERATION_LAUNCH_CONFLICT','different owner rejected');
select throws_ok($$select public.launch_confirmed_task_preflight(
  'operation-launch-test','8001','Operator','10000000-0000-4000-8000-000000000021',2,
  (select (snapshot->>'checkedAt')::timestamptz from launch_fixture),
  (select token from launch_fixture),2,false,(select snapshot from launch_fixture),repeat('a',64),
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),'v1','TC-00000000-0000-4000-8000-000000000021'
);$$,'40001','TC_OPERATION_LAUNCH_ACCESS_CHANGED','access drift rejected');
select throws_ok($$select public.launch_confirmed_task_preflight(
  'operation-launch-test','8001','Operator','10000000-0000-4000-8000-000000000021',2,
  (select (snapshot->>'checkedAt')::timestamptz from launch_fixture),
  (select token from launch_fixture),1,false,
  (select snapshot || '{"canProceed":false}'::jsonb from launch_fixture),repeat('a',64),
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),'v1','TC-00000000-0000-4000-8000-000000000021'
);$$,'40001','TC_OPERATION_LAUNCH_CONFLICT','changed snapshot rejected');

create temporary table launch_first(result jsonb not null);
insert into launch_first select public.launch_confirmed_task_preflight(
  'operation-launch-test','8001','Operator','10000000-0000-4000-8000-000000000021',2,
  (snapshot->>'checkedAt')::timestamptz,token,1,false,snapshot,repeat('a',64),
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),'v1','TC-00000000-0000-4000-8000-000000000021'
) from launch_fixture;
select is((select result->>'disposition' from launch_first),'created','first launch creates operation');
select is((select count(*)::integer from public.private_operation_execution_plan
  where operation_id = (select (result->'operation'->>'id')::uuid from launch_first)),1,
  'private plan stored once');
select is((select count(*)::integer from public.operation_launch_dispatch
  where operation_id = (select (result->'operation'->>'id')::uuid from launch_first)),1,
  'one logical dispatch stored');
select is((select public.read_confirmed_operation_receipt(
  'operation-launch-test','8001',(result->'operation'->>'id')::uuid)->>'id'
  from launch_first), (select result->'operation'->>'id' from launch_first),
  'owner can read launch receipt');
select is((select public.read_confirmed_operation_receipt(
  'operation-launch-test','8002',(result->'operation'->>'id')::uuid)
  from launch_first),null::jsonb,'another owner cannot read receipt');
select is((select count(*)::integer from public.task_preflight_confirmation
  where portal_id = 'operation-launch-test' and owner_id = '8001'),0,
  'consumed token and its row are removed');
select is((select count(*)::integer from public.operation_draft
  where portal_id = 'operation-launch-test' and owner_id = '8001'),0,
  'plaintext draft and preflight are removed atomically');
select is((select changes::text from public.bulk_operation
  where id = (select (result->'operation'->>'id')::uuid from launch_first)),
  '[{"fieldId": "title"}]','public changes omit command value');
select is((select public.launch_confirmed_task_preflight(
  'operation-launch-test','8001','Operator','10000000-0000-4000-8000-000000000021',2,
  (snapshot->>'checkedAt')::timestamptz,token,1,false,snapshot,repeat('a',64),
  encode(repeat('y',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),'v1','TC-00000000-0000-4000-8000-000000000021'
)->'operation'->>'id' from launch_fixture),
  (select result->'operation'->>'id' from launch_first),
  'exact token replay returns original operation after draft purge');
select is((select count(*)::integer from public.operation_launch_dispatch
  where operation_id = (select (result->'operation'->>'id')::uuid from launch_first)),1,
  'replay creates no new message');
select throws_ok($$select public.launch_confirmed_task_preflight(
  'operation-launch-test','8001','Operator','10000000-0000-4000-8000-000000000021',2,
  now() - interval '1 minute',(select token from launch_fixture),1,false,
  (select snapshot from launch_fixture),repeat('a',64),
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),'v1','TC-00000000-0000-4000-8000-000000000021'
);$$,'40001','TC_OPERATION_LAUNCH_CONFLICT','replay with changed checkedAt is rejected');
select throws_ok($$select public.launch_confirmed_task_preflight(
  'operation-launch-test','8001','Operator','10000000-0000-4000-8000-000000000021',3,
  now(),gen_random_uuid(),1,false,'{}'::jsonb,repeat('a',64),
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),'v1','TC-00000000-0000-4000-8000-000000000021'
);$$,'40001','TC_OPERATION_LAUNCH_CONFLICT','unknown token cannot launch edited draft');

insert into public.user_settings (
  portal_id,user_id,display_name,access_active,permissions,allowed_field_ids,granted_at
) values
  ('operation-launch-test','8002','Expired operator',true,
    array['app_access','run_bulk_operations','change_allowed_fields']::text[],
    array['title']::text[],now()),
  ('operation-launch-test','8003','Zero operator',true,
    array['app_access','run_bulk_operations','change_allowed_fields']::text[],
    array['title']::text[],now());
insert into public.operation_draft (
  id,portal_id,owner_id,revision,status,selected_task_ids,changes,preflight_snapshot
) values (
  '10000000-0000-4000-8000-000000000022','operation-launch-test','8002',2,
  'awaiting_confirmation',array['42'],
  '[{"fieldId":"title","kind":"text","action":"set","value":"After"}]'::jsonb,
  (select snapshot || jsonb_build_object('draftId','10000000-0000-4000-8000-000000000022')
    from launch_fixture)
), (
  '10000000-0000-4000-8000-000000000023','operation-launch-test','8003',2,
  'awaiting_confirmation',array['42'],
  '[{"fieldId":"title","kind":"text","action":"set","value":"After"}]'::jsonb,
  (select snapshot || jsonb_build_object(
    'draftId','10000000-0000-4000-8000-000000000023','canProceed',false,
    'entries',jsonb_build_array((snapshot->'entries'->0) ||
      jsonb_build_object('disposition','no_change','changedFieldIds','[]'::jsonb)),
    'summary',(snapshot->'summary') ||
      jsonb_build_object('eligible',0,'unchanged',1)) from launch_fixture)
);
insert into public.task_preflight_confirmation (
  portal_id,owner_id,draft_id,draft_revision,token,snapshot_fingerprint,expires_at
) values (
  'operation-launch-test','8002','10000000-0000-4000-8000-000000000022',2,
  '223e4567-e89b-42d3-a456-426614174022',repeat('b',64),now() - interval '1 minute'
);
select throws_ok($$select public.launch_confirmed_task_preflight(
  'operation-launch-test','8002','Expired operator','10000000-0000-4000-8000-000000000022',2,
  (select (preflight_snapshot->>'checkedAt')::timestamptz from public.operation_draft
    where owner_id='8002' and portal_id='operation-launch-test'),
  '223e4567-e89b-42d3-a456-426614174022',1,false,
  (select preflight_snapshot from public.operation_draft
    where owner_id='8002' and portal_id='operation-launch-test'),repeat('b',64),
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),'v1','TC-00000000-0000-4000-8000-000000000021'
);$$,'40001','TC_OPERATION_LAUNCH_CONFLICT','expired token rejected');
create temporary table zero_launch(result jsonb not null);
create temporary table zero_fixture as select preflight_snapshot from public.operation_draft
  where owner_id='8003' and portal_id='operation-launch-test';
insert into zero_launch select public.launch_confirmed_task_preflight(
  'operation-launch-test','8003','Zero operator','10000000-0000-4000-8000-000000000023',2,
  (preflight_snapshot->>'checkedAt')::timestamptz,null,1,false,preflight_snapshot,
  repeat('c',64),null,null,null,'TC-00000000-0000-4000-8000-000000000021'
) from zero_fixture;
select is((select result->'operation'->>'status' from zero_launch),'completed',
  'zero eligible completes synchronously');
select is((select count(*)::integer from public.operation_launch_dispatch where operation_id =
  (select (result->'operation'->>'id')::uuid from zero_launch)),0,'zero eligible sends no message');
select is((select public.launch_confirmed_task_preflight(
  'operation-launch-test','8003','Zero operator','10000000-0000-4000-8000-000000000023',2,
  (preflight_snapshot->>'checkedAt')::timestamptz,null,1,false,preflight_snapshot,
  repeat('c',64),null,null,null,'TC-00000000-0000-4000-8000-000000000021'
)->'operation'->>'id' from zero_fixture),
  (select result->'operation'->>'id' from zero_launch), 'zero result replays by draft revision');

create temporary table launch_claim(first_claim jsonb not null);
insert into launch_claim select public.claim_operation_launch_dispatch(
  'operation-launch-test',(select (result->'operation'->>'id')::uuid from launch_first));
select ok((select first_claim->>'claim_id' is not null from launch_claim),
  'dispatcher claims one stable message');
select is((select public.claim_operation_launch_dispatch(
  'operation-launch-test',(result->'operation'->>'id')::uuid) from launch_first),
  null::jsonb,'concurrent publisher receives an ordinary empty claim');
select is((select public.complete_operation_launch_dispatch(
  'operation-launch-test',(first_claim->>'operation_id')::uuid,
  (first_claim->>'launch_attempt')::integer,(first_claim->>'message_id')::uuid,
  (first_claim->>'claim_id')::uuid,false,'TC-00000000-0000-4000-8000-000000000022'
)->'operation'->>'status' from launch_claim),'launch_failed',
  'failed send makes operation retryable');
select is((select status from public.operation_launch_dispatch where operation_id =
  (select (result->'operation'->>'id')::uuid from launch_first) and launch_attempt=1),
  'failed','failed attempt is fenced');
select throws_ok($$select public.retry_confirmed_operation_launch(
  'operation-launch-test','8001',(select (result->'operation'->>'id')::uuid from launch_first),
  'TC-00000000-0000-4000-8000-000000000023',2,false
);$$,'40001','TC_OPERATION_LAUNCH_ACCESS_CHANGED','retry rejects changed access version');
select is((select public.retry_confirmed_operation_launch(
  'operation-launch-test','8001',(result->'operation'->>'id')::uuid,
  'TC-00000000-0000-4000-8000-000000000023',1,false
)->'operation'->>'launch_attempt' from launch_first),'2',
  'controlled retry advances attempt on same operation');
select is((select count(*)::integer from public.operation_launch_dispatch where operation_id =
  (select (result->'operation'->>'id')::uuid from launch_first)),2,
  'retry creates one additional stable message');
select is((select public.complete_operation_launch_dispatch(
  'operation-launch-test',(first_claim->>'operation_id')::uuid,
  (first_claim->>'launch_attempt')::integer,(first_claim->>'message_id')::uuid,
  (first_claim->>'claim_id')::uuid,true,'TC-00000000-0000-4000-8000-000000000024'
)->>'disposition' from launch_claim),'stale',
  'late completion from previous attempt is ignored');

select * from finish();
rollback;
