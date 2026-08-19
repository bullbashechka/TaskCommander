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
  'running',
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

select is(
  (public.record_task_processing_result(
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
  ) ->> 'rejected')::boolean,
  true,
  'different retry is rejected without changing the stored result'
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

select is(
  (public.record_task_processing_result(
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
  ) ->> 'rejected')::boolean,
  true,
  'different protected retry is rejected without changing the stored result'
);

select is(
  public.start_bulk_operation_with_attempt(
    'data-access-test',
    '00000000-0000-4000-8000-000000000701',
    1,
    'TC-123e4567-e89b-42d3-a456-426614174701'
  ) ->> 'disposition',
  'already_applied',
  'repeated start returns the running operation'
);

select is(
  public.finalize_bulk_operation(
    'data-access-test',
    '00000000-0000-4000-8000-000000000701',
    'TC-123e4567-e89b-42d3-a456-426614174702'
  ) ->> 'disposition',
  'applied',
  'finalization computes the terminal state from saved results'
);

select * from finish();

rollback;
