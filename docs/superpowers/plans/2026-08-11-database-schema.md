# Task Commander Supabase schema implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** create a reproducible Supabase PostgreSQL schema for Task Commander operations, task results, protected restoration data, reports, audit, drafts and personal filters.

**Architecture:** use one forward-only SQL migration for the initial schema, with relational tables and database-enforced invariants for ownership, lifecycle and history. Keep dynamic Bitrix24 structures as bounded JSONB snapshots validated by shared contracts; retain only encrypted restoration payloads outside ordinary operation results. Use Supabase CLI with pgTAP tests and a rollback fixture that is executed only inside a test transaction.

**Tech Stack:** PostgreSQL 15+, Supabase CLI, pgTAP, SQL migrations, Bun, TypeScript, Zod, Vitest.

## Global Constraints

- Use UTF-8, LF, a final newline, two-space TypeScript indentation, single quotes and 100-character Prettier width.
- Add no browser Supabase client, Supabase Auth, Storage or Edge Functions.
- Service-role credentials remain in `backend/.dev.vars`; commits must never contain real portals, users, tasks, URLs, tokens or protected values.
- SQL uses lowercase `snake_case`; Bitrix IDs remain decimal strings, not JavaScript numbers.
- PostgreSQL timestamps use `timestamptz`; public contracts use ISO 8601 offsets.
- Dynamic filter, preview and command payloads are validated with Zod before persistence; they are not decomposed into per-field SQL tables.
- Previous values are encrypted in Workers before writing `protected_task_result`; SQL must never contain plaintext restoration values.
- Production migrations are forward-only. The rollback SQL is test-only and must never be run against a linked, staging or production database.
- Do not run `bun run test`, `bun run check`, builds, lint, formatting checks or runtime smoke checks. The user runs the exact verification commands listed below.
- Preserve unrelated working-tree changes. Do not mark task 005 complete in `TASKS.md` until the user has run and accepted verification.

## Planned File Structure

- Modify: `package.json` — add local Supabase CLI scripts and a locked dev dependency.
- Modify: `bun.lock` — record the CLI dependency resolved by Bun.
- Modify: `.gitignore` — ignore only Supabase CLI local state directories.
- Modify: `backend/.dev.vars.example` — document safe local Supabase endpoint configuration without values.
- Modify: `docs/local-development.md` — document local database start/reset/test/rollback workflow and Docker prerequisite.
- Modify: `packages/contracts/src/operations.ts` — expose agreed operation and artifact lifecycle codes used by database and future API.
- Modify: `packages/contracts/src/index.test.ts` — prove the extended public contract accepts only agreed states.
- Create: `supabase/config.toml` — committed local CLI configuration with no project reference or secrets.
- Create: `supabase/migrations/20260811000000_task_commander_schema.sql` — forward-only initial schema, constraints, indices and non-sensitive helpers.
- Create: `supabase/seed.sql` — deterministic synthetic development portal, users, filters, draft, operation, results and report metadata.
- Create: `supabase/tests/rollback/20260811000000_task_commander_schema.down.sql` — test-only reverse DDL in dependency order.
- Create: `supabase/tests/database/001_schema.test.sql` — pgTAP schema, constraints, seed and index tests.
- Create: `supabase/tests/database/002_schema_rollback.test.sql` — pgTAP test proving reverse DDL removes all objects inside a transaction.
- Modify: `docs/superpowers/specs/2026-08-11-database-schema-design.md` — record final CLI and test-file names if implementation requires a non-product clarification.

---

### Task 1: Align public lifecycle contracts

**Files:**

- Modify: `packages/contracts/src/operations.ts`
- Modify: `packages/contracts/src/index.test.ts`

**Interfaces:**

- Produces: `operationStatusSchema` accepting `launching`, `running`, `completed`, `completed_with_errors`, `cancelled`, `interrupted`, `launch_failed`.
- Produces: `reportArtifactStatusSchema` accepting `pending`, `generating`, `awaiting_upload`, `ready`, `failed`, `unavailable`.
- Consumed by: migration checks in Task 3 and future repositories in task 006.

- [ ] **Step 1: Extend the contract test with the missing approved statuses.**

  Replace the expected operation statuses with:

  ```ts
  const operationStatuses = [
    'launching',
    'running',
    'completed',
    'completed_with_errors',
    'cancelled',
    'interrupted',
    'launch_failed',
  ];
  ```

  Add assertions that `reportArtifactStatusSchema` accepts all six artifact states and rejects
  `uploading_forever`.

- [ ] **Step 2: Record the required test command without running it.**

  Required user verification:

  ```powershell
  bun run --cwd packages/contracts test
  ```

  Expected result after implementation: all contract tests pass and `queued` plus
  `uploading_forever` remain invalid public codes.

- [ ] **Step 3: Update the Zod enums and public types.**

  Use stable machine codes only:

  ```ts
  export const operationStatusSchema = z.enum([
    'launching',
    'running',
    'completed',
    'completed_with_errors',
    'cancelled',
    'interrupted',
    'launch_failed',
  ]);

  export const reportArtifactStatusSchema = z.enum([
    'pending',
    'generating',
    'awaiting_upload',
    'ready',
    'failed',
    'unavailable',
  ]);
  ```

  Keep `cancel_requested_at` and `last_progress_at` internal to the database model. Do not add
  temporary UI states such as `cancelling` or `temporarily_waiting` to this public enum.

- [ ] **Step 4: Record the passing verification command and commit.**

  ```powershell
  bun run --cwd packages/contracts test
  git add packages/contracts/src/operations.ts packages/contracts/src/index.test.ts
  git commit -m "Align operation lifecycle contracts"
  ```

### Task 2: Add reproducible Supabase CLI tooling

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `.gitignore`
- Create: `supabase/config.toml`
- Modify: `backend/.dev.vars.example`
- Modify: `docs/local-development.md`

**Interfaces:**

- Produces: project-local `supabase` executable available to package scripts.
- Produces: `db:start`, `db:stop`, `db:reset`, `db:test`, `db:lint` scripts that always target the local stack.
- Consumed by: Tasks 3–5 and user verification.

- [ ] **Step 1: Add the expected local commands to `package.json`.**

  Add scripts that pass `--local` explicitly where the CLI supports it:

  ```json
  "db:start": "supabase start",
  "db:stop": "supabase stop",
  "db:reset": "supabase db reset --local",
  "db:test": "supabase test db --local",
  "db:lint": "supabase db lint --local"
  ```

  Add the official `supabase` CLI as a root development dependency using Bun so its exact
  resolved version is recorded in `bun.lock`. Do not install it globally.

- [ ] **Step 2: Add a safe local Supabase configuration.**

  Create `supabase/config.toml` with no `project_id`, credentials, OAuth configuration or
  production URLs. Retain CLI defaults unless a local port conflicts with existing project
  tooling. Add `supabase/.temp/` and `supabase/.branches/` to `.gitignore`; keep migrations,
  tests, seed and config tracked.

- [ ] **Step 3: Document the local database boundary.**

  Add the following workflow to `docs/local-development.md`:

  ```powershell
  bun run db:start
  bun run db:reset
  bun run db:test
  bun run db:lint
  ```

  State that Docker is required; all commands use local containers; `db:reset` is destructive
  only to the local Supabase database; `--linked` and production secrets are prohibited in this
  workflow. Keep `backend/.dev.vars.example` value-free and clarify that Worker integration is
  not added by this task.

- [ ] **Step 4: Record user verification and commit.**

  ```powershell
  bun install --frozen-lockfile
  bun run db:start
  bun run db:reset
  bun run db:lint
  git add package.json bun.lock .gitignore supabase/config.toml backend/.dev.vars.example docs/local-development.md
  git commit -m "Add local Supabase database tooling"
  ```

### Task 3: Create the forward-only core schema migration

**Files:**

- Create: `supabase/migrations/20260811000000_task_commander_schema.sql`

**Interfaces:**

- Consumes: lifecycle codes from Task 1.
- Produces: tables `portal`, `user_settings`, `saved_filter`, `operation_draft`, `bulk_operation`, `task_processing_result`, `protected_task_result`, `report`, `report_artifact`, `audit_event`.
- Produces: database checks and indices consumed by task 006 repositories, task 007 audit service, task 008 state machine, and tasks 024–031.

- [ ] **Step 1: Write pgTAP assertions for the core shape before migration code.**

  In `supabase/tests/database/001_schema.test.sql`, begin with assertions for all ten tables,
  the active-operation partial index, the one-result-per-task unique key and the one-artifact-
  per-format unique key:

  ```sql
  begin;
  select plan(14);
  select has_table('public', 'bulk_operation', 'bulk operation table exists');
  select has_table('public', 'protected_task_result', 'protected result table exists');
  select has_index('public', 'bulk_operation', 'bulk_operation_one_active_per_initiator');
  select has_index('public', 'task_processing_result', 'task_processing_result_operation_task_key');
  select has_index('public', 'report_artifact', 'report_artifact_report_format_key');
  ```

  Finish each pgTAP file with `select * from finish();` and `rollback;`.

- [ ] **Step 2: Record the expected pre-implementation database test command without running it.**

  ```powershell
  bun run db:test
  ```

  Expected result before the migration exists: pgTAP reports missing tables or index failures.

- [ ] **Step 3: Implement ownership, preferences, drafts and filters.**

  Create `portal` as the root scope. Use `portal_id` on every user-owned, operational and
  audit table. Define `user_settings` with composite primary key `(portal_id, user_id)`, current
  display name, `access_active`, `permissions text[]`, `allowed_field_ids text[]`, grant data
  and timestamps.

  Define `saved_filter` with UUID primary key, `(portal_id, owner_id)` foreign key,
  `name`, generated `normalized_name` as `lower(btrim(name))`, integer `revision`, bounded
  `filter_payload jsonb` and timestamps. Add the unique key
  `(portal_id, owner_id, normalized_name)`.

  Define `operation_draft` with UUID primary key, `(portal_id, owner_id)` foreign key and a
  unique key on those columns, `revision`, `preparing|awaiting_confirmation` status,
  `filter_snapshot jsonb`, `sort_snapshot jsonb`, `selected_task_ids text[]`,
  `changes jsonb`, `preflight_snapshot jsonb`, `expires_at` and timestamps. Add checks for
  1–1,000 selected IDs, positive revision and positive JSON array lengths where arrays are
  present. Do not put `now()` inside a unique index predicate; expiry is validated in SQL
  operations and cleanup, while the physical one-row key prevents races.

- [ ] **Step 4: Implement immutable operations and individual task outcomes.**

  Define `bulk_operation` with UUID primary key, portal scope, type, main lifecycle status,
  initiator ID and historical display name, immutable idempotency key, immutable snapshots,
  `source_operation_id`, cancellation/interruption metadata, timestamps and nonnegative
  counters. Enforce:

  ```sql
  check (
    (operation_type = 'bulk_change' and source_operation_id is null)
    or (operation_type in ('retry', 'restore') and source_operation_id is not null)
  )
  ```

  Use a composite foreign key `(portal_id, source_operation_id)` to an additional unique key
  `(portal_id, id)`, and a `check (source_operation_id is distinct from id)`. Add unique
  `portal_id + initiator_id + idempotency_key` and the partial unique index:

  ```sql
  create unique index bulk_operation_one_active_per_initiator
    on public.bulk_operation (portal_id, initiator_id)
    where status in ('launching', 'running');
  ```

  Define `task_processing_result` with a unique `(operation_id, task_id)` key, nullable task
  title and URL, outcome, requested/applied/failed field-ID arrays, safe reason fields,
  correlation ID and `can_retry`. Define `protected_task_result` as a one-to-one child keyed by
  `task_processing_result_id`, with ciphertext, nonce, key version, payload version and before/
  after versions; it must have no JSON plaintext-values column.

- [ ] **Step 5: Implement report and audit storage.**

  Define one `report` per operation, storage state `active`, `archived` or
  `archived_pending_artifact`, one-year `active_until`, archive timestamp and two-year
  `delete_after`. Define two possible `report_artifact` rows per report with
  `xlsx|csv`, independent artifact status, Bitrix Disk identifiers/path, temporary R2 key,
  attempt count, safe error code and timestamps. Enforce one row per `report_id + format`.

  Define `audit_event` with UUID primary key, portal scope, timestamp, action code, actor ID
  plus historical name, object type and ID, outcome, correlation ID and bounded safe metadata
  JSON. Do not add delete cascades from portal, user, operation or report into audit.

- [ ] **Step 6: Add automatic timestamp and immutability helpers.**

  Create a narrowly scoped `set_updated_at()` trigger function for mutable preference, filter,
  draft, operation, report and artifact rows. Create trigger functions that reject changes to:

  - `bulk_operation.operation_type`, `portal_id`, initiator fields, idempotency key, snapshots
    and source operation after insertion;
  - `task_processing_result` task identity after insertion;
  - `audit_event` updates and deletes for ordinary roles.

  The dedicated audit retention procedure is deferred to task 007/031; do not grant a broad
  bypass from the initial migration.

- [ ] **Step 7: Add query indices.**

  Create named indices for user history `(portal_id, initiator_id, created_at desc)`, all
  history `(portal_id, created_at desc)`, operation type/status filters, results
  `(operation_id, outcome)`, report retention state and dates, draft expiry, saved filters and
  audit by time, actor, action and object. Avoid standalone indexes on low-selectivity status
  columns.

- [ ] **Step 8: Record user verification and commit.**

  ```powershell
  bun run db:reset
  bun run db:test
  bun run db:lint
  git add supabase/migrations/20260811000000_task_commander_schema.sql supabase/tests/database/001_schema.test.sql
  git commit -m "Create Task Commander database schema"
  ```

### Task 4: Add synthetic seed data and lifecycle constraint tests

**Files:**

- Create: `supabase/seed.sql`
- Modify: `supabase/tests/database/001_schema.test.sql`

**Interfaces:**

- Consumes: the complete schema from Task 3.
- Produces: deterministic development data without production identifiers or protected plaintext.
- Produces: regression tests for constraints required by task 005 acceptance criteria.

- [ ] **Step 1: Add failing pgTAP assertions for invalid lifecycle writes.**

  Add `throws_ok` cases proving that the database rejects: a duplicate normalized filter name,
  a second draft for one user, a second `running` operation for one initiator, an orphaned task
  result, an invalid `launching` status, duplicate `(operation_id, task_id)`, and duplicate
  `(report_id, format)`. Add `lives_ok` cases proving that two different initiators can each
  have one active operation and XLSX failure does not block a ready CSV row.

  Example active-operation assertion:

  ```sql
  select throws_ok(
    $$insert into public.bulk_operation (...) values (..., 'running', ...);$$,
    '23505',
    '.*bulk_operation_one_active_per_initiator.*',
    'second active operation is rejected'
  );
  ```

- [ ] **Step 2: Record the expected test command without running it.**

  ```powershell
  bun run db:test
  ```

  Expected result before seed and assertions are complete: pgTAP fails on missing fixtures or
  insufficient plan count.

- [ ] **Step 3: Create an idempotent synthetic seed.**

  Use `insert ... on conflict ... do update` only for the synthetic portal and users needed for
  repeatable local resets. Use clearly fake values such as portal `local-demo`, users `1001` and
  `1002`, task IDs `5001` and `5002`, and names `Тестовый оператор` and `Тестовый администратор`.
  Seed one personal filter, one non-expired draft, one completed operation with two safe task
  outcomes, one report and two artifact records. Do not seed `protected_task_result`, external
  URLs, R2 values, real names, emails or secrets.

- [ ] **Step 4: Complete lifecycle and index assertions.**

  Assert seed visibility, safe `NULL` task title for inaccessible tasks, successful filter/draft
  ownership, and required index names. For retention behaviour, test the durable state fields:
  a report can be `archived_pending_artifact` with no ready artifact, and an archived report
  can have one ready and one `unavailable` artifact. Do not implement Cron deletion in this
  task; task 031 will execute those transitions.

- [ ] **Step 5: Record user verification and commit.**

  ```powershell
  bun run db:reset
  bun run db:test
  git add supabase/seed.sql supabase/tests/database/001_schema.test.sql
  git commit -m "Add database seed and constraint tests"
  ```

### Task 5: Prove test-only rollback and document safe verification

**Files:**

- Create: `supabase/tests/rollback/20260811000000_task_commander_schema.down.sql`
- Create: `supabase/tests/database/002_schema_rollback.test.sql`
- Modify: `docs/local-development.md`

**Interfaces:**

- Consumes: all objects created by Task 3.
- Produces: a rollback proof that cannot persistently alter the local schema because pgTAP wraps
  the test in a transaction.
- Produces: exact user-run verification commands.

- [ ] **Step 1: Write the rollback pgTAP test first.**

  Create a test that imports the rollback SQL with a relative `\ir` path, then asserts every
  Task Commander table and helper trigger function no longer exists:

  ```sql
  begin;
  select plan(12);
  \ir ../rollback/20260811000000_task_commander_schema.down.sql
  select hasnt_table('public', 'portal', 'portal is removed by rollback');
  select hasnt_table('public', 'audit_event', 'audit event is removed by rollback');
  select hasnt_function('public', 'set_updated_at', 'timestamp helper is removed by rollback');
  select * from finish();
  rollback;
  ```

  Include every table, trigger and helper created by the migration in the plan count. Do not drop
  shared Supabase schemas or extensions from the rollback fixture.

- [ ] **Step 2: Record the expected failing command without running it.**

  ```powershell
  bun run db:test
  ```

  Expected result before the reverse DDL exists: `002_schema_rollback.test.sql` fails to include
  the rollback file.

- [ ] **Step 3: Implement reverse DDL in dependency order.**

  Drop application triggers first, then child tables, parent tables, partial indexes and helper
  functions. Use `drop ... if exists` only for objects owned by Task Commander, explicitly named
  in the forward migration. Never drop the `extensions` schema, Supabase Auth objects, generic
  PostgreSQL functions, roles or user-owned tables.

- [ ] **Step 4: Add safe verification documentation.**

  Extend the local-development documentation with:

  ```powershell
  bun run db:start
  bun run db:reset
  bun run db:test
  bun run db:lint
  bun run format:check
  bun run lint
  bun run typecheck
  bun run test
  ```

  State that `002_schema_rollback.test.sql` runs reverse DDL inside a rolled-back pgTAP
  transaction. The rollback fixture is not a production command and must not be copied into a
  linked Supabase workflow.

- [ ] **Step 5: Record user verification and commit.**

  ```powershell
  bun run db:reset
  bun run db:test
  bun run db:lint
  git add supabase/tests/rollback/20260811000000_task_commander_schema.down.sql supabase/tests/database/002_schema_rollback.test.sql docs/local-development.md
  git commit -m "Test database schema rollback"
  ```

### Task 6: Final integration review and delivery record

**Files:**

- Modify: `docs/superpowers/specs/2026-08-11-database-schema-design.md`
- Modify: `TASKS.md` only after the user confirms all verification passed.

**Interfaces:**

- Consumes: committed schema, tests, seed and CLI setup from Tasks 1–5.
- Produces: verified implementation record and task status only after external verification evidence.

- [ ] **Step 1: Compare implementation against the accepted schema design.**

  Confirm every design entity has a migration table; every product decision maps to a constraint,
  lifecycle field, retention state or test; no protected previous value exists in seed, report,
  audit or public contract; and no code gives the browser a Supabase credential.

- [ ] **Step 2: Inspect the final diff for scope and formatting defects.**

  ```powershell
  git diff --check HEAD~1..HEAD
  git status --short
  ```

  Required outcome: only task-005 files and accepted documentation changes are present; no
  ignored secret or local-state file is staged.

- [ ] **Step 3: Request user-run verification evidence.**

  The user runs:

  ```powershell
  bun install --frozen-lockfile
  bun run db:start
  bun run db:reset
  bun run db:test
  bun run db:lint
  bun run format:check
  bun run lint
  bun run typecheck
  bun run test
  ```

  If any command fails, retain task 005 as open and address the reported failure in a new scoped
  change. Do not change `TASKS.md` based on an unrun command.

- [ ] **Step 4: Mark the task complete only after user verification.**

  Change the first unchecked task line in `TASKS.md` from `- [ ]` to `- [x]` only after the user
  provides successful verification results. Commit that status change separately:

  ```powershell
  git add TASKS.md
  git commit -m "Mark database schema task complete"
  ```

## Self-Review

### Spec coverage

- Product decisions for one draft, 24-hour extension, stale filter blocking, historical names,
  one-operation restore, deactivation cleanup, safe errors and artifact retention map to Tasks
  3–5.
- The hybrid relational/JSONB model, portal scope, encryption envelope and server-only boundary
  map to Task 3.
- Versioned migrations, synthetic seed, schema constraints, history/progress/audit indices and
  test-only rollback map to Tasks 2–5.
- Contract drift for launch and artifact states maps to Task 1.
- The user-only verification and deferred `TASKS.md` update map to Task 6.

### Placeholder scan

The plan contains no unresolved implementation placeholders. Files, status codes, table names,
constraints, test locations, commands and commit subjects are explicit.

### Type consistency

`bulk_operation.status` uses the Task 1 contract codes. `report_artifact.status` uses the Task
1 artifact codes. `protected_task_result` is consistently a one-to-one child of
`task_processing_result`; public contracts never expose its encrypted content.
