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
в Worker runtime присутствуют оба Supabase secrets отдельного development-проекта. Он создаёт
изолированный синтетический portal и удаляет свои данные после проверки. Supabase URL всегда
использует HTTPS.

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

Базовые runtime и cron требуют только local mock adapter. Identity readiness и session endpoints
дополнительно требуют оба независимых signing secrets.

Для задачи 009 локальный вход использует два разных secret bindings длиной не менее 32 UTF-8
байт: `MOCK_LAUNCH_SIGNING_SECRET` проверяет короткоживущий подписанный mock launch context,
а `SESSION_SIGNING_SECRET` подписывает cookie сессии. Скопируйте `backend/.dev.vars.example` в
`backend/.dev.vars` и задайте оба значения только локально. После изменения
`backend/wrangler.jsonc` требуется сгенерировать типы отдельной командой `bun run cf-typegen`;
сгенерированный `backend/worker-configuration.d.ts` вручную не редактируется.

Локальный API использует `POST`, `GET` и `DELETE /api/session`. Обычный `POST` принимает
подписанный mock launch context, заново читает текущего пользователя mock Bitrix24 и выдаёт
новую stateless HttpOnly cookie. Cookie ограничена `/api`, использует `Secure` и `SameSite=Lax`;
это политика локального mock-контура, а не утверждение о финальной cookie-политике embedded
iframe. Production OAuth, атрибуты cookie для реального iframe и защита межсайтового запуска
относятся к задаче 035. Cookie не содержит OAuth-токенов, разрешений или иных данных Bitrix24
помимо подписанных session claims.

Для быстрого локального запуска доступен endpoint `POST /api/_dev/session`. Он работает только при
`APP_ENV=local` и обращении через loopback-host (`localhost`, `*.localhost`, `127.*` или `::1`),
принимает строгий JSON с заранее разрешённым `userId` (`"1"` или `"10"`), сам создаёт
короткоживущий подписанный launch context и выдаёт ту же session cookie. Ответ всегда пустой
(`204`); launch context и значения signing secrets не покидают Worker. Вне local runtime или на
не-localhost адресе endpoint возвращает `404`.

После заполнения обоих secrets запустите `bun run dev` и откройте URL Vite через `localhost`.
На экране «Сессия завершена» в dev-режиме нажмите «Войти локально»: будет создана сессия
mock-администратора с `userId: "1"` и `portalId: "local-demo"`, которая не требует Supabase для
базового доступа к приложению. Пользователь `"10"` доступен для прямых API-тестов роли оператора;
его прикладовые права, как и у обычного пользователя, требуют настроенной Supabase. Session cookie
действует 15 минут, после чего локальный вход нужно повторить вручную. Production-сборка не
показывает эту кнопку.

Mock launch context является короткоживущим bearer token и может повторно использоваться в пределах TTL.
`nonce` служит только для уникальности и корреляции, не реализует атомарную защиту от replay.
Single-use state, CSRF и production-политика запуска откладываются до задачи 035; этот local mock
контур не создаёт для них storage, миграции или Durable Objects.

## Product boundary

Локальная страница является foundation shell, а не самостоятельным способом доступа к продукту. Задача 009 добавляет только signed mock launch context и защищённую локальную сессию. Production OAuth появится в задаче 035, а модель прикладных прав — в задачах 010–012.
