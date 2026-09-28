begin;

select plan(17);

insert into public.portal (id, display_name)
values ('task-confirmation-test', 'Task confirmation test portal');

insert into public.user_settings (
  portal_id, user_id, display_name, access_active, permissions, allowed_field_ids, granted_at
) values (
  'task-confirmation-test', '8001', 'Task operator', true,
  array['app_access', 'run_bulk_operations', 'change_allowed_fields']::text[],
  array['title']::text[], now()
);

create temporary table task_confirmation_fixture (snapshot jsonb not null);
insert into task_confirmation_fixture values (
  jsonb_build_object(
    'draftId', '10000000-0000-4000-8000-000000000020',
    'sourceDraftRevision', 1, 'draftRevision', 2, 'actorAccessVersion', 1,
    'checkedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'canProceed', true,
    'entries', jsonb_build_array(jsonb_build_object(
      'taskId', '42', 'title', 'Task', 'taskUrl', 'https://portal.bitrix24.ru/tasks/42',
      'disposition', 'eligible', 'changedFieldIds', jsonb_build_array('title'),
      'reasonCode', null, 'reasonMessage', null, 'relevantVersion', 'version-1',
      'currentValues', jsonb_build_object('title', 'Before'),
      'targetValues', jsonb_build_object('title', 'Updated')
    )),
    'summary', jsonb_build_object('selected', 1, 'eligible', 1, 'excluded', 0,
      'unchanged', 0, 'successful', 0, 'failed', 0, 'unconfirmed', 0,
      'conflicted', 0, 'partiallyApplied', 0, 'notProcessed', 0)
  )
);

insert into public.operation_draft (
  id, portal_id, owner_id, revision, status, selected_task_ids, changes, preflight_snapshot
) values (
  '10000000-0000-4000-8000-000000000020', 'task-confirmation-test', '8001',
  2, 'awaiting_confirmation', array['42'],
  '[{"fieldId":"title","kind":"text","action":"set","value":"Updated"}]'::jsonb,
  (select snapshot from task_confirmation_fixture)
);

select ok(not has_function_privilege('anon',
  'public.confirm_task_preflight(text,text,uuid,integer,timestamptz,bigint,boolean,jsonb,text)',
  'EXECUTE'), 'anonymous users cannot confirm directly');
select ok(not has_function_privilege('authenticated',
  'public.confirm_task_preflight(text,text,uuid,integer,timestamptz,bigint,boolean,jsonb,text)',
  'EXECUTE'), 'authenticated users cannot confirm directly');
select ok(has_function_privilege('service_role',
  'public.confirm_task_preflight(text,text,uuid,integer,timestamptz,bigint,boolean,jsonb,text)',
  'EXECUTE'), 'service role can confirm');

create temporary table task_confirmation_first (result jsonb not null);
insert into task_confirmation_first
select public.confirm_task_preflight(
  'task-confirmation-test', '8001', '10000000-0000-4000-8000-000000000020',
  2, (snapshot ->> 'checkedAt')::timestamptz, 1, false, snapshot, repeat('a', 64)
) from task_confirmation_fixture;

select ok((select (result ->> 'token')::uuid is not null from task_confirmation_first),
  'first confirmation issues a token');
select is(
  (select public.confirm_task_preflight(
    'task-confirmation-test', '8001', '10000000-0000-4000-8000-000000000020',
    2, (snapshot ->> 'checkedAt')::timestamptz, 1, false, snapshot, repeat('a', 64)
  ) ->> 'token' from task_confirmation_fixture),
  (select result ->> 'token' from task_confirmation_first),
  'exact retry returns the same token'
);

select throws_ok($$select public.confirm_task_preflight(
  'task-confirmation-test', '8001', '10000000-0000-4000-8000-000000000020',
  2, now() - interval '1 minute', 1, false,
  (select snapshot from task_confirmation_fixture), repeat('a', 64)
);$$, '40001', 'TC_TASK_CONFIRMATION_CONFLICT', 'different checkedAt is rejected');
select is((select token::text from public.task_preflight_confirmation
  where portal_id = 'task-confirmation-test' and owner_id = '8001'),
  (select result ->> 'token' from task_confirmation_first),
  'invalid checkedAt does not revoke the valid token');

select throws_ok($$select public.confirm_task_preflight(
  'task-confirmation-test', '8999', '10000000-0000-4000-8000-000000000020',
  2, (select (snapshot ->> 'checkedAt')::timestamptz from task_confirmation_fixture),
  null, true, (select snapshot from task_confirmation_fixture), repeat('a', 64)
);$$, '40001', 'TC_TASK_CONFIRMATION_CONFLICT', 'another owner is rejected');
select throws_ok($$select public.confirm_task_preflight(
  'task-confirmation-test', '8001', '10000000-0000-4000-8000-000000000020',
  2, (select (snapshot ->> 'checkedAt')::timestamptz from task_confirmation_fixture),
  2, false, (select snapshot from task_confirmation_fixture), repeat('a', 64)
);$$, '40001', 'TC_TASK_CONFIRMATION_ACCESS_CHANGED', 'access version drift is rejected');
select throws_ok($$select public.confirm_task_preflight(
  'task-confirmation-test', '8001', '10000000-0000-4000-8000-000000000020',
  2, (select (snapshot ->> 'checkedAt')::timestamptz from task_confirmation_fixture),
  1, false, (select snapshot || '{"canProceed":false}'::jsonb from task_confirmation_fixture),
  repeat('a', 64)
);$$, '40001', 'TC_TASK_CONFIRMATION_CONFLICT', 'different snapshot is rejected');
select throws_ok($$select public.confirm_task_preflight(
  'task-confirmation-test', '8001', '10000000-0000-4000-8000-000000000020',
  2, (select (snapshot ->> 'checkedAt')::timestamptz from task_confirmation_fixture),
  1, false, (select snapshot from task_confirmation_fixture), null
);$$, '22023', 'TC_TASK_CONFIRMATION_INVALID', 'null fingerprint is rejected');

update public.task_preflight_confirmation set consumed_at = now()
where portal_id = 'task-confirmation-test' and owner_id = '8001';
select throws_ok($$select public.confirm_task_preflight(
  'task-confirmation-test', '8001', '10000000-0000-4000-8000-000000000020',
  2, (select (snapshot ->> 'checkedAt')::timestamptz from task_confirmation_fixture),
  1, false, (select snapshot from task_confirmation_fixture), repeat('a', 64)
);$$, '40001', 'TC_TASK_CONFIRMATION_CONSUMED', 'consumed token is not issued again');

update public.operation_draft
set preflight_snapshot = preflight_snapshot || '{"warning":"changed"}'::jsonb
where portal_id = 'task-confirmation-test' and owner_id = '8001';
select is((select count(*)::integer from public.task_preflight_confirmation
  where portal_id = 'task-confirmation-test' and owner_id = '8001'), 0,
  'snapshot-only changes revoke confirmation');
update public.operation_draft set preflight_snapshot = (select snapshot from task_confirmation_fixture)
where portal_id = 'task-confirmation-test' and owner_id = '8001';
select lives_ok($$select public.confirm_task_preflight(
  'task-confirmation-test', '8001', '10000000-0000-4000-8000-000000000020',
  2, (select (snapshot ->> 'checkedAt')::timestamptz from task_confirmation_fixture),
  1, false, (select snapshot from task_confirmation_fixture), repeat('a', 64)
);$$, 'a new confirmation can be issued after a changed snapshot is rechecked');

update public.operation_draft set revision = 3, status = 'preparing', preflight_snapshot = null
where portal_id = 'task-confirmation-test' and owner_id = '8001';
select is((select count(*)::integer from public.task_preflight_confirmation
  where portal_id = 'task-confirmation-test' and owner_id = '8001'), 0,
  'draft revision and snapshot changes revoke the token');
select throws_ok($$select public.confirm_task_preflight(
  'task-confirmation-test', '8001', '10000000-0000-4000-8000-000000000020',
  2, (select (snapshot ->> 'checkedAt')::timestamptz from task_confirmation_fixture),
  1, false, (select snapshot from task_confirmation_fixture), repeat('a', 64)
);$$, '40001', 'TC_TASK_CONFIRMATION_CONFLICT', 'old revision is rejected');

update public.operation_draft set revision = 4, status = 'awaiting_confirmation',
  preflight_snapshot = (select snapshot || jsonb_build_object(
    'draftRevision', 4, 'sourceDraftRevision', 3,
    'checkedAt', to_char((now() - interval '16 minutes') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) from task_confirmation_fixture)
where portal_id = 'task-confirmation-test' and owner_id = '8001';
select throws_ok($$select public.confirm_task_preflight(
  'task-confirmation-test', '8001', '10000000-0000-4000-8000-000000000020',
  4, (select (preflight_snapshot ->> 'checkedAt')::timestamptz
    from public.operation_draft where portal_id = 'task-confirmation-test' and owner_id = '8001'),
  1, false, (select preflight_snapshot from public.operation_draft
    where portal_id = 'task-confirmation-test' and owner_id = '8001'), repeat('b', 64)
);$$, '40001', 'TC_TASK_CONFIRMATION_CONFLICT', 'expired preflight is rejected');

select * from finish();
rollback;
