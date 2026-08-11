begin;

do $$
begin
  if exists (select 1 from public.audit_event) then
    raise exception 'TC_AUDIT_MIGRATION_REQUIRES_EMPTY_JOURNAL' using errcode = 'P0001';
  end if;
end;
$$;

drop trigger if exists audit_event_prevent_update on public.audit_event;
drop trigger if exists audit_event_prevent_delete on public.audit_event;

alter table public.audit_event rename column metadata to details;

alter table public.audit_event
  add column schema_version smallint not null default 1,
  add column recorded_at timestamptz not null default now(),
  add column actor_type text not null default 'system',
  add column actor_source text,
  add column subject_display_name text,
  add column related_objects jsonb not null default '[]'::jsonb,
  add column event_key text;

alter table public.audit_event
  alter column actor_display_name set not null,
  alter column subject_type set not null,
  alter column subject_id set not null,
  alter column subject_display_name set not null,
  alter column correlation_id set not null,
  alter column event_key set not null;

alter table public.audit_event
  drop constraint if exists audit_event_action_allowed,
  drop constraint if exists audit_event_actor_id_format,
  drop constraint if exists audit_event_actor_name_format,
  drop constraint if exists audit_event_subject_type_format,
  drop constraint if exists audit_event_subject_id_format,
  drop constraint if exists audit_event_outcome_allowed,
  drop constraint if exists audit_event_correlation_format,
  drop constraint if exists audit_event_metadata_shape;

alter table public.audit_event
  add constraint audit_event_schema_version_allowed check (schema_version = 1),
  add constraint audit_event_action_allowed check (
    action in (
      'operation_create', 'operation_start', 'operation_complete', 'operation_cancel',
      'operation_interrupt', 'operation_retry', 'operation_restore',
      'access_grant', 'access_update', 'access_revoke', 'access_auto_revoke',
      'allowed_fields_update',
      'report_export', 'report_generate', 'report_store', 'report_download',
      'report_archive', 'report_delete',
      'audit_view', 'audit_retention', 'system_error', 'system_recovery'
    )
  ),
  add constraint audit_event_outcome_allowed check (
    outcome in ('success', 'partial', 'failure', 'denied', 'uncertain')
  ),
  add constraint audit_event_actor_valid check (
    (
      actor_type = 'user'
      and actor_id ~ '^[0-9]+$'
      and char_length(actor_id) between 1 and 32
      and actor_source is null
    )
    or (
      actor_type = 'system'
      and actor_id is null
      and actor_source in ('internal', 'queue', 'cron', 'recovery', 'retention')
      and actor_display_name = 'Система'
    )
  ),
  add constraint audit_event_actor_name_format check (
    actor_display_name = btrim(actor_display_name)
    and char_length(actor_display_name) between 1 and 256
  ),
  add constraint audit_event_subject_type_allowed check (
    subject_type in ('operation', 'operation_attempt', 'report', 'user', 'access', 'settings', 'system')
  ),
  add constraint audit_event_subject_id_format check (
    subject_id = btrim(subject_id) and char_length(subject_id) between 1 and 256
  ),
  add constraint audit_event_subject_name_format check (
    subject_display_name = btrim(subject_display_name)
    and char_length(subject_display_name) between 1 and 256
  ),
  add constraint audit_event_correlation_format check (
    correlation_id ~ '^TC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  add constraint audit_event_key_format check (event_key ~ '^[0-9a-f]{64}$'),
  add constraint audit_event_details_shape check (
    jsonb_typeof(details) = 'object' and octet_length(details::text) <= 16384
  ),
  add constraint audit_event_related_objects_shape check (
    jsonb_typeof(related_objects) = 'array'
    and jsonb_array_length(related_objects) <= 8
    and octet_length(related_objects::text) <= 8192
  ),
  add constraint audit_event_key_unique unique (portal_id, event_key);

create or replace function public.prevent_audit_event_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'delete' then
    if current_setting('task_commander.audit_retention', true) = 'enabled'
      and old.occurred_at < now() - interval '2 years' then
      return old;
    end if;
  end if;

  raise exception 'Audit events are append-only.' using errcode = '23514';
end;
$$;

create trigger audit_event_prevent_update
before update on public.audit_event
for each row execute function public.prevent_audit_event_mutation();

create trigger audit_event_prevent_delete
before delete on public.audit_event
for each row execute function public.prevent_audit_event_mutation();

create function public.append_audit_event(
  p_portal_id text,
  p_occurred_at timestamptz,
  p_action text,
  p_actor_type text,
  p_actor_id text,
  p_actor_display_name text,
  p_actor_source text,
  p_subject_type text,
  p_subject_id text,
  p_subject_display_name text,
  p_related_objects jsonb,
  p_outcome text,
  p_correlation_id text,
  p_deduplication_scope text,
  p_event_slot text,
  p_details jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  created_event public.audit_event;
  existing_event public.audit_event;
  computed_event_key text;
begin
  computed_event_key := encode(
    extensions.digest(p_deduplication_scope || chr(31) || p_action || chr(31) || p_event_slot, 'sha256'),
    'hex'
  );

  insert into public.audit_event (
    portal_id,
    occurred_at,
    action,
    actor_type,
    actor_id,
    actor_display_name,
    actor_source,
    subject_type,
    subject_id,
    subject_display_name,
    related_objects,
    outcome,
    correlation_id,
    event_key,
    details
  )
  values (
    p_portal_id,
    p_occurred_at,
    p_action,
    p_actor_type,
    p_actor_id,
    p_actor_display_name,
    p_actor_source,
    p_subject_type,
    p_subject_id,
    p_subject_display_name,
    p_related_objects,
    p_outcome,
    p_correlation_id,
    computed_event_key,
    p_details
  )
  on conflict (portal_id, event_key) do nothing
  returning * into created_event;

  if found then
    return jsonb_build_object('inserted', true, 'event', to_jsonb(created_event));
  end if;

  select *
  into existing_event
  from public.audit_event
  where portal_id = p_portal_id and event_key = computed_event_key;

  if existing_event.occurred_at is distinct from p_occurred_at
    or existing_event.action is distinct from p_action
    or existing_event.actor_type is distinct from p_actor_type
    or existing_event.actor_id is distinct from p_actor_id
    or existing_event.actor_display_name is distinct from p_actor_display_name
    or existing_event.actor_source is distinct from p_actor_source
    or existing_event.subject_type is distinct from p_subject_type
    or existing_event.subject_id is distinct from p_subject_id
    or existing_event.subject_display_name is distinct from p_subject_display_name
    or existing_event.related_objects is distinct from p_related_objects
    or existing_event.outcome is distinct from p_outcome
    or existing_event.correlation_id is distinct from p_correlation_id
    or existing_event.details is distinct from p_details then
    raise exception 'TC_AUDIT_EVENT_CONFLICT' using errcode = 'P0001';
  end if;

  return jsonb_build_object('inserted', false, 'event', to_jsonb(existing_event));
end;
$$;

create function public.purge_expired_audit_events(
  p_correlation_id text,
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  cutoff_at timestamptz := now() - interval '2 years';
  portal_record record;
  total_deleted integer := 0;
begin
  perform set_config('task_commander.audit_retention', 'enabled', true);

  for portal_record in
    with deleted_events as (
      delete from public.audit_event
      where occurred_at < cutoff_at
      returning portal_id
    )
    select portal_id, count(*)::integer as deleted_count
    from deleted_events
    group by portal_id
  loop
    total_deleted := total_deleted + portal_record.deleted_count;
    perform public.append_audit_event(
      portal_record.portal_id,
      now(),
      'audit_retention',
      'system',
      null,
      'Система',
      'retention',
      'system',
      'audit-journal',
      'Журнал аудита',
      '[]'::jsonb,
      'success',
      p_correlation_id,
      'retention:' || p_run_id::text,
      'portal:' || portal_record.portal_id,
      jsonb_build_object(
        'kind', 'retention',
        'cutoffAt', cutoff_at,
        'deletedCount', portal_record.deleted_count
      )
    );
  end loop;

  return jsonb_build_object('cutoffAt', cutoff_at, 'deletedCount', total_deleted);
end;
$$;

revoke all on table public.audit_event from anon, authenticated, service_role;
grant select on table public.audit_event to service_role;

revoke all on function public.append_audit_event(
  text, timestamptz, text, text, text, text, text, text, text, text, jsonb, text, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.purge_expired_audit_events(text, uuid) from public, anon, authenticated;

grant execute on function public.append_audit_event(
  text, timestamptz, text, text, text, text, text, text, text, text, jsonb, text, text, text, text, jsonb
) to service_role;
grant execute on function public.purge_expired_audit_events(text, uuid) to service_role;

commit;
