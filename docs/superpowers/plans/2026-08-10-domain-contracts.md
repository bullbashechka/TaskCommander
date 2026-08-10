# Domain Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** создать общие runtime-валидируемые доменные контракты и безопасные API-ошибки.

**Architecture:** публичные схемы находятся в `@task-commander/contracts`, внутренние Queue и protected-result схемы — в `backend`. Zod является единым источником runtime-валидации и TypeScript-типов.

**Tech Stack:** TypeScript, Zod, Hono, Vitest, Cloudflare Workers.

## Global Constraints

- Не передавать токены, stack trace, upstream payload и защищённые предыдущие значения в браузер, отчёты или API-ошибки.
- Использовать UTF-8, LF, два пробела и strict TypeScript.
- Не запускать проверки от имени агента: пользователь запускает `bun run --cwd packages/contracts test`, `bun run --cwd backend test`, `bun run typecheck`, `bun run lint`, `bun run format:check`.

---

### Task 1: Документация и решения

- [x] Зафиксировать design spec и план.
- [x] Обновить PRD для черновиков, результатов `no_change`/`partially_applied`, значимых конфликтов и исторических отчётов.
- [x] Уточнить зависимость задачи 003.

### Task 2: Публичные схемы

- [x] Добавить прямую зависимость Zod и синхронизировать lockfile.
- [x] Разделить контракты на primitives, identity, task-change, operations, errors и health.
- [x] Добавить строгие схемы и serialization-тесты.

### Task 3: API errors

- [x] Добавить correlation middleware, error factory и JSON validation helper.
- [x] Обновить local probe, not-found и unexpected-error обработчики.
- [x] Добавить Worker-тест некорректного запроса и correlation header.

### Task 4: Server-only Queue contracts

- [x] Добавить Queue envelope операции и protected result schema.
- [x] Перевести runtime probe на строгую Zod-схему.
- [x] Добавить schema-тесты Queue-сообщений.

### Task 5: Передача на проверку

- [ ] Проверить diff и отсутствие изменений в пользовательской отметке задачи 002.
- [ ] Пользователь запускает команды проверки из Global Constraints.
- [ ] После успешной проверки отметить задачу 003 выполненной и подготовить отдельный коммит.
