# Repository Guidelines

## Operating Standard

- Answer in the user's language.
- Start from repository evidence rather than assumptions.
- Verify uncertain claims through code, contracts, tests, documentation, or runtime output.
- Preserve unrelated user changes. Do not revert, overwrite, reformat, or clean up work outside the requested scope.
- Prefer the lightest workflow that provides sufficient confidence.
- Ask for clarification only when ambiguity blocks a safe decision or materially changes product behavior.

## Project Structure & Module Organization

This is a Bun workspace monorepo. `webapp/` contains the React 19, Vite, and Tailwind frontend; application code lives in `webapp/src/`, with UI tests colocated beside components and utilities. `backend/` contains the Hono Cloudflare Worker, with runtime code in `backend/src/` and Worker tests in `backend/test/`. Shared TypeScript contracts live in `packages/contracts/src/`. Product requirements and technical decisions are maintained in `PRD.md`, `design.md`, `docs/`, and `tasks/`.

## Repository Grounding

- Read the relevant task file in `tasks/` before planning or implementing task-scoped work.
- Use `PRD.md` for product requirements, `TASKS.md` for sequencing and Definition of Done, and `design.md` for approved UI principles.
- Treat `docs/decisions/` as the source of truth for decisions already approved for completed or active tasks.
- Prefer current code, contracts, migrations, and tests over stale documentation. Report material documentation drift when found.
- Inspect the relevant `package.json` before choosing commands, libraries, or tooling.
- Prefer existing utilities, dependencies, patterns, and framework APIs before introducing new ones.
- Do not add dependencies without explicit user approval unless the user requested that dependency by name.

## Build, Test, and Development Commands

- `bun install --frozen-lockfile`: install exactly the locked dependencies.
- `bun run dev`: start Vite and the local Cloudflare runtime.
- `bun run build`: build all workspace packages.
- `bun run preview`: serve the built application locally.
- `bun run test`: run all Vitest suites.
- `bun run typecheck`: run strict TypeScript checks.
- `bun run lint`: run ESLint across the repository.
- `bun run format:check`: verify Prettier formatting.
- `bun run check`: run formatting, linting, type checks, and tests.
- `bun run cf-typegen`: regenerate `backend/worker-configuration.d.ts` after changing Worker bindings.

## Coding Style & Naming Conventions

Use UTF-8, LF line endings, a final newline, and two-space indentation. Prettier enforces single quotes, trailing commas, and a 100-character print width. TypeScript is strict; avoid `any`, unused declarations, unchecked indexed access, and handwritten Cloudflare binding types. Use lowercase kebab-case filenames such as `runtime-table.tsx`. Keep modules focused and place shared API shapes in `packages/contracts/`.

## Testing Guidelines

Vitest is used throughout. Name tests `*.test.ts` or `*.test.tsx`. Frontend tests use jsdom and Testing Library; backend tests use the Cloudflare Workers pool. Add tests for changed behavior and failure paths. No numeric coverage threshold is enforced. Before requesting review, instruct the user to run `bun run check` and report any checks that remain unverified.

The user runs tests and verification commands. Do not execute `bun run test`, `bun run check`, builds, linting, formatting checks, or local runtime smoke tests unless the user explicitly requests their execution. State the exact commands required for verification instead.

Use Playwright for web E2E tests when E2E coverage is introduced. Add or expand E2E coverage only for stable, important user-visible flows such as authentication, permissions, persistence, navigation, validation, and error or recovery states. Do not use E2E tests for cosmetic styling details.

## Task Workflow

Do not implement or modify project files without an explicit implementation command from the user.
Requests to inspect, discuss, analyze, review, or plan a task authorize read-only work only.

Design work starts with task 11. When task 11 is reached or requested, remind the user that the design phase begins at this task before proceeding.

Design work is expected in the following tasks:

- 011: access management and allowed-fields interface.
- 013: application shell, navigation, and shared UI states.
- 015: filter builder, sorting, and saved-filter flows.
- 016: task table, pagination, and selection states.
- 017: bulk-change editor and dynamic field forms.
- 020: preflight preview, exclusions, warnings, and confirmation flow.
- 023: operation progress, cancellation, and interruption states.
- 024: retry flow through renewed validation, preview, and confirmation.
- 025: task selection and preview flow for restoring previous values.
- 028: operation history, report details, actions, and archive interface.
- 030: read-only audit journal interface.
- 034: UX accessibility, empty/error/offline states, and desktop-browser compatibility review and refinement.

Task 11 approval gate: do not perform, start, plan, prepare, or modify anything related to task 11 without the user's explicit prior consent. Merely reaching or mentioning task 11 is not consent. Stop and wait for explicit authorization before taking any action.

## Code Discovery

- When code discovery is needed, keep the main process focused on decisions and implementation; delegate broad repository search to a Codex 5.3 Spark subagent when available. If Spark is not available, use Luna or `gpt-5.6-terra` with low reasoning effort.
- The subagent must return a compact evidence map only: `path:line`, symbol/component/route name, the relevant code snippet or signature, and why it matters for the main task.
- The main process should use that map for targeted reading and implementation, verifying critical findings before editing.

## Research & Implementation Discipline

- For non-trivial behavior, inspect the complete affected path before editing.
- Frontend path: route or bootstrap -> page or feature -> handler or API client -> shared contract -> backend route -> persistence or external integration.
- Backend path: request boundary -> validation -> session and authorization -> application logic -> repository or integration -> serializer -> response.
- Async path: trigger -> queue -> consumer -> retry or idempotency -> side effect -> operation status and error visibility.
- Identify the owning layer and fix the cause there instead of adding downstream compensation.
- Treat one-file fixes for cross-layer behavior as suspicious until the surrounding flow has been checked.
- Prefer the smallest coherent change. Do not introduce abstractions, helpers, wrappers, or folders unless they remove current complexity.
- Prefer clear local code over premature reuse or framework-like architecture.

## Change-Surface Triggers

- When changing shared contracts, inspect producers, consumers, validation, serialization, and tests on both frontend and backend.
- When changing routes or navigation, inspect guards, session bootstrap, access policy, redirects, and user-visible error states.
- When changing Supabase schemas or persistence behavior, inspect migrations, rollback migrations, generated database types, repositories, and database tests.
- When changing authentication or permissions, inspect both backend enforcement and frontend visibility. Frontend restrictions must never replace backend authorization.
- When changing queue or operation behavior, inspect retries, idempotency, ordering, cancellation, interruption recovery, and failure visibility.
- When changing Bitrix24 integration behavior, inspect the adapter contract, mock implementation, production boundary, and contract tests.
- For affected UI flows, consider loading, empty, error, offline, disabled, success, retry, and stale-access states where applicable.

## Documentation & Completion

- Update documentation when a change materially affects architecture, setup, contracts, security rules, operations, or approved product behavior.
- Record durable task-specific decisions in `docs/decisions/`, not in `AGENTS.md`.
- Avoid documentation churn for formatting changes or self-evident implementation details.
- In the completion report, state what changed, why it changed, what remains unverified, and the exact commands the user should run.
- Include affected layers, migrations, configuration changes, rollout risks, or documentation impact when relevant.
- Do not declare a task complete while its primary user-visible or contract-level behavior is known to be broken.

## Commit & Pull Request Guidelines

Use short, imperative, sentence-style English commit subjects, matching history: `Document Bun and Cloudflare Vite plugin development setup`. Keep commits scoped to one logical change. Pull requests should explain purpose, summarize implementation, link the relevant task or issue, and list verification performed. Include screenshots for visible UI changes and call out configuration or migration impacts.

## Security & Configuration Tips

Never read `.env` or `.dev.vars` files.

Store local secrets only in `.dev.vars`; update `.dev.vars.example` with names, never real values. Do not expose Supabase or Bitrix24 credentials in browser bundles, API responses, logs, reports, tests, or snapshots. Keep `.env*`, `.dev.vars`, `.wrangler/`, build output, and coverage artifacts untracked.

- Do not manually edit generated files such as `backend/worker-configuration.d.ts` or generated Supabase database types. Update their source and use the appropriate generator.
- Do not stage, commit, amend, rebase, reset, stash, push, create branches, or delete files unless explicitly requested.
- Do not weaken authentication, authorization, validation, rate limits, auditability, or secret handling to simplify implementation.
- Keep diffs focused and avoid unrelated formatting changes.
- Do not expose secrets or sensitive Bitrix24 data in fixtures, logs, screenshots, snapshots, reports, or final responses.
