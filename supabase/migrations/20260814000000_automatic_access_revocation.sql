begin;

create table public.access_reconciliation_job (
  portal_id text not null,
  user_id text not null,
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_checked_at timestamptz,
  last_outcome text,
  primary key (portal_id, user_id),
  foreign key (portal_id, user_id)
    references public.user_settings (portal_id, user_id) on delete restrict,
  constraint access_reconciliation_job_outcome_valid check (
    last_outcome is null or last_outcome in ('active', 'inactive', 'missing', 'unknown')
  ),
  constraint access_reconciliation_job_lease_valid check (
    (lease_token is null) = (lease_expires_at is null)
  )
);

create index access_reconciliation_job_due
  on public.access_reconciliation_job (available_at, portal_id, user_id);

create function public.queue_access_reconciliation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.access_active or 'manage_access' = any(new.permissions) then
    insert into public.access_reconciliation_job (portal_id, user_id, available_at)
    values (new.portal_id, new.user_id, now())
    on conflict (portal_id, user_id) do update
    set available_at = least(public.access_reconciliation_job.available_at, excluded.available_at),
        lease_token = null,
        lease_expires_at = null;
  else
    delete from public.access_reconciliation_job
    where portal_id = new.portal_id and user_id = new.user_id;
  end if;
  return new;
end;
$$;

create trigger user_settings_queue_access_reconciliation
after insert or update of access_active, permissions
on public.user_settings
for each row execute function public.queue_access_reconciliation();

insert into public.access_reconciliation_job (portal_id, user_id, available_at)
select portal_id, user_id, now()
from public.user_settings
where access_active or 'manage_access' = any(permissions)
on conflict (portal_id, user_id) do nothing;

create function public.claim_access_reconciliation_jobs(
  p_lease_token uuid,
  p_limit integer
)
returns table (portal_id text, user_id text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_lease_token is null or p_limit < 1 or p_limit > 100 then
    raise exception 'TC_ACCESS_RECONCILIATION_CLAIM_INVALID' using errcode = '22023';
  end if;

  return query
  with claimed as (
    select job.portal_id, job.user_id
    from public.access_reconciliation_job as job
    where job.available_at <= now()
      and (job.lease_expires_at is null or job.lease_expires_at <= now())
    order by job.available_at, job.portal_id, job.user_id
    for update skip locked
    limit p_limit
  ), updated as (
    update public.access_reconciliation_job as job
    set lease_token = p_lease_token,
        lease_expires_at = now() + interval '4 minutes'
    from claimed
    where job.portal_id = claimed.portal_id and job.user_id = claimed.user_id
    returning job.portal_id, job.user_id
  )
  select updated.portal_id, updated.user_id from updated;
end;
$$;

create function public.record_access_reconciliation_unknown(
  p_portal_id text,
  p_user_id text,
  p_lease_token uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.access_reconciliation_job
  set available_at = now() + interval '5 minutes',
      lease_token = null,
      lease_expires_at = null,
      last_checked_at = now(),
      last_outcome = 'unknown'
  where portal_id = p_portal_id and user_id = p_user_id
    and (p_lease_token is null or lease_token = p_lease_token);
end;
$$;

create function public.apply_automatic_access_reconciliation(
  p_portal_id text,
  p_user_id text,
  p_display_name text,
  p_employment_state text,
  p_is_manager boolean,
  p_source text,
  p_correlation_id text,
  p_lease_token uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  settings_record public.user_settings;
  updated_settings public.user_settings;
  previous_fields text[];
  previous_permissions text[];
  before_state jsonb;
  after_state jsonb;
  audit_result jsonb := '{}'::jsonb;
  field_audit_result jsonb := '{}'::jsonb;
  change_record public.access_change;
  reason_code text;
  notification_kind text;
  source_name text;
  action_applied boolean := false;
  operation_record public.bulk_operation;
begin
  if p_employment_state not in ('active', 'inactive', 'missing')
    or p_source not in ('request', 'cron', 'queue') then
    raise exception 'TC_ACCESS_RECONCILIATION_INPUT_INVALID' using errcode = '22023';
  end if;

  select * into settings_record
  from public.user_settings
  where portal_id = p_portal_id and user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('disposition', 'unavailable');
  end if;

  if p_lease_token is not null then
    update public.access_reconciliation_job
    set lease_token = null,
        lease_expires_at = null,
        last_checked_at = now(),
        last_outcome = p_employment_state,
        available_at = now() + interval '5 minutes'
    where portal_id = p_portal_id and user_id = p_user_id and lease_token = p_lease_token;
  end if;

  previous_fields := settings_record.allowed_field_ids;
  previous_permissions := settings_record.permissions;
  before_state := jsonb_build_object(
    'accessState', settings_record.access_state,
    'accessVersion', settings_record.access_version,
    'permissions', to_jsonb(previous_permissions),
    'fieldSetId', settings_record.field_set_id
  );
  source_name := case when p_source = 'cron' then 'cron' when p_source = 'queue' then 'queue' else 'internal' end;

  if p_employment_state in ('inactive', 'missing') then
    if settings_record.access_active or cardinality(previous_permissions) > 0
      or cardinality(previous_fields) > 0 then
      reason_code := case when p_employment_state = 'missing' then 'EMPLOYEE_MISSING' else 'EMPLOYEE_INACTIVE' end;
      update public.user_settings set
        access_active = false,
        access_state = 'revoked',
        access_version = access_version + 1,
        permissions = '{}'::text[],
        allowed_field_ids = '{}'::text[],
        field_set_id = null,
        granted_by_user_id = null,
        access_revoked_at = now()
      where portal_id = p_portal_id and user_id = p_user_id
      returning * into updated_settings;
      notification_kind := 'access_revoked';
      action_applied := true;
    end if;
  elsif settings_record.access_state = 'active'
    and 'manage_access' = any(previous_permissions)
    and not p_is_manager then
    reason_code := 'MANAGER_ROLE_LOST';
    update public.user_settings set
      access_version = access_version + 1,
      permissions = array_remove(permissions, 'manage_access')
    where portal_id = p_portal_id and user_id = p_user_id
    returning * into updated_settings;
    notification_kind := 'access_updated';
    action_applied := true;
  end if;

  if not action_applied then
    return jsonb_build_object('disposition', 'no_change');
  end if;

  after_state := jsonb_build_object(
    'accessState', updated_settings.access_state,
    'accessVersion', updated_settings.access_version,
    'permissions', to_jsonb(updated_settings.permissions),
    'fieldSetId', updated_settings.field_set_id
  );
  audit_result := public.append_audit_event(
    p_portal_id, now(),
    case when updated_settings.access_state = 'revoked' then 'access_auto_revoke' else 'access_update' end,
    'system', null, 'Система', source_name,
    'access', p_user_id, coalesce(nullif(p_display_name, ''), settings_record.display_name),
    '[]'::jsonb, 'success', p_correlation_id,
    'automatic-access:' || p_user_id || ':' || updated_settings.access_version::text,
    'access',
    jsonb_build_object(
      'kind', 'access', 'version', 2,
      'previousAccessVersion', settings_record.access_version,
      'newAccessVersion', updated_settings.access_version,
      'accessState', updated_settings.access_state,
      'addedPermissions', '[]'::jsonb,
      'removedPermissions', to_jsonb(array(
        select permission from unnest(previous_permissions) as permission
        except select permission from unnest(updated_settings.permissions) as permission
      )),
      'addedFieldCount', 0,
      'removedFieldCount', cardinality(previous_fields),
      'reasonCode', reason_code
    )
  );

  if cardinality(previous_fields) > 0 and cardinality(updated_settings.allowed_field_ids) = 0 then
    field_audit_result := public.append_audit_event(
      p_portal_id, now(), 'allowed_fields_update', 'system', null, 'Система', source_name,
      'settings', p_user_id, coalesce(nullif(p_display_name, ''), settings_record.display_name),
      '[]'::jsonb, 'success', p_correlation_id,
      'automatic-access:' || p_user_id || ':' || updated_settings.access_version::text,
      'fields',
      jsonb_build_object(
        'kind', 'access', 'version', 2,
        'previousAccessVersion', settings_record.access_version,
        'newAccessVersion', updated_settings.access_version,
        'accessState', updated_settings.access_state,
        'addedPermissions', '[]'::jsonb,
        'removedPermissions', '[]'::jsonb,
        'addedFieldCount', 0,
        'removedFieldCount', cardinality(previous_fields),
        'reasonCode', reason_code
      )
    );
  end if;

  insert into public.access_change (
    portal_id, command_id, target_user_id, actor_type, actor_user_id, actor_display_name,
    change_kind, previous_access_version, new_access_version, before_snapshot, after_snapshot,
    audit_event_id, field_audit_event_id, correlation_id
  ) values (
    p_portal_id, null, p_user_id, 'system', null, 'Система',
    case when updated_settings.access_state = 'revoked' then 'revoke' else 'update' end,
    settings_record.access_version, updated_settings.access_version, before_state, after_state,
    (audit_result -> 'event' ->> 'id')::uuid,
    nullif(field_audit_result -> 'event' ->> 'id', '')::uuid,
    p_correlation_id
  ) returning * into change_record;

  insert into public.access_change_evidence (
    portal_id, access_change_id, evidence_type, evidence_payload
  ) values (
    p_portal_id, change_record.id, 'bitrix_access_reconciliation',
    jsonb_build_object('employmentState', p_employment_state, 'manager', p_is_manager, 'source', p_source)
  );

  insert into public.notification_outbox (
    portal_id, access_change_id, recipient_user_id, notification_kind, payload
  ) values (
    p_portal_id, change_record.id, p_user_id, notification_kind,
    jsonb_build_object('accessChangeId', change_record.id, 'accessVersion', updated_settings.access_version,
      'accessState', updated_settings.access_state, 'correlationId', p_correlation_id)
  );

  if updated_settings.access_state = 'revoked' then
    select * into operation_record from public.bulk_operation
    where portal_id = p_portal_id and initiator_id = p_user_id
      and status in ('launching', 'running')
    order by created_at
    limit 1
    for update;
    if found then
      perform public.request_bulk_operation_stop(
        p_portal_id, operation_record.id, 'interrupt', reason_code,
        'Доступ инициатора автоматически отозван.', p_correlation_id
      );
    end if;
  end if;

  return jsonb_build_object(
    'disposition', 'applied',
    'accessState', updated_settings.access_state,
    'accessVersion', updated_settings.access_version,
    'reasonCode', reason_code
  );
end;
$$;

alter table public.access_reconciliation_job enable row level security;
revoke all on table public.access_reconciliation_job from anon, authenticated, service_role;
grant select on table public.access_reconciliation_job to service_role;

revoke all on function public.queue_access_reconciliation() from public, anon, authenticated, service_role;
revoke all on function public.claim_access_reconciliation_jobs(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.record_access_reconciliation_unknown(text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.apply_automatic_access_reconciliation(
  text, text, text, text, boolean, text, text, uuid
) from public, anon, authenticated;

grant execute on function public.claim_access_reconciliation_jobs(uuid, integer) to service_role;
grant execute on function public.record_access_reconciliation_unknown(text, text, uuid) to service_role;
grant execute on function public.apply_automatic_access_reconciliation(
  text, text, text, text, boolean, text, text, uuid
) to service_role;

commit;
