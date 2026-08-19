begin;

select plan(47);

insert into public.portal (id, display_name)
values
  ('access-management-test', 'Access management test portal'),
  ('access-management-boundary-test', 'Access management boundary test portal');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.access_command'::regclass),
  'access commands have row level security enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.access_change'::regclass),
  'access changes have row level security enabled'
);
select ok(
  not has_function_privilege('anon', 'public.apply_access_command_target(text,uuid,bigint,text,boolean,boolean,boolean,boolean,boolean,boolean)', 'EXECUTE'),
  'anonymous callers cannot apply access targets'
);
select ok(
  not has_function_privilege('authenticated', 'public.apply_access_command_target(text,uuid,bigint,text,boolean,boolean,boolean,boolean,boolean,boolean)', 'EXECUTE'),
  'authenticated callers cannot apply access targets'
);
select ok(
  has_function_privilege('service_role', 'public.apply_access_command_target(text,uuid,bigint,text,boolean,boolean,boolean,boolean,boolean,boolean)', 'EXECUTE'),
  'service role can apply access targets'
);
select ok(
  not has_schema_privilege('public', 'public', 'CREATE'),
  'public cannot create objects in the application schema'
);
select is(
  (select count(*)::integer
   from pg_proc
   join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
   where pg_namespace.nspname = 'public'
     and pg_proc.prosecdef
     and not exists (
       select 1 from unnest(coalesce(pg_proc.proconfig, '{}'::text[])) as setting
       where setting in ('search_path=', 'search_path=""')
     )),
  0,
  'every security definer function has an empty search path'
);
select ok(
  to_regprocedure('public.purge_integration_test_fixture(text)') is null,
  'the destructive integration cleanup RPC is absent'
);

select ok(
  not (select convalidated from pg_constraint
       where conname = 'access_field_set_member_count_limit'
         and conrelid = 'public.access_field_set'::regclass),
  'the new field-set limit is enforced without rejecting legacy oversized immutable sets'
);

select throws_ok(
  $$select public.append_audit_event(
    'access-management-test', now(), 'system_error', 'system', null, 'Система', 'internal',
    'system', 'runtime', 'Runtime', '[]'::jsonb, 'failure',
    'TC-123e4567-e89b-42d3-a456-426614174099', 'opaque-code-test', 'error',
    '{"kind":"system","component":"operation-state-machine","errorCode":"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789","retryable":false}'::jsonb
  );$$,
  '23514',
  null,
  'the database rejects an opaque uppercase audit code'
);

select throws_ok(
  $$select public.append_audit_event(
    'access-management-test', now(), 'system_error', 'system', null, 'Система', 'internal',
    'system', 'runtime', 'Runtime', '[]'::jsonb, 'failure',
    'TC-123e4567-e89b-42d3-a456-426614174098', 'raw-audit-field-test', 'error',
    '{"kind":"system","component":"operation-state-machine","errorCode":"UPSTREAM_FAILURE","retryable":false,"rawException":"secret-canary"}'::jsonb
  );$$,
  '23514',
  null,
  'the database rejects extra raw or secret audit detail fields'
);

select throws_ok(
  $$select public.append_audit_event(
    'access-management-test', now(), 'operation_complete', 'system', null, 'Система', 'queue',
    'operation', '123e4567-e89b-42d3-a456-426614174097', 'Operation', '[]'::jsonb, 'failure',
    'TC-123e4567-e89b-42d3-a456-426614174097', 'negative-summary-test', 'complete',
    '{"kind":"operation","reasonCode":null,"summary":{"selected":-1,"successful":0,"failed":0,"unconfirmed":0,"conflicted":0,"partiallyApplied":0,"notProcessed":0}}'::jsonb
  );$$,
  '23514',
  null,
  'the database rejects negative audit counters'
);

select lives_ok(
  $$select public.append_audit_event(
    'access-management-test', now(), 'access_update', 'system', null, 'Система', 'internal',
    'access', '9002', 'Access', '[]'::jsonb, 'success',
    'TC-123e4567-e89b-42d3-a456-426614174096', 'permission-catalog-test', 'access',
    '{"kind":"access","version":2,"previousAccessVersion":null,"newAccessVersion":1,"accessState":"active","addedPermissions":["export_reports"],"removedPermissions":[],"addedFieldCount":0,"removedFieldCount":0,"reasonCode":null}'::jsonb
  );$$,
  'the database audit allowlist accepts the canonical export_reports permission'
);

select throws_ok(
  $$select public.append_audit_event(
    'access-management-test', now(), 'audit_view', 'user', '9001', 'Viewer', null,
    'system', 'audit-journal', 'Audit journal', '[]'::jsonb, 'success',
    'TC-123e4567-e89b-42d3-a456-426614174095', 'audit-outcome-test', 'view',
    '{"kind":"audit_view","reasonCode":"ACCESS_DENIED"}'::jsonb
  );$$,
  '23514',
  null,
  'the database enforces action-specific audit outcomes'
);

select throws_ok(
  $$select public.append_audit_event(
    'access-management-test', now(), 'audit_retention', 'system', null, 'Система', 'retention',
    'system', 'audit-journal', 'Audit journal', '[]'::jsonb, 'success',
    'TC-123e4567-e89b-42d3-a456-426614174094', 'retention-time-test', 'retention',
    '{"kind":"retention","cutoffAt":"not-a-time","deletedCount":1}'::jsonb
  );$$,
  '23514',
  null,
  'the database rejects a malformed retention timestamp'
);

select is(
  cardinality(array(select 'field-' || value::text from generate_series(1, 256) as value)),
  256,
  'field-set fixture reaches the product limit'
);

select lives_ok(
  $$select public.resolve_access_field_set(
    'access-management-test',
    array(select 'field-' || value::text from generate_series(1, 256) as value)
  );$$,
  'materializes a field set with 256 members'
);

select throws_ok(
  $$select public.resolve_access_field_set(
    'access-management-test',
    array(select 'field-' || value::text from generate_series(1, 257) as value)
  );$$,
  '23514',
  null,
  'rejects a field set with 257 members'
);

select is(
  (select member_count from public.access_field_set where portal_id = 'access-management-test'),
  256,
  'maximum field set stores its complete member count'
);
select is(
  (select count(*)::integer from public.access_field_set_member where portal_id = 'access-management-test'),
  256,
  'maximum field set stores pageable member rows'
);

select lives_ok(
  $$select public.save_access_draft_with_field_set(
    'access-management-boundary-test', '9101', 0,
    array(select 'field-' || value::text from generate_series(1, 255) as value),
    '{"mode":"grant","targets":[{"userId":"9102","baseAccessVersion":null}]}'::jsonb
  );$$,
  'atomically saves a draft with 255 fields'
);
select is(
  (select member_count from public.access_field_set
    where portal_id = 'access-management-boundary-test'),
  255,
  'the atomic draft stores all 255 fields'
);
select throws_ok(
  $$select public.save_access_draft_with_field_set(
    'access-management-boundary-test', '9101', 0,
    array(select 'replacement-' || value::text from generate_series(1, 256) as value),
    '{"mode":"grant","targets":[{"userId":"9102","baseAccessVersion":null}]}'::jsonb
  );$$,
  '40001',
  'TC_ACCESS_DRAFT_REVISION_CONFLICT',
  'a stale atomic draft is rejected after field-set resolution'
);
select is(
  (select count(*)::integer from public.access_field_set
    where portal_id = 'access-management-boundary-test'),
  1,
  'a rejected atomic draft leaves no orphan field set'
);

select lives_ok(
  $$select public.save_access_draft(
    'access-management-test', '9001', 0,
    '{"mode":"grant","targets":[{"userId":"9002","baseAccessVersion":null}]}'::jsonb
  );$$,
  'portal administrator without user settings can create a draft'
);
select is(
  extract(epoch from (
    (select expires_at from public.access_management_draft where portal_id = 'access-management-test')
    - (select updated_at from public.access_management_draft where portal_id = 'access-management-test')
  ))::integer,
  86400,
  'access draft lives for 24 hours'
);
select throws_ok(
  $$select public.save_access_draft(
    'access-management-test', '9001', 0, '{"mode":"grant"}'::jsonb
  );$$,
  '40001',
  'TC_ACCESS_DRAFT_REVISION_CONFLICT',
  'draft compare-and-swap rejects a stale revision'
);

select lives_ok(
  $$select public.create_access_preflight(
    'access-management-test',
    (select id from public.access_management_draft where portal_id = 'access-management-test'),
    1, '9001', 1, 1, 'grant', repeat('a', 64),
    '{"total":1,"ready":1}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'targetUserId', '9002',
      'targetDisplayName', 'First grant recipient',
      'targetIsPortalAdmin', false,
      'targetIsManager', false,
      'expectedAccessVersion', null,
      'expectedAccessState', 'revoked',
      'expectedPermissionCount', 0,
      'desiredAccessState', 'active',
      'desiredPermissions', jsonb_build_array('app_access', 'change_allowed_fields'),
      'desiredFieldSetId', (select id from public.access_field_set where portal_id = 'access-management-test'),
      'state', 'ready',
      'reasonCode', null,
      'redactedDelta', '{"permissions":{"added":["app_access","change_allowed_fields"],"removed":[]},"fields":{"addedCount":256,"removedCount":0}}'::jsonb
    ))
  );$$,
  'creates a first-grant preflight without a target settings row'
);

select is(
  public.accept_access_command(
    'access-management-test', '11111111-1111-4111-8111-111111111111', 'grant-9002',
    (select id from public.access_preflight where portal_id = 'access-management-test'),
    '9001', 'Portal administrator', true,
    null,
    'TC-123e4567-e89b-42d3-a456-426614174111'
  ) -> 'command' ->> 'state',
  'accepted',
  'accepts a command from an administrator without user settings'
);
select is(
  (select status from public.access_command_dispatch_outbox
    where portal_id = 'access-management-test'
      and command_id = '11111111-1111-4111-8111-111111111111'),
  'pending',
  'accepted command is durably recoverable before queue dispatch'
);
select is(
  public.claim_access_command(
    'access-management-test', '11111111-1111-4111-8111-111111111111', 1
  ) -> 'command' ->> 'state',
  'validating',
  'claims an accepted command explicitly'
);
select is(
  public.apply_access_command_target(
    'access-management-test', '11111111-1111-4111-8111-111111111111', 2, '9002',
    true, true, true, true, true, false
  ) ->> 'disposition',
  'applied',
  'atomically applies the first grant'
);
select is(
  (select access_version from public.user_settings where portal_id = 'access-management-test' and user_id = '9002'),
  1::bigint,
  'first grant starts at access version one'
);
select is(
  (select cardinality(allowed_field_ids) from public.user_settings where portal_id = 'access-management-test' and user_id = '9002'),
  256,
  'first grant bridges the maximum normalized field set into the legacy access read'
);
select ok(
  (select previous_access_version is null from public.access_change where portal_id = 'access-management-test'),
  'first grant evidence has no previous access version'
);
select is(
  (select count(*)::integer from public.audit_event where portal_id = 'access-management-test' and action = 'access_grant'),
  1,
  'applied first grant appends one linked access audit event'
);
select is(
  (select count(*)::integer from public.notification_outbox where portal_id = 'access-management-test'),
  1,
  'applied first grant enqueues exactly one notification'
);
select is(
  public.finalize_access_command(
    'access-management-test', '11111111-1111-4111-8111-111111111111', 3
  ) -> 'command' ->> 'state',
  'succeeded',
  'finalizes the command explicitly'
);

select lives_ok(
  $$select public.save_access_draft(
    'access-management-test', '9003', 0,
    '{"mode":"replace_managed","targets":[{"userId":"9002","baseAccessVersion":1}]}'::jsonb
  );$$,
  'creates a second draft for an exact no-op'
);
select lives_ok(
  $$select public.create_access_preflight(
    'access-management-test',
    (select id from public.access_management_draft where portal_id = 'access-management-test' and manager_user_id = '9003'),
    1, '9003', 1, 1, 'replace_managed', repeat('b', 64),
    '{"total":1,"noChange":1}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'targetUserId', '9002', 'targetDisplayName', 'First grant recipient',
      'targetIsPortalAdmin', false, 'targetIsManager', false,
      'expectedAccessVersion', 1, 'desiredAccessState', 'active',
      'expectedAccessState', 'active', 'expectedPermissionCount', 2,
      'desiredPermissions', jsonb_build_array('app_access', 'change_allowed_fields'),
      'desiredFieldSetId', (select field_set_id from public.user_settings where portal_id = 'access-management-test' and user_id = '9002'),
      'state', 'no_change', 'reasonCode', null,
      'redactedDelta', '{"permissions":{"added":[],"removed":[]},"fields":{"addedCount":0,"removedCount":0}}'::jsonb
    ))
  );$$,
  'stores a no-change preflight target'
);
select is(
  public.accept_access_command(
    'access-management-test', '22222222-2222-4222-8222-222222222222', 'noop-9002',
    (select id from public.access_preflight where portal_id = 'access-management-test' and manager_user_id = '9003'),
    '9003', 'Second portal administrator', true,
    null,
    'TC-123e4567-e89b-42d3-a456-426614174222'
  ) -> 'command' ->> 'state',
  'no_change',
  'zero-difference command terminates as no_change'
);
select is(
  public.accept_access_command(
    'access-management-test', '22222222-2222-4222-8222-222222222222', 'noop-9002',
    (select id from public.access_preflight where portal_id = 'access-management-test' and manager_user_id = '9003'),
    '9003', 'Second portal administrator', true, null,
    'TC-123e4567-e89b-42d3-a456-426614174333'
  ) -> 'command' ->> 'state',
  'no_change',
  'identical command retry returns the stored terminal receipt'
);
select throws_ok(
  $$select public.accept_access_command(
    'access-management-test', '22222222-2222-4222-8222-222222222222', 'noop-9002',
    (select id from public.access_preflight where portal_id = 'access-management-test' and manager_user_id = '9003'),
    '9003', 'Second portal administrator', true,
    '33333333-3333-4333-8333-333333333333',
    'TC-123e4567-e89b-42d3-a456-426614174444'
  );$$,
  'P0001',
  'TC_ACCESS_COMMAND_CONFLICT',
  'same command id with a different confirmation identity conflicts'
);
select is(
  (select access_version from public.user_settings where portal_id = 'access-management-test' and user_id = '9002'),
  1::bigint,
  'no-op does not increment the target access version'
);
select is(
  (select count(*)::integer from public.notification_outbox where portal_id = 'access-management-test'),
  1,
  'no-op creates no audit-linked notification'
);

select lives_ok(
  $$update public.access_command set actor_display_name = actor_display_name
    where false;$$,
  'ordinary command reads remain non-mutating through the data layer'
);
select throws_ok(
  $$update public.access_change set after_snapshot = '{}'::jsonb
    where portal_id = 'access-management-test';$$,
  '23514',
  'Access management evidence is immutable.',
  'access change evidence is immutable'
);

select * from finish();

rollback;
