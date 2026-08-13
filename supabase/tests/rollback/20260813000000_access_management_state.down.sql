do $$
begin
  if exists (
    select 1 from public.user_settings where cardinality(allowed_field_ids) > 256
  ) then
    raise exception 'TC_ACCESS_ROLLBACK_REQUIRES_FIELD_REDUCTION';
  end if;
end;
$$;

drop trigger if exists user_settings_prepare_access_state on public.user_settings;
drop trigger if exists access_change_evidence_prevent_mutation on public.access_change_evidence;
drop trigger if exists access_legacy_quarantine_backup_prevent_mutation on public.access_legacy_quarantine_backup;
drop trigger if exists access_change_prevent_mutation on public.access_change;
drop trigger if exists access_field_set_member_prevent_mutation on public.access_field_set_member;
drop trigger if exists access_field_set_prevent_mutation on public.access_field_set;

drop function if exists public.finalize_access_command(text, uuid, bigint);
drop function if exists public.fail_access_command(text, uuid, bigint, text);
drop function if exists public.apply_access_command_target(
  text, uuid, bigint, text, boolean, boolean, boolean, boolean, boolean, boolean
);
drop function if exists public.claim_access_command(text, uuid, bigint);
drop function if exists public.read_access_command(text, uuid);
drop function if exists public.accept_access_command(text, uuid, text, uuid, text, text, boolean, uuid, text);
drop function if exists public.create_access_preflight(
  text, uuid, bigint, text, bigint, integer, text, text, jsonb, jsonb
);
drop function if exists public.save_access_draft(text, text, bigint, jsonb);
drop function if exists public.consume_access_management_read_limit(text, text);
drop function if exists public.consume_access_rate_limit(text, text, text, integer);
drop function if exists public.prepare_user_settings_access_state();
drop function if exists public.resolve_access_field_set(text, text[]);
drop function if exists public.access_field_set_for_fields(text, text[]);
drop function if exists public.prevent_access_immutable_mutation();

alter table if exists public.user_settings
  drop constraint if exists user_settings_portal_id_field_set_id_fkey,
  drop constraint if exists user_settings_access_state_canonical,
  drop constraint if exists user_settings_access_active_app_access_equivalence,
  drop constraint if exists user_settings_allowed_fields_distinct_and_valid,
  drop constraint if exists user_settings_permissions_distinct_and_valid,
  drop constraint if exists user_settings_permission_matrix_version_positive,
  drop constraint if exists user_settings_access_version_positive,
  drop constraint if exists user_settings_access_state_allowed;

-- Restore every legacy value captured before fail-closed quarantine. The rollback must not turn a
-- reversible migration into permanent access-data loss.
alter table public.user_settings disable trigger user_settings_set_updated_at;
update public.user_settings as settings
set
  access_active = backup.access_active,
  permissions = backup.permissions,
  allowed_field_ids = backup.allowed_field_ids,
  granted_at = backup.granted_at,
  granted_by_user_id = backup.granted_by_user_id,
  access_revoked_at = backup.access_revoked_at,
  updated_at = backup.updated_at
from public.access_legacy_quarantine_backup as backup
where backup.portal_id = settings.portal_id and backup.user_id = settings.user_id;
alter table public.user_settings enable trigger user_settings_set_updated_at;

drop table if exists public.notification_outbox;
drop table if exists public.access_legacy_quarantine_backup;
drop table if exists public.access_change_evidence;
drop table if exists public.access_command_dispatch_outbox;
drop table if exists public.access_command_target;
drop table if exists public.access_change;
drop table if exists public.access_command;
drop table if exists public.access_preflight_target;
drop table if exists public.access_preflight;
drop table if exists public.access_management_draft;
drop table if exists public.access_rate_limit_bucket;

alter table if exists public.user_settings
  drop column if exists field_set_id,
  drop column if exists permission_matrix_version,
  drop column if exists access_version,
  drop column if exists access_state;

drop table if exists public.access_field_set_member;
drop table if exists public.access_field_set;
drop function if exists public.access_permissions_are_valid(text[]);
drop function if exists public.access_text_array_is_canonical(text[], integer);

alter table public.user_settings
  add constraint user_settings_allowed_fields_limit check (cardinality(allowed_field_ids) <= 256);
