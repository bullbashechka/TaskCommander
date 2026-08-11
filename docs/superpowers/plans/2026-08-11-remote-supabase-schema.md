# Remote Supabase Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the Task Commander schema to the authorized remote Supabase project, verify it, and record task 005 as complete without making Docker mandatory.

**Architecture:** SQL migrations remain portable source files. The current path applies the forward migration and reads the schema through Supabase MCP. Docker commands remain opt-in under explicit `db:docker:*` names for future open-source contributors.

**Tech Stack:** PostgreSQL 17, Supabase MCP, Supabase CLI 2.113.0, Bun workspace, pgTAP.

## Global Constraints

- Apply only `supabase/migrations/20260811000000_task_commander_schema.sql` as remote migration `task_commander_schema`.
- Do not use a PostgreSQL connection string, password, OAuth token, or service-role key in a command, file, test, or log.
- Do not run `supabase db reset`, seed data, down migrations, or pgTAP tests against the remote project.
- Do not run Docker in this implementation.
- Do not execute Bun test, check, build, lint, format-check, or runtime smoke commands; the user runs them.

---

### Task 1: Separate remote and optional Docker workflows

**Files:**

- Modify: `package.json:14-22`
- Modify: `backend/.dev.vars.example:5-11`
- Modify: `docs/local-development.md:28-56`
- Create: `docs/supabase-remote-development.md`

**Interfaces:**

- Consumes: the portable `supabase/` directory and runtime variables from `backend/src/runtime/configuration.ts`.
- Produces: explicit `db:docker:*` scripts, remote-development instructions using MCP, and a secrets-safe Worker template.

- [ ] **Step 1: Rename Docker-only package scripts**

Replace the five generic scripts with:

```json
"db:docker:start": "supabase start",
"db:docker:stop": "supabase stop",
"db:docker:reset": "supabase db reset --local",
"db:docker:test": "supabase test db --local",
"db:docker:lint": "supabase db lint --local"
```

- [ ] **Step 2: Update the local secret template**

Keep values blank and use this wording:

```text
# For a remote Supabase development project, use its HTTPS Project URL and service-role key.
# LOCAL_SUPABASE_ALLOWED_HOSTS accepts the exact remote project host, without a protocol.
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
LOCAL_SUPABASE_ALLOWED_HOSTS=
```

- [ ] **Step 3: Separate the documentation modes**

Document a default remote section: migrations are applied through authorized MCP; seed, reset, rollback tests and pgTAP do not run remotely. Document an optional Docker section using the five `db:docker:*` commands for future open-source contributors.

- [ ] **Step 4: Create a remote runbook**

Create `docs/supabase-remote-development.md` with the exact sequence:

```markdown
1. Verify the selected project in Supabase MCP.
2. Inspect remote migration history.
3. Apply only missing forward migrations from `supabase/migrations/`.
4. Inspect the deployed schema and RLS policies.
5. Mark the repository task complete only after steps 1-4 succeed.
```

State that direct connection strings and `db reset` are prohibited in this workflow.

- [ ] **Step 5: Review and commit the workflow split**

Run `git diff --check`. Expected: no whitespace errors, no secret values, and Docker commands only under `db:docker:*`. Commit with `Document remote Supabase development workflow`.

### Task 2: Apply the forward migration with Supabase MCP

**Files:**

- Reads: `supabase/migrations/20260811000000_task_commander_schema.sql`
- Reads: `docs/supabase-remote-development.md`

**Interfaces:**

- Consumes: the authenticated Supabase MCP connection and canonical migration SQL.
- Produces: migration `task_commander_schema` in remote history and the corresponding schema objects.

- [ ] **Step 1: Inspect migration history and schema**

Use MCP to list migration history and public-schema tables. Record whether migration `task_commander_schema` is absent or present. Do not execute SQL.

- [ ] **Step 2: Apply only the missing migration**

If absent, use the MCP migration operation on the exact repository file below. If present, do not replay its SQL.

```text
supabase/migrations/20260811000000_task_commander_schema.sql
```

- [ ] **Step 3: Confirm migration history**

Use MCP to read migration history again. Expected: `task_commander_schema` appears exactly once and no migration error is reported.

### Task 3: Verify the remote schema and complete task 005

**Files:**

- Reads: `supabase/tests/database/001_schema.test.sql`
- Reads: `supabase/tests/database/002_schema_rollback.test.sql`
- Modify: `TASKS.md:19`

**Interfaces:**

- Consumes: migrated remote schema and the repository schema-test contract.
- Produces: evidence of required tables, constraints, indexes, RLS policies and types; task 005 marked complete.

- [ ] **Step 1: Inspect required schema objects via MCP**

Confirm tables `portal`, `user_settings`, `saved_filter`, `operation_draft`, `bulk_operation`, `task_processing_result`, `protected_task_result`, `report`, `report_artifact`, and `audit_event`; RLS on each table; foreign keys from results and reports to operations; and the partial unique active-operation index.

- [ ] **Step 2: Inspect critical invariant definitions**

Confirm normalized unique filter names, one draft per user, operation/report status checks, report format checks, independent report/result ownership checks, and append-only audit triggers. Do not execute pgTAP remotely.

- [ ] **Step 3: Record successful completion**

Only after the previous checks succeed, change the task marker to:

```markdown
- [x] [005. Создать схему Supabase PostgreSQL и миграции](tasks/005-database-schema.md)
```

- [ ] **Step 4: Review and commit the completed task**

Run `git diff --check` and `git status --short`. Expected: only planned workflow/documentation and `TASKS.md` changes. Commit `Mark database schema task complete`.
