begin;

create function public.save_task_preflight(
  p_portal_id text,
  p_owner_id text,
  p_draft_id uuid,
  p_expected_revision integer,
  p_expected_access_version bigint,
  p_is_bitrix_admin boolean,
  p_preflight_snapshot jsonb
)
returns public.operation_draft
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft_record public.operation_draft;
  settings_record public.user_settings;
begin
  if p_portal_id is null
    or btrim(p_portal_id) = ''
    or p_owner_id is null
    or btrim(p_owner_id) = ''
    or p_draft_id is null
    or p_expected_revision is null
    or p_expected_revision <= 0
    or p_is_bitrix_admin is null
    or p_preflight_snapshot is null
    or (p_is_bitrix_admin and p_expected_access_version is not null)
    or (not p_is_bitrix_admin and p_expected_access_version is null) then
    raise exception 'TC_TASK_PREFLIGHT_INVALID' using errcode = '22023';
  end if;

  if not p_is_bitrix_admin then
    select * into settings_record
    from public.user_settings
    where portal_id = p_portal_id and user_id = p_owner_id
    for share;

    if not found
      or settings_record.access_state <> 'active'
      or settings_record.access_version <> p_expected_access_version
      or not (array['app_access', 'run_bulk_operations', 'change_allowed_fields']::text[]
        <@ settings_record.permissions) then
      raise exception 'TC_TASK_PREFLIGHT_ACCESS_CHANGED' using errcode = '40001';
    end if;
  end if;

  select * into draft_record
  from public.operation_draft
  where portal_id = p_portal_id and owner_id = p_owner_id and id = p_draft_id
  for update;

  if not found or draft_record.expires_at <= now() then
    raise exception 'TC_TASK_PREFLIGHT_DRAFT_CONFLICT' using errcode = '40001';
  end if;

  if draft_record.revision = p_expected_revision + 1
    and draft_record.status = 'awaiting_confirmation'
    and coalesce(draft_record.preflight_snapshot ->> 'draftId', '') = p_draft_id::text
    and coalesce(draft_record.preflight_snapshot ->> 'sourceDraftRevision', '')
      = p_expected_revision::text
    and (
      (
        p_is_bitrix_admin
        and draft_record.preflight_snapshot -> 'actorAccessVersion' = 'null'::jsonb
      )
      or (
        not p_is_bitrix_admin
        and coalesce(draft_record.preflight_snapshot ->> 'actorAccessVersion', '')
          = p_expected_access_version::text
      )
    ) then
    return draft_record;
  end if;

  if draft_record.revision <> p_expected_revision
    or draft_record.status not in ('preparing', 'awaiting_confirmation') then
    raise exception 'TC_TASK_PREFLIGHT_DRAFT_CONFLICT' using errcode = '40001';
  end if;

  if jsonb_typeof(p_preflight_snapshot) <> 'object'
    or coalesce(p_preflight_snapshot ->> 'draftId', '') <> p_draft_id::text
    or coalesce(p_preflight_snapshot ->> 'sourceDraftRevision', '')
      <> p_expected_revision::text
    or coalesce(p_preflight_snapshot ->> 'draftRevision', '')
      <> (p_expected_revision + 1)::text
    or (
      p_is_bitrix_admin
      and p_preflight_snapshot -> 'actorAccessVersion' is distinct from 'null'::jsonb
    )
    or (
      not p_is_bitrix_admin
      and coalesce(p_preflight_snapshot ->> 'actorAccessVersion', '')
        <> p_expected_access_version::text
    ) then
    raise exception 'TC_TASK_PREFLIGHT_INVALID' using errcode = '22023';
  end if;

  if pg_catalog.octet_length(pg_catalog.convert_to(p_preflight_snapshot::text, 'UTF8')) > 8388608 then
    raise exception 'TC_TASK_PREFLIGHT_TOO_LARGE' using errcode = '22023';
  end if;

  update public.operation_draft
  set
    revision = revision + 1,
    status = 'awaiting_confirmation',
    preflight_snapshot = p_preflight_snapshot
  where portal_id = p_portal_id and owner_id = p_owner_id and id = p_draft_id
  returning * into draft_record;

  return draft_record;
end;
$$;

revoke all on function public.save_task_preflight(
  text, text, uuid, integer, bigint, boolean, jsonb
) from public, anon, authenticated;
grant execute on function public.save_task_preflight(
  text, text, uuid, integer, bigint, boolean, jsonb
) to service_role;

commit;
