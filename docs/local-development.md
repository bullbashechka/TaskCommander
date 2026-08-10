# Локальная разработка

`bun run dev` запускает Vite с Cloudflare Vite plugin. Клиент и Worker исполняются локально на одном origin, поэтому для `/api/health` не нужен CORS или отдельный proxy.

Локальный контур состоит из API Worker и auxiliary consumer Worker. Они используют общие локальные Queue, DLQ и R2 через один Miniflare runtime. Удалённые Cloudflare bindings отключены; команды разработки не используют `--remote` и не требуют Cloudflare login.

## Режимы

- `bun run dev` — быстрый локальный режим с HMR и Worker runtime.
- `bun run build` — сборка клиентских assets и Worker.
- `bun run preview` — локальная проверка собранного Worker с assets и SPA fallback.
- `bun run dev:reset` — удаление только `.wrangler/state/task-commander-local` для чистого локального контура.

Worker направляет `/api/*` в Hono. Непосредственное открытие клиентского маршрута, например `/status?panel=api`, обслуживается SPA fallback.

## Локальные bindings

- API публикует технические probe-сообщения в `task-commander-local-operations-v1`.
- Consumer повторяет некорректные или временно не обработанные сообщения; после трёх попыток Queue помещает их в `task-commander-local-operations-dlq-v1`.
- R2 bucket `task-commander-local-reports-v1` является приватным и хранит только локальные технические объекты в ключах эпохи `v1`.
- Локальное состояние находится в `.wrangler/state/task-commander-local` и переживает перезапуск `bun run dev`. Worker-тесты используют отдельное ephemeral storage и не изменяют этот каталог.

Для smoke-проверки запустите `bun run dev`, затем отправьте `POST /api/_runtime/probe`. Маршрут доступен только при `APP_ENV=local`, создаёт только техническое сообщение и не выполняет бизнес-операцию. В терминале Vite должно появиться `runtime_probe_consumed` с тем же `messageId`, который вернул API: это подтверждает путь API Worker → local Queue → auxiliary consumer Worker → R2. Local Explorer по адресу `/cdn-cgi/local/explorer/api/local/workers` должен показывать оба Worker. Cron `*/5 * * * *` выполняет no-op scheduled probe: записывает техническое событие в лог без бизнес-эффекта.

Некорректное schemaVersion или kind не выполняет R2 side effect: consumer вызывает Queue retry, а конфигурация consumer ограничивает цепочку тремя попытками и направляет её в `task-commander-local-operations-dlq-v1`. Это поведение покрыто детерминированным Worker-тестом; полную redelivery-цепочку проверяйте в локальном dev runtime при изменении параметров Queue.

Остановите `bun run dev` перед `bun run dev:reset`: Miniflare удерживает state-каталог, пока запущен. Reset не принимает путь от пользователя и удаляет ровно указанный каталог state. Повторный вызов при отсутствии каталога — успешный no-op. Команда не удаляет `backend/.dev.vars`, весь `.wrangler`, соседние state-каталоги или файлы проекта.

## Секреты

Локальные значения хранятся только в `backend/.dev.vars`; файл не коммитится. Скопируйте `backend/.dev.vars.example` и заполните его только для нужной подсистемы.

Базовый runtime требует `APP_ENV=local` и `BITRIX_ADAPTER=mock`. Supabase считается не настроенным, пока не заданы одновременно `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` и `LOCAL_SUPABASE_ALLOWED_HOSTS`. Allowlist содержит точные host names development-проектов через запятую; URL, отсутствующий в allowlist, безопасно отмечается как некорректная конфигурация. Readiness API сообщает только состояние подсистем и никогда не возвращает имена либо значения секретов.

## Product boundary

Локальная страница является foundation shell, а не самостоятельным способом доступа к продукту. Проверка запуска из Битрикс24, OAuth и права доступа появятся в задачах 009–012 и 035.
