begin;

select plan(18);

insert into public.portal (id, display_name)
values ('automatic-revocation-test', 'Automatic revocation test portal');

select has_table(
  'public', 'access_reconciliation_job', 'automatic access reconciliation jobs are stored durably'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.access_reconciliation_job'::regclass),
  'automatic reconciliation jobs have row level security enabled'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.apply_automatic_access_reconciliation(text,text,text,text,boolean,text,text,uuid)',
    'EXECUTE'
  ),
  'anonymous callers cannot apply automatic revocations'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.apply_automatic_access_reconciliation(text,text,text,text,boolean,text,text,uuid)',
    'EXECUTE'
  ),
  'service role can apply automatic revocations'
);

insert into public.user_settings (
  portal_id, user_id, display_name, access_active, permissions, allowed_field_ids, granted_at,
  granted_by_user_id
) values
  (
    'automatic-revocation-test', '7003', 'Original grant manager', false,
    '{}'::text[], '{}'::text[], null, null
  ),
  (
    'automatic-revocation-test', '7001', 'Inactive employee', true,
    array['app_access']::text[], '{}'::text[], now(), '7003'
  ),
  (
    'automatic-revocation-test', '7002', 'Former manager', true,
    array['app_access', 'manage_access']::text[], '{}'::text[], now(), null
  );

insert into public.bulk_operation (
  id, portal_id, operation_type, status, initiator_id, initiator_display_name,
  idempotency_key, selected_task_ids, changes, preflight_snapshot
) values (
  '70000000-0000-4000-8000-000000000001',
  'automatic-revocation-test', 'bulk_change', 'running', '7001', 'Inactive employee',
  'automatic-revocation-operation', array['task-1'], '[{}]'::jsonb, '{}'::jsonb
);

select is(
  (select count(*)::integer from public.access_reconciliation_job
    where portal_id = 'automatic-revocation-test'),
  2,
  'active recipients and managers are queued for reconciliation'
);
select is(
  public.apply_automatic_access_reconciliation(
    'automatic-revocation-test', '7001', 'Inactive employee', 'inactive', false, 'cron',
    'TC-123e4567-e89b-42d3-a456-426614174701', null
  ) ->> 'disposition',
  'applied',
  'a confirmed inactive employee is revoked'
);
select is(
  (select access_state from public.user_settings
    where portal_id = 'automatic-revocation-test' and user_id = '7001'),
  'revoked',
  'inactive employee moves to the canonical revoked state'
);
select is(
  (select permissions from public.user_settings
    where portal_id = 'automatic-revocation-test' and user_id = '7001'),
  '{}'::text[],
  'full revocation removes every permission'
);
select ok(
  (select granted_by_user_id is null from public.user_settings
    where portal_id = 'automatic-revocation-test' and user_id = '7001'),
  'full revocation clears the previous grant actor'
);
select is(
  (select count(*)::integer from public.audit_event
    where portal_id = 'automatic-revocation-test' and action = 'access_auto_revoke'),
  1,
  'full revocation appends one automatic access audit event'
);
select is(
  (select count(*)::integer from public.notification_outbox
    where portal_id = 'automatic-revocation-test'),
  1,
  'full revocation queues one notification'
);
select ok(
  (select interruption_requested_at is not null
    from public.bulk_operation where id = '70000000-0000-4000-8000-000000000001'),
  'full revocation interrupts the affected active operation'
);
select is(
  public.apply_automatic_access_reconciliation(
    'automatic-revocation-test', '7001', 'Inactive employee', 'inactive', false, 'cron',
    'TC-123e4567-e89b-42d3-a456-426614174702', null
  ) ->> 'disposition',
  'no_change',
  'a repeated confirmed inactive status is a no-op'
);
select is(
  (select count(*)::integer from public.notification_outbox
    where portal_id = 'automatic-revocation-test'),
  1,
  'the repeated status creates no duplicate notification'
);
select is(
  public.apply_automatic_access_reconciliation(
    'automatic-revocation-test', '7002', 'Former manager', 'active', false, 'cron',
    'TC-123e4567-e89b-42d3-a456-426614174703', null
  ) ->> 'disposition',
  'applied',
  'loss of the final manager role is applied independently'
);
select is(
  (select permissions from public.user_settings
    where portal_id = 'automatic-revocation-test' and user_id = '7002'),
  array['app_access']::text[],
  'manager role loss removes only manage_access'
);
select is(
  (select access_state from public.user_settings
    where portal_id = 'automatic-revocation-test' and user_id = '7002'),
  'active',
  'manager role loss preserves ordinary active access'
);
select is(
  (select count(*)::integer from public.access_change
    where portal_id = 'automatic-revocation-test'),
  2,
  'each effective automatic change has one durable change record'
);

select * from finish();

rollback;
