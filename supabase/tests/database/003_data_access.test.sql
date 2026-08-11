begin;

select plan(12);

insert into public.portal (id, display_name)
values ('data-access-test', 'Data access test portal');

insert into public.user_settings (portal_id, user_id, display_name, access_active)
values ('data-access-test', '7001', 'Data access operator', true);

select lives_ok(
  $$select public.save_operation_draft(
    'data-access-test', '7001', 0, 'preparing', null, null, array['8101'], '[{}]'::jsonb, null, false
  );$$,
  'creates an operation draft'
);

select throws_ok(
  $$select public.save_operation_draft(
    'data-access-test', '7001', 0, 'preparing', null, null, array['8101'], '[{}]'::jsonb, null, false
  );$$,
  'P0001',
  'TC_DRAFT_REVISION_CONFLICT',
  'stale draft revision is rejected'
);

insert into public.bulk_operation (
  id,
  portal_id,
  operation_type,
  status,
  initiator_id,
  initiator_display_name,
  idempotency_key,
  selected_task_ids,
  changes,
  preflight_snapshot,
  selected_count,
  eligible_count
)
values (
  '00000000-0000-4000-8000-000000000701',
  'data-access-test',
  'bulk_change',
  'launching',
  '7001',
  'Data access operator',
  'data-access-test-operation',
  array['8101', '8102'],
  '[{}]'::jsonb,
  '{}'::jsonb,
  2,
  2
);

select lives_ok(
  $$select public.record_task_processing_result(
    'data-access-test',
    '00000000-0000-4000-8000-000000000701',
    '8101',
    'First task',
    'https://example.test/task/8101',
    'success',
    array[]::text[],
    array[]::text[],
    array[]::text[],
    null,
    null,
    null,
    false
  );$$,
  'stores the first task result'
);

select is(
  (select successful_count from public.bulk_operation where id = '00000000-0000-4000-8000-000000000701'),
  1,
  'new successful result increments the counter once'
);

select lives_ok(
  $$select public.record_task_processing_result(
    'data-access-test',
    '00000000-0000-4000-8000-000000000701',
    '8101',
    'First task',
    'https://example.test/task/8101',
    'success',
    array[]::text[],
    array[]::text[],
    array[]::text[],
    null,
    null,
    null,
    false
  );$$,
  'identical retry returns the existing result'
);

select is(
  (select successful_count from public.bulk_operation where id = '00000000-0000-4000-8000-000000000701'),
  1,
  'identical retry does not increment the counter'
);

select throws_ok(
  $$select public.record_task_processing_result(
    'data-access-test',
    '00000000-0000-4000-8000-000000000701',
    '8101',
    'First task',
    'https://example.test/task/8101',
    'error',
    array[]::text[],
    array[]::text[],
    array[]::text[],
    'UPSTREAM_FAILURE',
    'Different retry',
    null,
    true
  );$$,
  'P0001',
  'TC_TASK_RESULT_CONFLICT',
  'different retry is rejected'
);

select lives_ok(
  $$select public.record_task_processing_result(
    'data-access-test',
    '00000000-0000-4000-8000-000000000701',
    '8102',
    'Second task',
    'https://example.test/task/8102',
    'success',
    array[]::text[],
    array[]::text[],
    array[]::text[],
    null,
    null,
    null,
    false,
    decode('0304', 'hex'),
    decode('0b0a09080706050403020100', 'hex'),
    'key-v2',
    1,
    'before-v1',
    'after-v1'
  );$$,
  'stores a protected result'
);

select lives_ok(
  $$select public.record_task_processing_result(
    'data-access-test',
    '00000000-0000-4000-8000-000000000701',
    '8102',
    'Second task',
    'https://example.test/task/8102',
    'success',
    array[]::text[],
    array[]::text[],
    array[]::text[],
    null,
    null,
    null,
    false,
    decode('0102', 'hex'),
    decode('000102030405060708090a0b', 'hex'),
    'key-v1',
    1,
    'before-v1',
    'after-v1'
  );$$,
  'logically identical re-encrypted retry returns the existing result'
);

select throws_ok(
  $$select public.record_task_processing_result(
    'data-access-test',
    '00000000-0000-4000-8000-000000000701',
    '8102',
    'Second task',
    'https://example.test/task/8102',
    'success',
    array[]::text[],
    array[]::text[],
    array[]::text[],
    null,
    null,
    null,
    false,
    decode('0102', 'hex'),
    decode('000102030405060708090a0b', 'hex'),
    'key-v1',
    1,
    'before-v1',
    'after-v2'
  );$$,
  'P0001',
  'TC_TASK_RESULT_CONFLICT',
  'different protected retry is rejected'
);

select lives_ok(
  $$select public.transition_bulk_operation_status(
    'data-access-test',
    '00000000-0000-4000-8000-000000000701',
    array['launching'],
    'running',
    true,
    true,
    false
  );$$,
  'conditional status transition succeeds'
);

select throws_ok(
  $$select public.transition_bulk_operation_status(
    'data-access-test',
    '00000000-0000-4000-8000-000000000701',
    array['launching'],
    'completed',
    false,
    false,
    true
  );$$,
  'P0001',
  'TC_OPERATION_TRANSITION_CONFLICT',
  'stale status transition is rejected'
);

select * from finish();

rollback;
