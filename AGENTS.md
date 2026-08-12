# Repository Guidelines

## Project Structure & Module Organization

This is a Bun workspace monorepo. `webapp/` contains the React 19, Vite, and Tailwind frontend; application code lives in `webapp/src/`, with UI tests colocated beside components and utilities. `backend/` contains the Hono Cloudflare Worker, with runtime code in `backend/src/` and Worker tests in `backend/test/`. Shared TypeScript contracts live in `packages/contracts/src/`. Product requirements and technical decisions are maintained in `PRD.md`, `design.md`, `docs/`, and `tasks/`.

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

Vitest is used throughout. Name tests `*.test.ts` or `*.test.tsx`. Frontend tests use jsdom and Testing Library; backend tests use the Cloudflare Workers pool. Add tests for changed behavior and failure paths. No numeric coverage threshold is enforced. Run `bun run check` before requesting review.

The user runs tests and verification commands. Do not execute `bun run test`, `bun run check`, builds, linting, formatting checks, or local runtime smoke tests unless the user explicitly requests their execution. State the exact commands required for verification instead.

## Task Workflow

Do not implement or modify project files without an explicit implementation command from the user.
Requests to inspect, discuss, analyze, review, or plan a task authorize read-only work only.

Design work starts with task 11. When task 11 is reached or requested, remind the user that the design phase begins at this task before proceeding.

Task 11 approval gate: do not perform, start, plan, prepare, or modify anything related to task 11 without the user's explicit prior consent. Merely reaching or mentioning task 11 is not consent. Stop and wait for explicit authorization before taking any action.

## Commit & Pull Request Guidelines

Use short, imperative, sentence-style English commit subjects, matching history: `Document Bun and Cloudflare Vite plugin development setup`. Keep commits scoped to one logical change. Pull requests should explain purpose, summarize implementation, link the relevant task or issue, and list verification performed. Include screenshots for visible UI changes and call out configuration or migration impacts.

## Security & Configuration Tips

Store local secrets only in `.dev.vars`; update `.dev.vars.example` with names, never real values. Do not expose Supabase or Bitrix24 credentials in browser bundles, API responses, logs, reports, tests, or snapshots. Keep `.env*`, `.dev.vars`, `.wrangler/`, build output, and coverage artifacts untracked.
