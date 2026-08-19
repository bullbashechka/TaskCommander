# Task 011: access-management decisions

Date: 2026-08-13  
Status: approved  
Task: **011. Implement access and allowed-fields management**

Sources: [task 011](../../tasks/011-access-management.md),
[PRD access management](../../PRD.md#416-управление-доступом), and the effective-access
boundary fixed in task 010.

The approved visual direction is recorded in
[the task 011 reference](../references/task-011-access-management-approved.png). It guides the
employee search, access status, attention, selection, and bulk-configuration surfaces; the security
rules and server contracts below remain authoritative when the reference is ambiguous.

## Authority and assignment rules

- A verified Bitrix administrator always has every Task Commander permission and all fields. Its
  access is derived rather than editable, and no task 011 command may restrict or revoke it.
- A non-administrator must be an active Bitrix manager and have effective `manage_access` to use this
  area. Only an administrator may grant `manage_access`, and only to an active manager.
- An authorized manager may find and manage any employee in the portal; department membership does
  not constrain assignment. The manager may grant or remove only permissions and fields inside the
  manager's own current effective scope. Every server-side validation rechecks this scope.
- Permission dependencies are catalogued and versioned. Every permission other than `app_access`
  depends on `app_access`; `run_bulk_operations` also depends on `change_allowed_fields`;
  `retry_operations` and `restore_operations` also depend on `run_bulk_operations` and
  `view_own_reports`; `view_all_reports` and `export_reports` also depend on
  `view_own_reports`. The preflight reports dependency-driven additions or removals as an automatic
  delta rather than silently hiding them.
- Allowed fields use either `{ kind: 'all' }` or a versioned `set` reference containing only a
  `fieldSetId`, version, count, and fingerprint. List and profile payloads do not inline raw field
  values. There is no product-level maximum field-set size; members are read as pages of at most 100
  unique field IDs. Task 011 removes the former task 010 limit from the effective-access bridge as
  part of the same migration, so a normalized set larger than 256 members is never truncated or
  rejected. `{ kind: 'all' }` is the derived, immutable scope of a live Bitrix administrator;
  editable non-administrator assignments always persist an explicit versioned set (including the
  empty set), so a later Bitrix field addition cannot silently expand delegated access.
- Access has no schedule or expiry. `active`, `revoked`, `quarantined`, and `review_required` are the
  managed access states. Bitrix employment is independently `active`, `inactive`, or `unknown`.
  Task 011 refuses a mutation when employment is inactive or unknown. The periodic automatic revoke
  for an inactive employee and removal of `manage_access` after loss of manager status belong to
  task 012. Unknown employment or inconsistent data always fails closed rather than being guessed.
- The application records only the effective permission/field difference in audit and initiates a
  Bitrix notification after a grant, update, or revoke. New access is visible on the recipient's next
  server-side session check. A required audit write failing prevents the significant change from
  starting; notification failure is reported separately and does not falsify the applied result.
  The recipient transition is classified as `access_grant`, `access_update`, or `access_revoke`;
  a non-empty field-scope delta additionally records `allowed_fields_update`. Automatic revocation
  uses `access_auto_revoke`. No-difference targets produce none of these change events.

## Change model

Commands use one of five modes:

- `grant` adds the requested delegable access;
- `replace_managed` makes the portion managed by the actor match the requested access without
  touching authority outside that actor's delegable scope;
- `revoke_managed` removes requested access inside the actor's delegable scope;
- `full_revoke` removes the complete non-administrator assignment, but only when every removed
  permission and field is inside the actor's current delegable scope (an administrator always
  qualifies);
- `repair` reconciles quarantined or inconsistent data and is reserved for an administrator or an
  authorized system workflow.

The business reason is one of `role_change`, `responsibility_change`, `security_policy`,
`access_cleanup`, `employee_request`, or `other`. `other` requires a trimmed 10–500 character
comment; preset reasons accept no free-form comment. A reason is mandatory only when the computed
effective delta removes a permission or field; additive and no-op drafts may omit it. One draft
contains at most 100 unique recipients and lives for 24 hours.

## Versioned preflight and confirmation

1. Employee search and profile DTOs return safe Bitrix facts, employment/access state, and the
   versions and capabilities needed to prepare a draft. Administrator rows remain viewable but
   immutable.
2. A draft pins its revision, permission-catalog version, actor access version, and each target's
   base access version. A stale revision cannot overwrite a newer draft.
3. Preflight rechecks current employment, manager/admin status, actor authority, catalog version,
   permission dependencies, field-set versions, and every target access version. Its lifetime is 10
   minutes. Targets are `ready`, `excluded`, `conflict`, or `no_change` at this stage.
4. Each target exposes requested and automatic *redacted* deltas: permission names may be listed,
   while field changes contain only before/after references and added/removed counts. Safe reason
   codes explain exclusions and conflicts; raw upstream errors and field values are forbidden.
5. Preflight returns a bounded summary and explicit confirmation requirements. Confirmation is tied
   to the exact preflight and draft revision and lives for 5 minutes. Any changed or expired input
   requires a new preflight and confirmation.
6. The execution command contains only a client-generated `commandId`, the server-issued
   `preflightId`, and an optional server-issued confirmation token. It cannot resubmit recipients,
   permissions, or fields. Tokens are bearer data and must not enter logs, audit details, URLs, or
   analytics.

Command lifecycle states are `accepted`, `validating`, `in_progress`, `succeeded`,
`partially_succeeded`, `failed`, and `no_change`. Per-target states are `ready`, `excluded`,
`conflict`, `applying`, `applied`, `failed`, and `no_change`. Receipts provide a bounded aggregate
and per-target state, version transition, effective redacted delta, safe reason code, and notification
state. Reusing the same command ID with identical content returns the same receipt; reuse with
different content is a conflict. A target version change after preflight is a conflict, never a blind
overwrite. A zero-difference command completes as `no_change` and creates no false access-change
audit event.

## Scope boundary

Task 011 covers employee discovery/profile contracts, access drafts, preflight, confirmation,
application receipts, audit initiation, and notification initiation. Temporary access and expiry
dates remain out of scope. Task Commander permissions never expand native Bitrix task visibility or
editability.
