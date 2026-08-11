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

## Supabase: удаленный режим по умолчанию

Текущая разработка использует удаленный Supabase и не требует Docker. Миграции применяются только через авторизованный Supabase MCP по инструкции в [supabase-remote-development.md](supabase-remote-development.md). На удаленном проекте запрещено запускать seed, `db reset`, down-миграции и pgTAP-тесты.

Для будущей server-задачи скопируйте `backend/.dev.vars.example` в неотслеживаемый `backend/.dev.vars`, затем вручную внесите HTTPS Project URL, service-role key и точный hostname проекта. Эти значения не коммитятся и не передаются в браузер.

После реализации server-only слоя данных Worker требует `SUPABASE_URL` и
`SUPABASE_SERVICE_ROLE_KEY`. `LOCAL_SUPABASE_ALLOWED_HOSTS` содержит точный hostname
разрешённого development-проекта. Значения отсутствуют в `wrangler.jsonc`: там объявлены
только имена обязательных secret bindings.

Интеграционный тест `backend/test/data-access.integration.test.ts` запускается только если
в Worker runtime присутствуют оба Supabase secrets. Он создаёт изолированный синтетический
portal и удаляет свои данные после проверки. Для локального Docker-контура используйте:

```powershell
bun run db:docker:start
bun run db:docker:reset
bun run test:data:integration
```

Для Docker допустим только allowlisted loopback URL: `http://127.0.0.1:54321` либо
`http://localhost:54321`. Во всех остальных режимах Supabase URL использует HTTPS.

## Опциональная Docker-база Supabase

Docker-контур сохранен для будущих open-source контрибьюторов. Supabase CLI установлен как локальная development-зависимость. Все команды этого раздела работают только с локальными контейнерами и не используют `--linked`.

```powershell
bun run db:docker:start
bun run db:docker:reset
bun run db:docker:test
bun run db:docker:lint
```

`db:docker:reset` удаляет и заново создаёт только локальную базу Supabase, применяет миграции и затем development seed. `db:docker:test` запускает pgTAP-проверки из `supabase/tests/database`; каждая проверка выполняется в транзакции. `db:docker:lint` проверяет схему локальной базы. После работы остановите контейнеры командой `bun run db:docker:stop`.

Rollback-файлы в `supabase/tests/rollback` не являются production-миграциями. Они подключаются только в pgTAP-тесте и откатываются вместе с его транзакцией. Запрещено запускать их вручную на удаленной, staging или production базе.

## Секреты

Локальные значения хранятся только в `backend/.dev.vars`; файл не коммитится. Скопируйте `backend/.dev.vars.example` и заполните его только для нужной подсистемы.

Базовый runtime требует `APP_ENV=local` и `BITRIX_ADAPTER=mock`. Supabase считается не настроенным, пока не заданы одновременно `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` и `LOCAL_SUPABASE_ALLOWED_HOSTS`. Allowlist содержит точные host names development-проектов через запятую; URL, отсутствующий в allowlist, безопасно отмечается как некорректная конфигурация. Readiness API сообщает только состояние подсистем и никогда не возвращает имена либо значения секретов.

## Product boundary

Локальная страница является foundation shell, а не самостоятельным способом доступа к продукту. Проверка запуска из Битрикс24, OAuth и права доступа появятся в задачах 009–012 и 035.
