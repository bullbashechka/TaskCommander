begin;
select plan(36);

insert into public.portal(id,display_name) values ('operation-consumer-test','Operation consumer test');
insert into public.user_settings(portal_id,user_id,display_name,access_active,
  permissions,allowed_field_ids,granted_at)
values('operation-consumer-test','8001','Operator',true,
  array['app_access','run_bulk_operations','change_allowed_fields','view_own_reports']::text[],
  array['title']::text[],now());

create temporary table consumer_fixture(operation_id uuid not null);
insert into consumer_fixture(operation_id)
select (public.create_bulk_operation_idempotent(
  'operation-consumer-test','bulk_change','8001','Operator',null,'consumer-test-key',null,
  array['42'],'[{"fieldId":"title"}]'::jsonb,'{}'::jsonb,
  1,1,0,0,'TC-123e4567-e89b-42d3-a456-426614174900','[]'::jsonb
)->'operation'->>'id')::uuid;

select ok((select relrowsecurity from pg_class
  where oid='public.operation_task_claim'::regclass),'claims use RLS');
select ok(not has_function_privilege('authenticated',
  'public.apply_claimed_mock_task_change(text,uuid,integer,text,uuid,bigint,jsonb,jsonb)',
  'EXECUTE'),'client cannot invoke mock CAS');
select is((select public.start_bulk_operation_with_attempt('operation-consumer-test',
  operation_id,1,'TC-123e4567-e89b-42d3-a456-426614174901')->'operation'->>'status'
  from consumer_fixture),'running','operation starts only at expected attempt');
select ok((select public.reserve_operation_api_slot('operation-consumer-test',operation_id,1)
  from consumer_fixture) >= 0,'portal API slot is reserved for running attempt');
select is((select public.claim_operation_task('operation-consumer-test',operation_id,1,
  '42','123e4567-e89b-42d3-a456-426614174902')->>'disposition' from consumer_fixture),
  'claimed','first worker owns task before write');
select is((select public.claim_operation_task('operation-consumer-test',operation_id,1,
  '42','123e4567-e89b-42d3-a456-426614174903')->>'disposition' from consumer_fixture),
  'busy','duplicate worker cannot write');
select is((select public.claim_operation_task('operation-consumer-test',operation_id,2,
  '42','123e4567-e89b-42d3-a456-426614174903')->>'disposition' from consumer_fixture),
  'stale','old or future launch attempt cannot claim');
select is((select public.mark_operation_task_writing('operation-consumer-test',operation_id,1,
  '42','123e4567-e89b-42d3-a456-426614174902','mock:0',0,999,array['title'],
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),'v1',1)
  from consumer_fixture),false,'changed access version blocks write intent');
select is((select public.mark_operation_task_writing('operation-consumer-test',operation_id,1,
  '42','123e4567-e89b-42d3-a456-426614174902','mock:0',0,1,array['title'],
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),'v1',1)
  from consumer_fixture),true,'intent and encrypted before-values persist');
select ok((select lease_until > now() + interval '1 minute'
  from public.operation_task_claim where operation_id=(select operation_id from consumer_fixture)
  and task_id='42'),'entering writing renews lease after pre-write waits');
select is((select public.apply_claimed_mock_task_change('operation-consumer-test',operation_id,1,
  '42','123e4567-e89b-42d3-a456-426614174903',0,
  '{"id":"42","values":{"title":"Before"}}'::jsonb,
  '{"title":"After"}'::jsonb)->>'kind' from consumer_fixture),'stale',
  'wrong fencing token cannot mutate task');
update public.operation_task_claim set lease_until = now() - interval '1 second'
  where operation_id=(select operation_id from consumer_fixture) and task_id='42';
select is((select public.apply_claimed_mock_task_change('operation-consumer-test',operation_id,1,
  '42','123e4567-e89b-42d3-a456-426614174902',0,
  '{"id":"42","values":{"title":"Before"}}'::jsonb,
  '{"title":"After"}'::jsonb)->>'kind' from consumer_fixture),'stale',
  'expired writing lease cannot authorize a late write');
update public.operation_task_claim set lease_until = now() + interval '2 minutes'
  where operation_id=(select operation_id from consumer_fixture) and task_id='42';
savepoint revoked_before_cas;
update public.user_settings set allowed_field_ids='{}'::text[]
  where portal_id='operation-consumer-test' and user_id='8001';
select is((select public.apply_claimed_mock_task_change('operation-consumer-test',operation_id,1,
  '42','123e4567-e89b-42d3-a456-426614174902',0,
  '{"id":"42","values":{"title":"Before"}}'::jsonb,
  '{"title":"After"}'::jsonb)->>'kind' from consumer_fixture),'stale',
  'permission revoked after intent blocks CAS');
rollback to savepoint revoked_before_cas;
select is((select public.apply_claimed_mock_task_change('operation-consumer-test',operation_id,1,
  '42','123e4567-e89b-42d3-a456-426614174902',0,
  '{"id":"42","values":{"title":"Before"}}'::jsonb,
  '{"title":"After"}'::jsonb)->>'kind' from consumer_fixture),'success',
  'fenced CAS applies task once');
select is((select mutation_version from public.mock_task_state where portal_id='operation-consumer-test'
  and task_id='42'),1::bigint,'full task mutation version increments');
select is((select public.apply_claimed_mock_task_change('operation-consumer-test',operation_id,1,
  '42','123e4567-e89b-42d3-a456-426614174902',0,
  '{"id":"42","values":{"title":"Before"}}'::jsonb,
  '{"title":"After"}'::jsonb)->>'kind' from consumer_fixture),'stale',
  'lost response does not allow a second write');
select is((select public.record_claimed_task_result('operation-consumer-test',operation_id,1,
  '42','123e4567-e89b-42d3-a456-426614174902','Task',
  'https://portal.bitrix24.ru/tasks/42','success',array['title'],array['title'],
  '{}'::text[],null,null,'TC-123e4567-e89b-42d3-a456-426614174904',false,'mock:1'
)->>'inserted' from consumer_fixture),'true','result commits after CAS');
select is((select count(*)::integer from public.protected_task_result as protected
  join public.task_processing_result as result on result.id=protected.task_processing_result_id
  where result.task_id='42' and result.operation_id=(select operation_id from consumer_fixture)),1,
  'encrypted previous values commit with result');
select is((select public.record_claimed_task_result('operation-consumer-test',operation_id,1,
  '42','123e4567-e89b-42d3-a456-426614174902','Task',
  'https://portal.bitrix24.ru/tasks/42','success',array['title'],array['title'],
  '{}'::text[],null,null,'TC-123e4567-e89b-42d3-a456-426614174906',false,'mock:1'
)->>'inserted' from consumer_fixture),'false','exact result replay returns existing row');
select is((select public.record_claimed_task_result('operation-consumer-test',operation_id,1,
  '42','123e4567-e89b-42d3-a456-426614174902','Different',
  'https://portal.bitrix24.ru/tasks/42','success',array['title'],array['title'],
  '{}'::text[],null,null,'TC-123e4567-e89b-42d3-a456-426614174907',false,'mock:1'
)->>'reasonCode' from consumer_fixture),'TASK_RESULT_CONFLICT',
  'divergent result replay is rejected and audited');
select is((select count(*)::integer from public.audit_event
  where portal_id='operation-consumer-test' and correlation_id='TC-123e4567-e89b-42d3-a456-426614174907'
    and metadata->>'errorCode'='TASK_RESULT_CONFLICT'),1,
  'divergent result replay emits one audit event');
select is((select count(*)::integer from public.task_processing_result
  where operation_id=(select operation_id from consumer_fixture) and task_id='42'),1,
  'result replay does not change persisted counters');
select is((select public.claim_operation_task('operation-consumer-test',operation_id,1,
  '42','123e4567-e89b-42d3-a456-426614174903')->>'disposition' from consumer_fixture),
  'done','duplicate delivery sees completed task');
select is((select successful_count from public.bulk_operation
  where id=(select operation_id from consumer_fixture)),1,'counter changes once');
select is((select public.finalize_bulk_operation_with_attempt('operation-consumer-test',
  operation_id,1,'TC-123e4567-e89b-42d3-a456-426614174905')->'operation'->>'status'
  from consumer_fixture),'completed','finalization requires persisted eligible result');
select is(public.mutate_mock_task_state('operation-consumer-test','42',1,
  '{"id":"42","values":{"title":"After","description":"External"}}'::jsonb),2::bigint,
  'scenario mutation advances the full-task version');
select is(public.mutate_mock_task_state('operation-consumer-test','42',1,
  '{"id":"42","values":{"title":"Stale"}}'::jsonb),null::bigint,
  'stale scenario mutation cannot overwrite a later task version');

create temporary table consumer_retry_fixture(operation_id uuid not null);
insert into consumer_retry_fixture(operation_id)
select (public.create_bulk_operation_idempotent(
  'operation-consumer-test','bulk_change','8001','Operator',null,'consumer-retry-key',null,
  array['43'],'[{"fieldId":"title"}]'::jsonb,'{}'::jsonb,
  1,1,0,0,'TC-123e4567-e89b-42d3-a456-426614174908','[]'::jsonb
)->'operation'->>'id')::uuid;
select is((select public.start_bulk_operation_with_attempt('operation-consumer-test',
  operation_id,1,'TC-123e4567-e89b-42d3-a456-426614174909')->'operation'->>'status'
  from consumer_retry_fixture),'running','retry fixture starts');
select is((select public.claim_operation_task('operation-consumer-test',operation_id,1,
  '43','123e4567-e89b-42d3-a456-426614174910')->>'disposition'
  from consumer_retry_fixture),'claimed','retry task is claimed');
select is((select public.mark_operation_task_writing('operation-consumer-test',operation_id,1,
  '43','123e4567-e89b-42d3-a456-426614174910','mock:0',0,1,array['title'],
  encode(repeat('x',32)::bytea,'base64'),encode(repeat('n',12)::bytea,'base64'),'v1',1)
  from consumer_retry_fixture),true,'write intent exists before transient failure');
select is((select public.release_rate_limited_operation_task('operation-consumer-test',
  operation_id,'43','123e4567-e89b-42d3-a456-426614174910')
  from consumer_retry_fixture),true,'known no-write rate limit releases intent for retry');
select is((select public.claim_operation_task('operation-consumer-test',operation_id,1,
  '43','123e4567-e89b-42d3-a456-426614174911')->>'disposition'
  from consumer_retry_fixture),'claimed','released task is available to redelivery');

do $$
declare v_operation_id uuid;
begin
  select operation_id into v_operation_id from consumer_retry_fixture;
  perform public.request_bulk_operation_interruption_with_attempt('operation-consumer-test',
    v_operation_id,1,'INTERRUPTED','Test interruption',
    'TC-123e4567-e89b-42d3-a456-426614174912');
  perform public.finalize_bulk_operation_with_attempt('operation-consumer-test',
    v_operation_id,1,'TC-123e4567-e89b-42d3-a456-426614174913');
end;
$$;
create temporary table consumer_terminal_fixture(operation_id uuid not null);
insert into consumer_terminal_fixture(operation_id)
select (public.create_bulk_operation_idempotent(
  'operation-consumer-test','bulk_change','8001','Operator',null,'consumer-terminal-key',null,
  array['44'],'[{"fieldId":"title"}]'::jsonb,'{}'::jsonb,
  1,1,0,0,'TC-123e4567-e89b-42d3-a456-426614174914','[]'::jsonb
)->'operation'->>'id')::uuid;
select is((select public.request_bulk_operation_interruption_with_attempt(
  'operation-consumer-test',operation_id,1,'INTERRUPTED','Plan unavailable',
  'TC-123e4567-e89b-42d3-a456-426614174915')->>'disposition'
  from consumer_terminal_fixture),'applied','pre-start permanent failure requests interruption');
select is((select public.finalize_bulk_operation_with_attempt('operation-consumer-test',
  operation_id,1,'TC-123e4567-e89b-42d3-a456-426614174916')->'operation'->>'status'
  from consumer_terminal_fixture),'interrupted','pre-start failure becomes terminal');
select is((select not_processed_count from public.bulk_operation
  where id=(select operation_id from consumer_terminal_fixture)),1,
  'pre-start terminal transition records unprocessed task');
select is((select public.read_operation_execution('operation-consumer-test',operation_id,1)
  from consumer_terminal_fixture),null::jsonb,
  'terminal attempt is invisible to Queue redelivery');

select * from finish();
rollback;
