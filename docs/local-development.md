# Локальная разработка

`bun run dev` запускает Vite с Cloudflare Vite plugin. Клиент и Worker исполняются локально на одном origin, поэтому для `/api/health` не нужен CORS или отдельный proxy.

## Режимы

- `bun run dev` — быстрый локальный режим с HMR и Worker runtime.
- `bun run build` — сборка клиентских assets и Worker.
- `bun run preview` — локальная проверка собранного Worker с assets и SPA fallback.

Worker направляет `/api/*` в Hono. Непосредственное открытие клиентского маршрута, например `/status?panel=api`, обслуживается SPA fallback.

## Секреты

Задача 001 не использует секреты. Когда они появятся, локальные значения хранятся только в `.dev.vars`; файл не коммитится. Шаблон `.dev.vars.example` не содержит значений.

## Product boundary

Локальная страница является foundation shell, а не самостоятельным способом доступа к продукту. Проверка запуска из Битрикс24, OAuth и права доступа появятся в задачах 009–012 и 035.
