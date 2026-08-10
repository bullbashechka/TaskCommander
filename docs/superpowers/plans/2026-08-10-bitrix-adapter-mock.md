# Bitrix24 mock adapter implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` task-by-task.

**Goal:** implement a server-only Bitrix24 adapter contract, deterministic local mock and adapter factory.

**Architecture:** compose task, identity, organization, calendar, notification and Disk capabilities behind one `BitrixAdapter`; keep Bitrix REST representations inside future production code.

**Tech Stack:** TypeScript, Zod, Vitest, Cloudflare Workers and Bun.

## Constraints

- IDs are decimal strings and dates use ISO 8601 offsets.
- No OAuth, new HTTP endpoints, queue orchestration, retry scheduler or date-shift calculation.
- Unknown fields are visible to diagnostics but not editable.
- The mock supports 100,000 generated tasks with a mutable overlay and explicit fixtures.
- User-owned `TASKS.md` changes remain outside this implementation.

## Delivery order

1. Define strict adapter types and schemas.
2. Build generated mock tasks, live search and field capabilities.
3. Add preflight reads, safe changes and deterministic error scenarios.
4. Add users, organization and portal calendar capabilities.
5. Add idempotent notifications and Disk artifacts.
6. Compose the mock in a local-only factory and add reusable contract tests.

## Verification

The user runs `bun run format:check`, `bun run lint`, `bun run typecheck` and `bun run test` after implementation.
