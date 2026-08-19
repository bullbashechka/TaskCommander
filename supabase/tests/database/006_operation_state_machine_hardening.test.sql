begin;

select plan(43);

insert into public.portal (id, display_name)
values ('state-machine-hardening-test', 'State machine hardening test portal');

insert into public.user_settings (portal_id, user_id, display_name, access_active)
values
  ('state-machine-hardening-test', '8201', 'First hardening operator', true),
  ('state-machine-hardening-test', '8202', 'Second hardening operator', true),
  ('state-machine-hardening-test', '8203', 'Third hardening operator', true),
  ('state-machine-hardening-test', '8204', 'Fourth hardening operator', true);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.task_result_refinement'::regclass),
  'task result refinements have row level security enabled'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.request_bulk_operation_stop(text,uuid,text,text,text,text)',
    'EXECUTE'
  ),
  'service role cannot call the unfenced stop routine'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.finalize_bulk_operation(text,uuid,text)',
    'EXECUTE'
  ),
  'service role cannot call the unfenced finalization routine'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.record_task_processing_result(text,uuid,text,text,text,text,text[],text[],text[],text,text,text,boolean,bytea,bytea,text,smallint,text,text)',
    'EXECUTE'
  ),
  'service role cannot call the unfenced task result routine'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.request_bulk_operation_cancellation(text,uuid,text)',
    'EXECUTE'
  ),
  'service role can request user cancellation through the dedicated routine'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.request_bulk_operation_interruption_with_attempt(text,uuid,integer,text,text,text)',
    'EXECUTE'
  ),
  'service role can call attempt-fenced interruption'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.finalize_bulk_operation_with_attempt(text,uuid,integer,text)',
    'EXECUTE'
  ),
  'service role can call attempt-fenced finalization'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.record_task_processing_result_with_attempt(text,uuid,integer,text,text,text,text,text[],text[],text[],text,text,text,boolean,bytea,bytea,text,smallint,text,text)',
    'EXECUTE'
  ),
  'service role can call attempt-fenced task result recording'
);

select is(
  public.create_bulk_operation_idempotent(
    'state-machine-hardening-test', 'bulk_change', '8204', 'Fourth hardening operator', null,
    'hardening-no-eligible', null, array['9601'], '[{}]'::jsonb, '{}'::jsonb,
    1, 0, 1, 0, 'TC-123e4567-e89b-42d3-a456-426614174900',
    '[{"taskId":"9601","title":"Excluded task","taskUrl":"https://example.test/task/9601","outcome":"excluded_by_preflight","requestedFieldIds":[],"reasonCode":"NO_ACCESS","reasonMessage":"Not available."}]'::jsonb
  ) -> 'operation' ->> 'status',
  'completed',
  'operation with no eligible tasks completes without a queue consumer'
);

select is(
  (select state_version from public.bulk_operation where idempotency_key = 'hardening-no-eligible'),
  1::bigint,
  'synchronously completed operation starts at state version one'
);

select is(
  public.create_bulk_operation_idempotent(
    'state-machine-hardening-test', 'bulk_change', '8204', 'Fourth hardening operator', null,
    'hardening-no-eligible', null, array['9601'], '[{}]'::jsonb, '{}'::jsonb,
    1, 0, 1, 0, 'TC-123e4567-e89b-42d3-a456-426614174900',
    '[{"taskId":"9601","title":"Excluded task","taskUrl":"https://example.test/task/9601","outcome":"excluded_by_preflight","requestedFieldIds":[],"reasonCode":"NO_ACCESS","reasonMessage":"Changed reason."}]'::jsonb
  ) ->> 'disposition',
  'rejected',
  'same creation key with changed initial results is rejected'
);

select is(
  public.create_bulk_operation_idempotent(
    'state-machine-hardening-test', 'bulk_change', '8201', 'First hardening operator', null,
    'hardening-unconfirmed', null, array['9301', '9302'], '[{}]'::jsonb, '{}'::jsonb,
    2, 2, 0, 0, 'TC-123e4567-e89b-42d3-a456-426614174901', '[]'::jsonb
  ) ->> 'disposition',
  'created',
  'creates a hardening test operation'
);

select is(
  (select state_version from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
  1::bigint,
  'new operation starts at state version one'
);

select is(
  public.start_bulk_operation_with_attempt(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
    1,
    'TC-123e4567-e89b-42d3-a456-426614174902'
  ) ->> 'disposition',
  'applied',
  'starts the expected launch attempt'
);

select is(
  (select state_version from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
  2::bigint,
  'starting advances the state version'
);

select is(
  public.record_task_processing_result_with_attempt(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
    1,
    '9301', 'Unconfirmed task', 'https://example.test/task/9301', 'unconfirmed',
    array['deadline'], array[]::text[], array[]::text[], 'UPSTREAM_OUTCOME_UNKNOWN',
    'The update result could not be confirmed.',
    'TC-123e4567-e89b-42d3-a456-426614174903', true
  ) ->> 'rejected',
  'true',
  'unconfirmed outcomes cannot be marked as eligible for blind retry'
);

select is(
  public.record_task_processing_result_with_attempt(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
    1,
    '9301', 'Unconfirmed task', 'https://example.test/task/9301', 'unconfirmed',
    array['deadline'], array[]::text[], array[]::text[], 'UPSTREAM_OUTCOME_UNKNOWN',
    'The update result could not be confirmed.',
    'TC-123e4567-e89b-42d3-a456-426614174903', false
  ) -> 'summary' ->> 'unconfirmed',
  '1',
  'records an unconfirmed outcome separately'
);

select is(
  public.record_task_processing_result_with_attempt(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
    1,
    '9302', 'Successful task', 'https://example.test/task/9302', 'success',
    array['deadline'], array['deadline'], array[]::text[], null, null,
    'TC-123e4567-e89b-42d3-a456-426614174904', false
  ) ->> 'inserted',
  'true',
  'records a successful outcome'
);

select is(
  public.record_task_processing_result_with_attempt(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
    1,
    '9302', 'Changed title', 'https://example.test/task/9302', 'success',
    array['deadline'], array['deadline'], array[]::text[], null, null,
    'TC-123e4567-e89b-42d3-a456-426614174904', false
  ) ->> 'rejected',
  'true',
  'duplicate result with changed report metadata is rejected'
);

select is(
  public.finalize_bulk_operation(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
    'TC-123e4567-e89b-42d3-a456-426614174905'
  ) -> 'operation' ->> 'status',
  'completed_with_errors',
  'unconfirmed outcome produces a partial terminal operation'
);

select is(
  public.record_task_result_refinement_with_versions(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
    '9301', 'success', array['deadline'], array[]::text[], null, null,
    'TC-123e4567-e89b-42d3-a456-426614174906', false, '', ''
  ) ->> 'rejected',
  'true',
  'invalid refinement versions are rejected before insertion'
);

select is(
  public.record_task_result_refinement(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
    '9301', 'success', array['deadline'], array[]::text[], null, null,
    'TC-123e4567-e89b-42d3-a456-426614174906', false
  ) ->> 'inserted',
  'true',
  'records one immutable late refinement'
);

select is(
  (select state_version from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
  6::bigint,
  'late refinement advances state version without changing the terminal status'
);

select is(
  (select status from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
  'completed_with_errors',
  'late refinement does not rewrite the historical terminal status'
);

select is(
  public.record_task_result_refinement(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
    '9301', 'success', array['deadline'], array[]::text[], null, null,
    'TC-123e4567-e89b-42d3-a456-426614174907', false
  ) ->> 'inserted',
  'false',
  'identical late refinement is idempotent'
);

select is(
  (select state_version from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
  6::bigint,
  'idempotent late refinement does not advance state version'
);

select is(
  public.record_task_result_refinement(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-unconfirmed'),
    '9301', 'conflict', array[]::text[], array['deadline'], 'TASK_CHANGED', 'Task changed.',
    'TC-123e4567-e89b-42d3-a456-426614174908', true
  ) ->> 'rejected',
  'true',
  'conflicting late refinement is rejected'
);

select throws_ok(
  $$update public.task_processing_result
    set outcome = 'success'
    where operation_id = (select id from public.bulk_operation where idempotency_key = 'hardening-unconfirmed')
      and task_id = '9301';$$,
  '23514',
  'Task processing results are immutable.',
  'source task result cannot be changed after recording'
);

select throws_ok(
  $$delete from public.task_processing_result
    where operation_id = (select id from public.bulk_operation where idempotency_key = 'hardening-unconfirmed')
      and task_id = '9302';$$,
  '23514',
  'Task processing results are immutable.',
  'source task result cannot be deleted directly'
);

select is(
  public.create_bulk_operation_idempotent(
    'state-machine-hardening-test', 'bulk_change', '8202', 'Second hardening operator', null,
    'hardening-retry-launch', null, array['9401'], '[{}]'::jsonb, '{}'::jsonb,
    1, 1, 0, 0, 'TC-123e4567-e89b-42d3-a456-426614174909', '[]'::jsonb
  ) ->> 'disposition',
  'created',
  'creates an operation that can retry launch'
);

select is(
  public.fail_bulk_operation_launch_with_attempt(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-retry-launch'),
    1,
    'TC-123e4567-e89b-42d3-a456-426614174910'
  ) -> 'operation' ->> 'status',
  'launch_failed',
  'records a terminal launch failure'
);

select is(
  public.retry_bulk_operation_launch(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-retry-launch'),
    'TC-123e4567-e89b-42d3-a456-426614174911'
  ) -> 'operation' ->> 'launch_attempt',
  '2',
  'retrying launch keeps the operation and advances the attempt'
);

select is(
  public.start_bulk_operation_with_attempt(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-retry-launch'),
    1,
    'TC-123e4567-e89b-42d3-a456-426614174912'
  ) ->> 'disposition',
  'rejected',
  'stale launch attempt cannot start the retried operation'
);

select is(
  public.fail_bulk_operation_launch_with_attempt(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-retry-launch'),
    1,
    'TC-123e4567-e89b-42d3-a456-426614174912'
  ) ->> 'disposition',
  'rejected',
  'stale launch failure cannot terminate the retried operation'
);

select is(
  (select status from public.bulk_operation where idempotency_key = 'hardening-retry-launch'),
  'launching',
  'stale launch failure leaves the current attempt unchanged'
);

select is(
  public.record_task_processing_result_with_attempt(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-retry-launch'),
    1,
    '9401', 'Stale task', 'https://example.test/task/9401', 'success',
    array['deadline'], array['deadline'], array[]::text[], null, null,
    'TC-123e4567-e89b-42d3-a456-426614174912', false
  ) ->> 'rejected',
  'true',
  'stale launch attempt cannot record a task result'
);

select is(
  public.request_bulk_operation_interruption_with_attempt(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-retry-launch'),
    1,
    'CONSUMER_STALE',
    'Stale consumer interruption.',
    'TC-123e4567-e89b-42d3-a456-426614174912'
  ) ->> 'disposition',
  'rejected',
  'stale consumer cannot interrupt the current launch attempt'
);

select is(
  public.finalize_bulk_operation_with_attempt(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-retry-launch'),
    1,
    'TC-123e4567-e89b-42d3-a456-426614174912'
  ) ->> 'disposition',
  'rejected',
  'stale consumer cannot finalize the current launch attempt'
);

select is(
  public.create_bulk_operation_idempotent(
    'state-machine-hardening-test', 'bulk_change', '8203', 'Third hardening operator', null,
    'hardening-cancel-before-start', null, array['9501'], '[{}]'::jsonb, '{}'::jsonb,
    1, 1, 0, 0, 'TC-123e4567-e89b-42d3-a456-426614174913', '[]'::jsonb
  ) ->> 'disposition',
  'created',
  'creates an operation for the launch cancellation race'
);

select is(
  public.request_bulk_operation_stop(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-cancel-before-start'),
    'cancel', null, null, 'TC-123e4567-e89b-42d3-a456-426614174914'
  ) -> 'operation' ->> 'status',
  'cancelled',
  'cancellation while launching is immediately terminal'
);

select is(
  public.fail_bulk_operation_launch_with_attempt(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-cancel-before-start'),
    1,
    'TC-123e4567-e89b-42d3-a456-426614174915'
  ) -> 'operation' ->> 'status',
  'cancelled',
  'late launch failure cannot overwrite the first stop outcome'
);

do $$
declare
  v_operation_id uuid;
begin
  perform public.create_bulk_operation_idempotent(
    'state-machine-hardening-test', 'bulk_change', '8201', 'First hardening operator', null,
    'hardening-stop-priority', null, array['9701'], '[{}]'::jsonb, '{}'::jsonb,
    1, 1, 0, 0, 'TC-123e4567-e89b-42d3-a456-426614174916', '[]'::jsonb
  );
  select id into v_operation_id from public.bulk_operation
  where idempotency_key = 'hardening-stop-priority';
  perform public.start_bulk_operation_with_attempt(
    'state-machine-hardening-test', v_operation_id, 1,
    'TC-123e4567-e89b-42d3-a456-426614174917'
  );
  perform public.record_task_processing_result_with_attempt(
    'state-machine-hardening-test', v_operation_id,
    1,
    '9701', 'Failed task', 'https://example.test/task/9701', 'error',
    array['deadline'], array[]::text[], array['deadline'], 'UPSTREAM_ERROR', 'Update failed.',
    'TC-123e4567-e89b-42d3-a456-426614174918', true
  );
  perform public.request_bulk_operation_stop(
    'state-machine-hardening-test', v_operation_id,
    'cancel', null, null, 'TC-123e4567-e89b-42d3-a456-426614174919'
  );
end;
$$;

select is(
  public.finalize_bulk_operation(
    'state-machine-hardening-test',
    (select id from public.bulk_operation where idempotency_key = 'hardening-stop-priority'),
    'TC-123e4567-e89b-42d3-a456-426614174920'
  ) -> 'operation' ->> 'status',
  'cancelled',
  'cancellation has priority over an already recorded task error'
);

select is(
  (select failed_count from public.bulk_operation where idempotency_key = 'hardening-stop-priority'),
  1,
  'cancellation preserves already recorded task errors'
);

select * from finish();

rollback;
