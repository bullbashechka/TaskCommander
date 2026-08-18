# Security audit hardening decisions

Date: 2026-08-18

- Supabase service-role clients accept only a comma-separated list of canonical HTTPS origins.
  A URL with credentials, a path, query, fragment, or non-default port is rejected before a client
  is constructed.
- The public health route is liveness only. Detailed readiness is an internal no-store route that
  requires `INTERNAL_READINESS_TOKEN` and returns 503 when dependencies are degraded.
- Browser-facing responses use a strict CSP. Trusted Bitrix frame/media origins are deployment
  configuration, never query-string input. The local runtime probe is opt-in and requires a
  loopback request plus `LOCAL_RUNTIME_PROBE_TOKEN`.
- Every Bitrix adapter created by the runtime is wrapped by the configured-origin policy: task and
  profile links must use the portal origin, media/report links must use portal/media origins, and
  notification links must use the application origin. Foreign HTTPS output becomes an
  `invalid_external_response` before persistence or rendering.
- Unsafe API requests require JSON, the exact configured application origin and acceptable Fetch
  Metadata. Session, probe and access-management fan-out use separate Cloudflare rate-limit
  bindings.
- API and Queue consumer bindings are generated independently. Worker entry points require their
  exact generated environment, while readiness tests use only a derived partial view.
- User operations and system-consumer transitions use distinct runtime-branded capabilities; a
  user context is never accepted by worker-only repository methods.
- Audit writers accept only action-compatible detail shapes and finite reason/error-code and system
  component allowlists. The database enforces the same rule for direct security-definer writes;
  arbitrary exception text and upstream payloads are not valid audit details.
- Security database changes are forward-only. The fixture cleanup RPC is removed; integration tests
  use a uniquely named portal in the disposable local database, whose lifecycle is owned by
  `db:docker:reset` rather than a deployable cleanup API. Stale cron/queue leases return
  `stale_lease` before access, audit, or notification changes.
- The 256-member constraint is enforced for new writes as `NOT VALID`; legacy oversized immutable
  sets must be quarantined and reconciled before a later roll-forward validates the constraint.
- OAuth replay protection, server-side session revocation and signing-key rotation are deferred to
  task 035 because they require the production OAuth authority and persistent session model.
- Rollback is roll-forward: unsafe grants, search paths and destructive fixture RPCs must not be
  restored. A failed rollout is corrected by a new migration and a compatible Worker version.
