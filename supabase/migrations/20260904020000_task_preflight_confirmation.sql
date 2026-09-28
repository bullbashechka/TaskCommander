begin;

create table public.task_preflight_confirmation (
  portal_id text not null,
  owner_id text not null,
  draft_id uuid not null,
  draft_revision integer not null,
  token uuid not null default gen_random_uuid(),
  snapshot_fingerprint text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  primary key (portal_id, owner_id),
  unique (token),
  constraint task_preflight_confirmation_revision_positive check (draft_revision > 0),
  constraint task_preflight_confirmation_fingerprint_shape check (
    snapshot_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

alter table public.task_preflight_confirmation enable row level security;
revoke all on table public.task_preflight_confirmation from public, anon, authenticated;

create function public.clear_task_preflight_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.revision is distinct from old.revision
    or new.preflight_snapshot is distinct from old.preflight_snapshot then
    delete from public.task_preflight_confirmation
    where portal_id = old.portal_id and owner_id = old.owner_id;
  end if;
  return new;
end;
$$;

create trigger operation_draft_clear_confirmation
after update on public.operation_draft
for each row execute function public.clear_task_preflight_confirmation();

create function public.confirm_task_preflight(
  p_portal_id text,
  p_owner_id text,
  p_draft_id uuid,
  p_draft_revision integer,
  p_checked_at timestamptz,
  p_expected_access_version bigint,
  p_is_bitrix_admin boolean,
  p_preflight_snapshot jsonb,
  p_snapshot_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft_record public.operation_draft;
  settings_record public.user_settings;
  confirmation_record public.task_preflight_confirmation;
  confirmation_expires_at timestamptz;
begin
  if p_portal_id is null or btrim(p_portal_id) = ''
    or p_owner_id is null or btrim(p_owner_id) = ''
    or p_draft_id is null or p_draft_revision is null or p_draft_revision <= 0
    or p_checked_at is null or p_is_bitrix_admin is null or p_preflight_snapshot is null
    or p_snapshot_fingerprint is null
    or p_snapshot_fingerprint !~ '^[0-9a-f]{64}$'
    or (p_is_bitrix_admin and p_expected_access_version is not null)
    or (not p_is_bitrix_admin and p_expected_access_version is null) then
    raise exception 'TC_TASK_CONFIRMATION_INVALID' using errcode = '22023';
  end if;

  if not p_is_bitrix_admin then
    select * into settings_record from public.user_settings
    where portal_id = p_portal_id and user_id = p_owner_id for share;
    if not found or settings_record.access_state <> 'active'
      or settings_record.access_version <> p_expected_access_version
      or not (array['app_access', 'run_bulk_operations', 'change_allowed_fields']::text[]
        <@ settings_record.permissions) then
      raise exception 'TC_TASK_CONFIRMATION_ACCESS_CHANGED' using errcode = '40001';
    end if;
  end if;

  select * into draft_record from public.operation_draft
  where portal_id = p_portal_id and owner_id = p_owner_id and id = p_draft_id
  for update;
  if not found or draft_record.expires_at <= now()
    or draft_record.status <> 'awaiting_confirmation'
    or draft_record.revision <> p_draft_revision
    or draft_record.preflight_snapshot is distinct from p_preflight_snapshot
    or coalesce(draft_record.preflight_snapshot ->> 'draftId', '') <> p_draft_id::text
    or coalesce(draft_record.preflight_snapshot ->> 'draftRevision', '') <> p_draft_revision::text
    or (draft_record.preflight_snapshot ->> 'checkedAt')::timestamptz
      is distinct from p_checked_at
    or coalesce((draft_record.preflight_snapshot ->> 'canProceed')::boolean, false) is not true
    or (p_is_bitrix_admin and draft_record.preflight_snapshot -> 'actorAccessVersion'
      is distinct from 'null'::jsonb)
    or (not p_is_bitrix_admin and coalesce(
      draft_record.preflight_snapshot ->> 'actorAccessVersion', ''
    ) <> p_expected_access_version::text)
    or p_checked_at > now() + interval '1 minute'
    or p_checked_at <= now() - interval '15 minutes' then
    raise exception 'TC_TASK_CONFIRMATION_CONFLICT' using errcode = '40001';
  end if;

  confirmation_expires_at := least(
    draft_record.expires_at, p_checked_at + interval '15 minutes', now() + interval '15 minutes'
  );
  select * into confirmation_record from public.task_preflight_confirmation
  where portal_id = p_portal_id and owner_id = p_owner_id for update;
  if found and confirmation_record.consumed_at is not null
    and confirmation_record.draft_id = p_draft_id
    and confirmation_record.draft_revision = p_draft_revision
    and confirmation_record.snapshot_fingerprint = p_snapshot_fingerprint then
    raise exception 'TC_TASK_CONFIRMATION_CONSUMED' using errcode = '40001';
  end if;
  if found and confirmation_record.draft_id = p_draft_id
    and confirmation_record.draft_revision = p_draft_revision
    and confirmation_record.snapshot_fingerprint = p_snapshot_fingerprint
    and confirmation_record.consumed_at is null
    and confirmation_record.expires_at > now() then
    return jsonb_build_object(
      'draftId', p_draft_id, 'draftRevision', p_draft_revision,
      'token', confirmation_record.token,
      'expiresAt', to_char(confirmation_record.expires_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  end if;

  insert into public.task_preflight_confirmation (
    portal_id, owner_id, draft_id, draft_revision, snapshot_fingerprint, expires_at
  ) values (
    p_portal_id, p_owner_id, p_draft_id, p_draft_revision,
    p_snapshot_fingerprint, confirmation_expires_at
  ) on conflict (portal_id, owner_id) do update set
    draft_id = excluded.draft_id,
    draft_revision = excluded.draft_revision,
    token = gen_random_uuid(),
    snapshot_fingerprint = excluded.snapshot_fingerprint,
    expires_at = excluded.expires_at,
    consumed_at = null
  returning * into confirmation_record;

  return jsonb_build_object(
    'draftId', p_draft_id, 'draftRevision', p_draft_revision,
    'token', confirmation_record.token,
    'expiresAt', to_char(confirmation_record.expires_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;

revoke all on function public.confirm_task_preflight(
  text, text, uuid, integer, timestamptz, bigint, boolean, jsonb, text
) from public, anon, authenticated;
grant execute on function public.confirm_task_preflight(
  text, text, uuid, integer, timestamptz, bigint, boolean, jsonb, text
) to service_role;

commit;
