# 025: Restore previous task values

## Decision

A restore is a separate operation linked to a terminal source operation. The server reads effective applied fields, including a later result refinement, and only rows with encrypted previous values and a full-task `mock:<mutationVersion>` after-version can be selected. The source must remain within one year, available under the active report policy, and unchanged by `stateVersion`. The source owner may use `view_own_reports`; another operator needs `view_all_reports`. Both need app access, bulk run, field change, restore, and current field scope. Ordinary report readers cannot obtain the protected data.

The user selects all or individual eligible source tasks through the server-provided list. The server decrypts previous values with the **source owner's** purpose-bound AAD, including the original operation, task, and before-version. It encrypts each task's target values for the new draft owner. The public draft contains only selected IDs, field IDs, the source after-version, and inert command metadata. Its preflight snapshot and API response contain statuses and counters but omit current and target values. A separate encrypted private preview is checked against the public snapshot and its fingerprint during confirmation and launch. No previous values are stored in public draft, preview, operation, report, or audit JSON.

Preflight compares the source full-task after-version with the current full-task mutation version before calculating changes. A mismatch is an initial `conflict` outcome, not an exclusion. A missing full-task version blocks the write. The consumer rechecks the full version before marking a task for writing; the local mock applies an atomic fenced compare-and-set. Any later ambiguous external result stays `unconfirmed` and is not applied again blindly. A confirmed restore records `restored` and encrypted before-values; a definitive restore failure records `restore_error`. Exact launch replay returns the same operation, while a new launch checks source state, retention, owner/access, field scope, draft revision, confirmation, and private preview in one transaction. The operation, initial outcomes, audit record, private execution plan, and durable Queue dispatch are committed together. A zero-write preview, including conflicts, completes synchronously without Queue dispatch.

The database's `eligible_count` includes preflight conflicts so initial conflict results and finalization remain consistent with persisted result counters. The preview's `eligible` count remains the tasks that can still be written. The operation progress display counts initial conflicts as already processed. Rollback removes pending restore drafts and confirmations before restoring prior result RPC behavior.

The persistent mock task state is local test infrastructure. It models a full-task version and atomic CAS across adapter instances; it does not establish that production Bitrix24 exposes an equivalent version. Production restore must refuse the write until an equally reliable full-task fence is available.

## Verification boundary

SQL, Worker, and UI tests are authored but not executed by the agent under repository instructions. Run `bun run check` and `bun run db:docker:test`. A real Bitrix24 smoke test remains open because no portal is available.
