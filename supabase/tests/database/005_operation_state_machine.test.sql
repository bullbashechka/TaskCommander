begin;

select plan(13);

insert into public.portal (id, display_name)
values ('state-machine-test', 'State machine test portal');

insert into public.user_settings (portal_id, user_id, display_name, access_active)
values
  ('state-machine-test', '8101', 'First state operator', true),
  ('state-machine-test', '8102', 'Second state operator', true);

select is(
  public.create_bulk_operation_idempotent(
    'state-machine-test', 'bulk_change', '8101', 'First state operator', null,
    'state-machine-primary', null, array['9101'], '[{}]'::jsonb, '{}'::jsonb,
    1, 1, 0, 0, 'TC-123e4567-e89b-42d3-a456-426614174801', '[]'::jsonb
  ) ->> 'disposition',
  'created',
  'creates an operation once'
);

select is(
  public.create_bulk_operation_idempotent(
    'state-machine-test', 'bulk_change', '8101', 'First state operator', null,
    'state-machine-primary', null, array['9101'], '[{}]'::jsonb, '{}'::jsonb,
    1, 1, 0, 0, 'TC-123e4567-e89b-42d3-a456-426614174801', '[]'::jsonb
  ) ->> 'disposition',
  'existing',
  'identical creation returns the existing operation'
);

select is(
  public.create_bulk_operation_idempotent(
    'state-machine-test', 'bulk_change', '8101', 'First state operator', null,
    'state-machine-primary', null, array['9101'], '[{"different":true}]'::jsonb, '{}'::jsonb,
    1, 1, 0, 0, 'TC-123e4567-e89b-42d3-a456-426614174802', '[]'::jsonb
  ) ->> 'disposition',
  'rejected',
  'same key with different content is rejected'
);

select is(
  (select count(*)::integer from public.audit_event where portal_id = 'state-machine-test' and action = 'system_error'),
  1,
  'a rejected idempotency mismatch is retained in the audit journal'
);

select is(
  public.create_bulk_operation_idempotent(
    'state-machine-test', 'bulk_change', '8101', 'First state operator', null,
    'state-machine-secondary', null, array['9102'], '[{}]'::jsonb, '{}'::jsonb,
    1, 1, 0, 0, 'TC-123e4567-e89b-42d3-a456-426614174803', '[]'::jsonb
  ) ->> 'disposition',
  'active_operation',
  'a different active operation for the same initiator is blocked'
);

select is(
  public.start_bulk_operation(
    'state-machine-test',
    (select id from public.bulk_operation where idempotency_key = 'state-machine-primary'),
    'TC-123e4567-e89b-42d3-a456-426614174804'
  ) ->> 'disposition',
  'applied',
  'starts a launching operation'
);

select lives_ok(
  $$select public.record_task_processing_result(
    'state-machine-test',
    (select id from public.bulk_operation where idempotency_key = 'state-machine-primary'),
    '9101', 'Task', 'https://example.test/task/9101', 'success',
    array[]::text[], array[]::text[], array[]::text[], null, null,
    'TC-123e4567-e89b-42d3-a456-426614174805', false
  );$$,
  'records a task result while running'
);

select is(
  public.finalize_bulk_operation(
    'state-machine-test',
    (select id from public.bulk_operation where idempotency_key = 'state-machine-primary'),
    'TC-123e4567-e89b-42d3-a456-426614174806'
  ) ->> 'disposition',
  'applied',
  'finalizes from saved results'
);

select is(
  (select status from public.bulk_operation where idempotency_key = 'state-machine-primary'),
  'completed',
  'successful processing produces completed'
);

select is(
  public.create_bulk_operation_idempotent(
    'state-machine-test', 'bulk_change', '8102', 'Second state operator', null,
    'state-machine-cancelled', null, array['9201'], '[{}]'::jsonb, '{}'::jsonb,
    1, 1, 0, 0, 'TC-123e4567-e89b-42d3-a456-426614174807', '[]'::jsonb
  ) ->> 'disposition',
  'created',
  'another initiator can create an operation'
);

select lives_ok(
  $$select public.request_bulk_operation_stop(
    'state-machine-test',
    (select id from public.bulk_operation where idempotency_key = 'state-machine-cancelled'),
    'cancel', null, null, 'TC-123e4567-e89b-42d3-a456-426614174808'
  );$$,
  'accepts cancellation before start'
);

select is(
  public.finalize_bulk_operation(
    'state-machine-test',
    (select id from public.bulk_operation where idempotency_key = 'state-machine-cancelled'),
    'TC-123e4567-e89b-42d3-a456-426614174809'
  ) -> 'operation' ->> 'status',
  'cancelled',
  'cancellation before start creates a cancelled operation'
);

select throws_ok(
  $$update public.bulk_operation set status = 'running'
    where portal_id = 'state-machine-test' and idempotency_key = 'state-machine-primary';$$,
  '23514',
  'Bulk operation status changes require the state machine.',
  'direct status changes are rejected'
);

select * from finish();

rollback;
