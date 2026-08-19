# Task 012: automatic access revocation decisions

Date: 2026-08-14  
Status: approved  
Task: **012. Implement automatic access revocation**

## Confirmed product rules

- A confirmed inactive or missing employee loses all Task Commander access. The original
  assignment, audit history, reports, and saved filters are not deleted.
- Losing the final formal Bitrix department-head role removes only `manage_access`. Losing one of
  several leadership roles does not change access.
- Rehire, reactivation, or return to a manager role never restores a previous delegated grant.
  A current Bitrix administrator remains an exception because administrator access is derived by
  the PRD.
- A transient, incomplete, or unauthorized Bitrix response is not treated as dismissal. New
  sensitive actions fail closed until a fresh check succeeds, while the persisted assignment is
  retried by Cron.
- Reconciliation is performed for each protected request, before future task processing, and by a
  five-minute Cron sweep. A future Bitrix webhook is only an acceleration signal and must use the
  same reconciliation path.
- A full automatic revocation requests interruption of the active bulk operation. The in-flight
  task is allowed to record its actual result; no later task starts. The first accepted stop reason
  remains authoritative.
- Only a permission or field required by a running operation may interrupt it. Loss of an
  unrelated right does not.
- Every effective automatic change writes one idempotent audit event: `access_auto_revoke` for a
  full revocation or `access_update` for manager-role loss. It additionally writes a field audit
  event when the stored field set is removed and one best-effort notification outbox entry. A
  repeated no-op check writes none of them.

## Implementation boundary

Task 012 provides the mock adapter, database reconciliation transaction, request-time validation,
and Cron sweep. Production OAuth refresh, Bitrix event registration, notification delivery, and
the task-by-task bulk consumer remain tasks 035, 029, and 022 respectively.
