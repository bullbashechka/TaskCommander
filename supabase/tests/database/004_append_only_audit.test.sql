begin;

select plan(12);

insert into public.portal (id, display_name)
values ('audit-test', 'Audit test portal');

select lives_ok(
  $$select public.append_audit_event(
    'audit-test', now(), 'operation_create', 'user', '8001', 'Audit operator', null,
    'operation_attempt', 'attempt-1', 'Попытка создания операции', '[]'::jsonb,
    'success', 'TC-123e4567-e89b-42d3-a456-426614174000', 'request-1', 'result',
    '{"kind":"operation","reasonCode":null,"summary":null}'::jsonb
  );$$,
  'appends a valid audit event'
);

select is(
  (select count(*)::integer from public.audit_event where portal_id = 'audit-test'),
  1,
  'one event is stored'
);

select throws_ok(
  $$insert into public.audit_event (portal_id, action, outcome)
    values ('audit-test', 'operation_create', 'success');$$,
  '23502',
  '.*null value.*',
  'rejects an event without mandatory fields'
);

select lives_ok(
  $$select public.append_audit_event(
    'audit-test', (select occurred_at from public.audit_event where portal_id = 'audit-test'),
    'operation_create', 'user', '8001', 'Audit operator', null,
    'operation_attempt', 'attempt-1', 'Попытка создания операции', '[]'::jsonb,
    'success', 'TC-123e4567-e89b-42d3-a456-426614174000', 'request-1', 'result',
    '{"kind":"operation","reasonCode":null,"summary":null}'::jsonb
  );$$,
  'returns the existing event for an identical retry'
);

select is(
  (select count(*)::integer from public.audit_event where portal_id = 'audit-test'),
  1,
  'an identical retry does not duplicate the event'
);

select throws_ok(
  $$select public.append_audit_event(
    'audit-test', (select occurred_at from public.audit_event where portal_id = 'audit-test'),
    'operation_create', 'user', '8001', 'Audit operator', null,
    'operation_attempt', 'attempt-1', 'Другая попытка', '[]'::jsonb,
    'success', 'TC-123e4567-e89b-42d3-a456-426614174000', 'request-1', 'result',
    '{"kind":"operation","reasonCode":null,"summary":null}'::jsonb
  );$$,
  'P0001',
  'TC_AUDIT_EVENT_CONFLICT',
  'rejects a duplicate key with different content'
);

select throws_ok(
  $$update public.audit_event set outcome = 'failure' where portal_id = 'audit-test';$$,
  '23514',
  'Audit events are append-only.',
  'audit events cannot be updated'
);

select throws_ok(
  $$delete from public.audit_event where portal_id = 'audit-test';$$,
  '23514',
  'Audit events are append-only.',
  'recent audit events cannot be deleted'
);

select lives_ok(
  $$insert into public.audit_event (
    portal_id, occurred_at, action, actor_type, actor_id, actor_display_name, actor_source,
    subject_type, subject_id, subject_display_name, related_objects, outcome, correlation_id,
    event_key, details
  ) values (
    'audit-test', now() - interval '2 years 1 day', 'system_error', 'system', null, 'Система', 'internal',
    'system', 'legacy-component', 'Компонент', '[]'::jsonb, 'failure',
    'TC-123e4567-e89b-42d3-a456-426614174001', repeat('b', 64),
    '{"kind":"system","component":"operation-state-machine","errorCode":"UPSTREAM_FAILURE","retryable":false}'::jsonb
  );$$,
  'stores an expired event for retention'
);

select lives_ok(
  $$select public.purge_expired_audit_events(
    'TC-123e4567-e89b-42d3-a456-426614174002',
    '123e4567-e89b-42d3-a456-426614174002'
  );$$,
  'retention function deletes only expired events'
);

select is(
  (select count(*)::integer from public.audit_event where portal_id = 'audit-test' and action = 'audit_retention'),
  1,
  'retention writes one summary event'
);

select is(
  (select (public.purge_expired_audit_events(
    'TC-123e4567-e89b-42d3-a456-426614174002',
    '123e4567-e89b-42d3-a456-426614174002'
  ) ->> 'deletedCount')::integer),
  0,
  'an idempotent retention retry has no further work'
);

select * from finish();

rollback;
