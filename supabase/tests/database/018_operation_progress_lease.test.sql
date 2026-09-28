begin;
select plan(32);

insert into public.portal(id, display_name) values ('operation-progress-test', 'Operation progress test');
insert into public.user_settings(portal_id,user_id,display_name,access_active,
  permissions,allowed_field_ids,granted_at)
values ('operation-progress-test','8001','Operator',true,
  array['app_access','run_bulk_operations','change_allowed_fields','view_own_reports']::text[],
  array['title']::text[],now());

create temporary table progress_fixture(kind text primary key, operation_id uuid not null);
insert into progress_fixture(kind,operation_id)
select 'before-start', (public.create_bulk_operation_idempotent(
  'operation-progress-test','bulk_change','8001','Operator',null,'progress-before-start',null,
  array['41'],'[{"fieldId":"title"}]'::jsonb,'{}'::jsonb,
  1,1,0,0,'TC-123e4567-e89b-42d3-a456-426614174a01','[]'::jsonb
)->'operation'->>'id')::uuid;

select ok((select relrowsecurity from pg_class
  where oid = 'public.operation_execution_lease'::regclass), 'lease table uses RLS');
select ok(not has_function_privilege('authenticated',
  'public.acquire_operation_execution_lease(text,uuid,integer,uuid)','EXECUTE'),
  'browser role cannot acquire execution lease');
select is((select public.request_owned_operation_cancellation('operation-progress-test','9999',
  operation_id,'TC-123e4567-e89b-42d3-a456-426614174a02',null,true)->>'reasonCode'
  from progress_fixture where kind='before-start'), 'OPERATION_UNAVAILABLE',
  'another owner cannot cancel');
select is((select public.request_owned_operation_cancellation('operation-progress-test','8001',
  operation_id,'TC-123e4567-e89b-42d3-a456-426614174a03',1,false)
  ->'operation'->>'status' from progress_fixture where kind='before-start'), 'cancelled',
  'cancellation before consumer start is terminal');
select is((select not_processed_count from public.bulk_operation
  where id=(select operation_id from progress_fixture where kind='before-start')),1,
  'before-start cancellation records remaining task');

insert into progress_fixture(kind,operation_id)
select 'without-lease', (public.create_bulk_operation_idempotent(
  'operation-progress-test','bulk_change','8001','Operator',null,'progress-without-lease',null,
  array['42'],'[{"fieldId":"title"}]'::jsonb,'{}'::jsonb,
  1,1,0,0,'TC-123e4567-e89b-42d3-a456-426614174a04','[]'::jsonb
)->'operation'->>'id')::uuid;
select is((select public.start_bulk_operation_with_attempt('operation-progress-test',
  operation_id,1,'TC-123e4567-e89b-42d3-a456-426614174a05')
  ->'operation'->>'status' from progress_fixture where kind='without-lease'), 'running',
  'attempt starts');
select is((select public.request_owned_operation_cancellation('operation-progress-test','8001',
  operation_id,'TC-123e4567-e89b-42d3-a456-426614174a06',1,false)
  ->'operation'->>'status' from progress_fixture where kind='without-lease'), 'cancelled',
  'running operation without worker lease stops atomically');

insert into progress_fixture(kind,operation_id)
select 'expired', (public.create_bulk_operation_idempotent(
  'operation-progress-test','bulk_change','8001','Operator',null,'progress-expired',null,
  array['43','44'],'[{"fieldId":"title"}]'::jsonb,'{}'::jsonb,
  2,2,0,0,'TC-123e4567-e89b-42d3-a456-426614174a07','[]'::jsonb
)->'operation'->>'id')::uuid;
select is((select public.start_bulk_operation_with_attempt('operation-progress-test',
  operation_id,1,'TC-123e4567-e89b-42d3-a456-426614174a08')
  ->'operation'->>'status' from progress_fixture where kind='expired'), 'running',
  'expiring fixture starts');
select is((select public.acquire_operation_execution_lease('operation-progress-test',
  operation_id,1,'123e4567-e89b-42d3-a456-426614174a09')
  from progress_fixture where kind='expired'), true, 'first delivery acquires lease');
select is((select public.acquire_operation_execution_lease('operation-progress-test',
  operation_id,1,'123e4567-e89b-42d3-a456-426614174a10')
  from progress_fixture where kind='expired'), false, 'duplicate delivery cannot steal lease');
select is((select public.claim_operation_task('operation-progress-test',operation_id,1,'43',
  '123e4567-e89b-42d3-a456-426614174a11')->>'disposition'
  from progress_fixture where kind='expired'), 'claimed', 'first task is claimed');
select is((select public.mark_operation_task_writing('operation-progress-test',operation_id,1,
  '43','123e4567-e89b-42d3-a456-426614174a11','mock:0',0,1,array['title'],
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),'v1',1)
  from progress_fixture where kind='expired'), true, 'encrypted write intent is durable');
select is((select public.renew_operation_execution_lease('operation-progress-test',operation_id,
  1,'123e4567-e89b-42d3-a456-426614174a10','43',
  '123e4567-e89b-42d3-a456-426614174a11')
  from progress_fixture where kind='expired'), false, 'another delivery cannot renew');
select is((select public.renew_operation_execution_lease('operation-progress-test',operation_id,
  1,'123e4567-e89b-42d3-a456-426614174a09','43',
  '123e4567-e89b-42d3-a456-426614174a11')
  from progress_fixture where kind='expired'), true, 'current worker renews task and execution lease');
update public.operation_execution_lease set expires_at=now()+interval '1 minute'
  where operation_id=(select operation_id from progress_fixture where kind='expired');
select is((select public.renew_operation_execution_lease('operation-progress-test',operation_id,
  1,'123e4567-e89b-42d3-a456-426614174a09','43',
  '123e4567-e89b-42d3-a456-426614174a10')
  from progress_fixture where kind='expired'), false, 'stale task claim cannot renew');
select is((select expires_at from public.operation_execution_lease
  where operation_id=(select operation_id from progress_fixture where kind='expired')),
  now()+interval '1 minute', 'stale claim leaves execution lease unchanged');
update public.operation_execution_lease set expires_at=now()-interval '1 second'
  where operation_id=(select operation_id from progress_fixture where kind='expired');
select is(public.expire_operation_execution_leases(10),1,'watchdog handles expired worker');
select is((select status from public.bulk_operation
  where id=(select operation_id from progress_fixture where kind='expired')),
  'interrupted','expired worker leaves terminal interrupted operation');
select is((select count(*)::integer from public.audit_event
  where portal_id='operation-progress-test' and subject_id =
    (select operation_id::text from progress_fixture where kind='expired')
    and action='operation_interrupt'),1,'watchdog interruption is audited');
select is((select array_agg(outcome order by task_id) from public.task_processing_result
  where operation_id=(select operation_id from progress_fixture where kind='expired')),
  array['unconfirmed','not_processed']::text[],
  'in-flight task is unconfirmed and untouched task is not processed');
select is((select unconfirmed_count + not_processed_count from public.bulk_operation
  where id=(select operation_id from progress_fixture where kind='expired')),2,
  'persisted counters include both terminal task outcomes');
select is((select public.renew_operation_execution_lease('operation-progress-test',operation_id,
  1,'123e4567-e89b-42d3-a456-426614174a09',null,null)
  from progress_fixture where kind='expired'), false, 'stale worker cannot renew after interruption');
select throws_ok(
  $$select public.request_owned_operation_cancellation('operation-progress-test','8001',
    (select operation_id from progress_fixture where kind='expired'),
    'TC-123e4567-e89b-42d3-a456-426614174a12',999,false);$$,
  '40001', 'TC_OPERATION_CANCEL_ACCESS_CHANGED',
  'stale access version cannot request cancellation');
select throws_ok(
  $$select public.request_owned_operation_cancellation('operation-progress-test','8001',
    (select operation_id from progress_fixture where kind='expired'),
    'TC-123e4567-e89b-42d3-a456-426614174a13',1,null);$$,
  '22023', 'TC_OPERATION_CANCEL_INVALID',
  'invalid administrator claim is rejected');

insert into progress_fixture(kind,operation_id)
select 'applied', (public.create_bulk_operation_idempotent(
  'operation-progress-test','bulk_change','8001','Operator',null,'progress-applied',null,
  array['45'],'[{"fieldId":"title"}]'::jsonb,'{}'::jsonb,
  1,1,0,0,'TC-123e4567-e89b-42d3-a456-426614174a14','[]'::jsonb
)->'operation'->>'id')::uuid;
select is((select public.start_bulk_operation_with_attempt('operation-progress-test',
  operation_id,1,'TC-123e4567-e89b-42d3-a456-426614174a15')
  ->'operation'->>'status' from progress_fixture where kind='applied'), 'running',
  'applied claim fixture starts');
select is((select public.acquire_operation_execution_lease('operation-progress-test',
  operation_id,1,'123e4567-e89b-42d3-a456-426614174a16')
  from progress_fixture where kind='applied'), true, 'applied claim fixture owns lease');
select is((select public.claim_operation_task('operation-progress-test',operation_id,1,'45',
  '123e4567-e89b-42d3-a456-426614174a17')->>'disposition'
  from progress_fixture where kind='applied'), 'claimed', 'applied fixture claims task');
select is((select public.mark_operation_task_writing('operation-progress-test',operation_id,1,
  '45','123e4567-e89b-42d3-a456-426614174a17','mock:0',0,1,array['title'],
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),'v1',1)
  from progress_fixture where kind='applied'), true, 'applied fixture protects before-values');
update public.operation_task_claim set phase='applied',after_mutation_version=1,
  applied_field_ids=array['title'] where operation_id=(select operation_id
    from progress_fixture where kind='applied') and task_id='45';
update public.operation_execution_lease set expires_at=now()-interval '1 second'
  where operation_id=(select operation_id from progress_fixture where kind='applied');
select is(public.expire_operation_execution_leases(10),1,
  'watchdog classifies lost applied claim');
select is((select phase from public.operation_task_claim where operation_id=
  (select operation_id from progress_fixture where kind='applied') and task_id='45'),
  'done','watchdog leaves claim eligible for protected refinement');
select is((select public.refine_claimed_task_result('operation-progress-test',operation_id,'45',
  '123e4567-e89b-42d3-a456-426614174a17','mock:1',
  'TC-123e4567-e89b-42d3-a456-426614174a18')->>'inserted'
  from progress_fixture where kind='applied'), 'true',
  'confirmed late mock read can refine an unconfirmed result');
select is((select count(*)::integer from public.protected_task_result as protected
  join public.task_processing_result as result on result.id=protected.task_processing_result_id
  where result.operation_id=(select operation_id from progress_fixture where kind='applied')),
  1,'late success retains encrypted previous values');

select * from finish();
rollback;
