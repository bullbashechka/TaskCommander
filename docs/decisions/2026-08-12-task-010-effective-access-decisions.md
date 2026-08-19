# Task 010: effective-access boundary

## Decision

Every protected request derives its identity from the verified, signed session cookie. The Worker uses
that principal's `portalId` and `userId` for a server-side `user_settings` lookup, then resolves a
request-scoped effective-access object. Request parameters and headers never contribute identity,
permissions, administrator status, or allowed fields.

## Rules

- The shared access contract defines one canonical set of ten application permissions. The complete
  persisted settings row is parsed strictly; unknown keys, invalid values, duplicate permissions,
  and duplicate field identifiers deny access instead of being silently discarded.
- Missing or inactive non-administrator settings deny access. A signed Bitrix administrator has all
  application permissions and the `all` application field scope without depending on that row.
- Only a principal registered by successful signed-cookie verification can create effective access.
  Verified principals, effective access, and repository contexts use module-private capability
  registries; their nested values are copied and frozen, so structural copies and mutations cannot
  acquire or alter authority.
- Application field scope only limits access. A field change is allowed only after the requested,
  deduplicated set is wholly inside the application scope and Bitrix confirms every requested field
  is editable for the concrete task. Every such authorization rechecks the active Bitrix identity
  and requires it to match the verified session before reading native task editability.
- Report reads require `view_own_reports` or `view_all_reports`; no implicit own-report access exists.
  A foreign report retry or restore requires both its action permission and `view_all_reports`.
  The guard supplies the signed principal's portal to a repository-backed owner lookup, so callers
  cannot submit an owner or portal.
- Effective access is not cached across requests. Database or Bitrix authorization failures fail
  closed. `app_access` and the private context capability are checked before every public repository
  method reads tenant identifiers or constructs a query, while endpoint-specific permissions remain
  separate. Public API responses expose only the safe effective permissions and field scope. The
  exported canonical permission tuple is frozen at runtime and cannot be changed by consumers.
