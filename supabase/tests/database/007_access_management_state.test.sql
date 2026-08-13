begin;

select plan(32);

insert into public.portal (id, display_name)
values ('access-management-test', 'Access management test portal');

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

select is(
  cardinality(array(select 'field-' || value::text from generate_series(1, 300) as value)),
  300,
  'field-set fixture exceeds the former product limit'
);

select lives_ok(
  $$select public.resolve_access_field_set(
    'access-management-test',
    array(select 'field-' || value::text from generate_series(1, 300) as value)
  );$$,
  'materializes a field set larger than 256 members'
);

select is(
  (select member_count from public.access_field_set where portal_id = 'access-management-test'),
  300,
  'large field set stores its complete member count'
);
select is(
  (select count(*)::integer from public.access_field_set_member where portal_id = 'access-management-test'),
  300,
  'large field set stores pageable member rows'
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
      'redactedDelta', '{"permissions":{"added":["app_access","change_allowed_fields"],"removed":[]},"fields":{"addedCount":300,"removedCount":0}}'::jsonb
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
  300,
  'first grant bridges all normalized field members into the legacy access read'
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
