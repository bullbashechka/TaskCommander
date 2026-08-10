# Bitrix24 mock adapter design

## Goal

Task 004 introduces a server-only `BitrixAdapter` contract and a deterministic local mock for tasks, users, company structure, calendar, notifications and Disk. The same service code must later work with an OAuth implementation without importing REST method names or payloads.

## Product decisions

- Working-day shifts use the portal-wide production calendar and the portal time zone; local task time is preserved.
- A task that is deleted or has become inaccessible is reported as `not_found_or_forbidden` without disclosing which condition occurred.
- An ambiguous write is reconciled by rereading the task. Automatic completion and rollback are prohibited; mixed results become `partially_applied`.
- Rate limits pause future orchestration. The adapter only classifies the limit and exposes retry metadata.
- Search is live. Selection is by ID and the later selection flow freezes the exact selected IDs before preflight.
- Disk and notification delivery are independent from task-change outcomes.
- A parent deadline controlled by subtasks is not directly changed. The preview later excludes it with a warning.
- New fields are discovered dynamically, but only supported normalized kinds are editable.
- Native Bitrix task notifications remain enabled. The later preview reports potentially affected participants.
- Exactly one XLSX and one CSV are stored per operation. Retry returns the existing artifact.
- A completion notification links to the Task Commander operation page, not directly to a Disk file.
- A department manager is an active user explicitly assigned as a Bitrix department head. Losing the final leadership role revokes only the later `manage_access` permission.

## Architecture

`BitrixAdapter` composes six capabilities: `tasks`, `users`, `organization`, `calendar`, `notifications` and `disk`. All adapter types are server-only. Public Zod contracts remain the only source of browser-safe data.

The mock has a seed-based task catalog of 100,000 tasks, explicit edge-case fixtures and a small mutable overlay. It has no persistent array of full generated task objects. A declarative scenario engine mutates state or returns failures on a selected method invocation.

## Safety

Expected upstream conditions are normalized into typed failures. Raw HTTP payloads, technical codes, tokens and stack traces remain inside the future OAuth implementation and protected diagnostics. The adapter accepts a task snapshot version derived from only the fields and rights relevant to the requested change.

## Scope boundary

This task supplies contracts, the local mock, factory and tests. OAuth calls, API routes, queue retries, date-shift calculation, reports and access-management business services remain later tasks.
