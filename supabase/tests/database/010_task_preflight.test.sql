begin;

select plan(19);

insert into public.portal (id, display_name)
values ('task-preflight-test', 'Task preflight test portal');

insert into public.user_settings (
  portal_id, user_id, display_name, access_active, permissions, allowed_field_ids, granted_at
) values (
  'task-preflight-test', '7001', 'Task operator', true,
  array['app_access', 'run_bulk_operations', 'change_allowed_fields']::text[],
  array['title']::text[], now()
);

insert into public.operation_draft (
  id, portal_id, owner_id, revision, status, selected_task_ids, changes
) values (
  '10000000-0000-4000-8000-000000000019', 'task-preflight-test', '7001', 1,
  'preparing', array['42'],
  '[{"fieldId":"title","kind":"text","action":"set","value":"Updated"}]'::jsonb
);

create temporary table task_preflight_fixture (snapshot jsonb not null);
insert into task_preflight_fixture values (
  jsonb_build_object(
    'draftId', '10000000-0000-4000-8000-000000000019',
    'sourceDraftRevision', 1, 'draftRevision', 2, 'actorAccessVersion', 1,
    'checkedAt', '2026-09-04T10:00:00Z', 'canProceed', true,
    'entries', jsonb_build_array(jsonb_build_object(
      'taskId', '42', 'title', 'Task',
      'taskUrl', 'https://portal.bitrix24.ru/tasks/42',
      'disposition', 'eligible', 'changedFieldIds', jsonb_build_array('title'),
      'reasonCode', null, 'reasonMessage', null, 'relevantVersion', 'version-1',
      'currentValues', jsonb_build_object('title', 'Before'),
      'targetValues', jsonb_build_object('title', 'Updated')
    )),
    'summary', jsonb_build_object(
      'selected', 1, 'eligible', 1, 'excluded', 0, 'unchanged', 0,
      'successful', 0, 'failed', 0, 'unconfirmed', 0, 'conflicted', 0,
      'partiallyApplied', 0, 'notProcessed', 0
    )
  )
);

select ok(
  not has_function_privilege(
    'anon',
    'public.save_task_preflight(text,text,uuid,integer,bigint,boolean,jsonb)',
    'EXECUTE'
  ),
  'anonymous callers cannot save a task preflight'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.save_task_preflight(text,text,uuid,integer,bigint,boolean,jsonb)',
    'EXECUTE'
  ),
  'authenticated callers cannot save a task preflight directly'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.save_task_preflight(text,text,uuid,integer,bigint,boolean,jsonb)',
    'EXECUTE'
  ),
  'service role can save a task preflight'
);

select lives_ok(
  $$select public.save_task_preflight(
    'task-preflight-test', '7001', '10000000-0000-4000-8000-000000000019',
    1, 1, false, (select snapshot from task_preflight_fixture)
  );$$,
  'saves a revision-bound task preflight'
);

select is(
  (select revision from public.operation_draft
    where id = '10000000-0000-4000-8000-000000000019'),
  2,
  'preflight advances the draft revision once'
);

select is(
  (select status from public.operation_draft
    where id = '10000000-0000-4000-8000-000000000019'),
  'awaiting_confirmation',
  'preflight moves the draft to awaiting confirmation'
);

select is(
  (select preflight_snapshot from public.operation_draft
    where id = '10000000-0000-4000-8000-000000000019'),
  (select snapshot from task_preflight_fixture),
  'preflight stores the exact validated snapshot'
);

select lives_ok(
  $$select public.save_task_preflight(
    'task-preflight-test', '7001', '10000000-0000-4000-8000-000000000019',
    1, 1, false, (select snapshot from task_preflight_fixture)
  );$$,
  'an exact retry returns the stored preflight'
);

select is(
  (select revision from public.operation_draft
    where id = '10000000-0000-4000-8000-000000000019'),
  2,
  'an exact retry does not advance the revision again'
);

select throws_ok(
  $$select public.save_task_preflight(
    'task-preflight-test', '7001', '10000000-0000-4000-8000-000000000019',
    null, 1, false, (select snapshot from task_preflight_fixture)
  );$$,
  '22023', 'TC_TASK_PREFLIGHT_INVALID',
  'null expected revision is rejected'
);

select throws_ok(
  $$select public.save_task_preflight(
    'task-preflight-test', '7001', '10000000-0000-4000-8000-000000000019',
    1, 1, null, (select snapshot from task_preflight_fixture)
  );$$,
  '22023', 'TC_TASK_PREFLIGHT_INVALID',
  'null administrator flag is rejected'
);

select throws_ok(
  $$select public.save_task_preflight(
    'task-preflight-test', '7001', '10000000-0000-4000-8000-000000000019',
    1, null, false, (select snapshot from task_preflight_fixture)
  );$$,
  '22023', 'TC_TASK_PREFLIGHT_INVALID',
  'non-administrator calls require an access version'
);

select throws_ok(
  $$select public.save_task_preflight(
    'task-preflight-test', '7001', '10000000-0000-4000-8000-000000000019',
    1, 1, true, (select snapshot from task_preflight_fixture)
  );$$,
  '22023', 'TC_TASK_PREFLIGHT_INVALID',
  'administrator calls reject an access version'
);

select throws_ok(
  $$select public.save_task_preflight(
    'task-preflight-test', '7999', '10000000-0000-4000-8000-000000000019',
    2, null, true,
    (select snapshot || jsonb_build_object(
      'sourceDraftRevision', 2, 'draftRevision', 3, 'actorAccessVersion', null
    ) from task_preflight_fixture)
  );$$,
  '40001', 'TC_TASK_PREFLIGHT_DRAFT_CONFLICT',
  'an administrator cannot save another owner draft'
);

select throws_ok(
  $$select public.save_task_preflight(
    'task-preflight-test', '7001', '10000000-0000-4000-8000-000000000019',
    5, 1, false, (select snapshot from task_preflight_fixture)
  );$$,
  '40001', 'TC_TASK_PREFLIGHT_DRAFT_CONFLICT',
  'stale draft revisions are rejected'
);

select throws_ok(
  $$select public.save_task_preflight(
    'task-preflight-test', '7001', '10000000-0000-4000-8000-000000000019',
    2, 1, false, (select snapshot from task_preflight_fixture)
  );$$,
  '22023', 'TC_TASK_PREFLIGHT_INVALID',
  'snapshot revision binding is validated'
);

select throws_ok(
  $$select public.save_task_preflight(
    'task-preflight-test', '7001', '10000000-0000-4000-8000-000000000019',
    2, 999, false,
    (select snapshot || jsonb_build_object(
      'sourceDraftRevision', 2, 'draftRevision', 3, 'actorAccessVersion', 999
    ) from task_preflight_fixture)
  );$$,
  '40001', 'TC_TASK_PREFLIGHT_ACCESS_CHANGED',
  'mismatched access version is rejected'
);

select throws_ok(
  $$select public.save_task_preflight(
    'task-preflight-test', '7001', '10000000-0000-4000-8000-000000000019',
    2, 1, false,
    (select snapshot || jsonb_build_object(
      'sourceDraftRevision', 2, 'draftRevision', 3,
      'padding', repeat('x', 8388608)
    ) from task_preflight_fixture)
  );$$,
  '22023', 'TC_TASK_PREFLIGHT_TOO_LARGE',
  'oversized snapshots are rejected'
);

update public.user_settings
set permissions = array['app_access']::text[],
  allowed_field_ids = '{}'::text[],
  access_version = access_version + 1
where portal_id = 'task-preflight-test' and user_id = '7001';

select throws_ok(
  $$select public.save_task_preflight(
    'task-preflight-test', '7001', '10000000-0000-4000-8000-000000000019',
    1, 1, false, (select snapshot from task_preflight_fixture)
  );$$,
  '40001', 'TC_TASK_PREFLIGHT_ACCESS_CHANGED',
  'access changes invalidate the preflight CAS'
);

select * from finish();

rollback;
