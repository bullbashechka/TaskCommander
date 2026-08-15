# Углублённый аудит безопасности backend и frontend

Дата аудита: **2026-08-15**  
Статус: **рабочий реестр исправлений**  
Основной срез: задачи **001–012**, отмеченные выполненными в `TASKS.md`  
Дополнительный срез: существующий frontend задачи 013, которая ещё не отмечена выполненной

## Резюме

- Итоговая оценка безопасности реализованного среза: **6/10**.
- Готовность к первому non-local/production развёртыванию: **3/10**. Низкая оценка здесь
  учитывает открытые security gates и то, что production OAuth/deployment относятся к ещё не
  выполненной задаче 035; отсутствие самой задачи 035 не считается дефектом задач 001–012.
- Найдено **18** открытых проблем и слабых мест: 1 с оценкой 9/10, 2 — 8/10, 4 — 7/10,
  5 — 6/10, 3 — 5/10 и 3 — 4/10.
- Подтверждённой удалённой уязвимости 9–10/10, доступной анонимному атакующему в текущем
  local-only контуре, не найдено. Проблема 9/10 становится критичной при ошибочной non-local
  конфигурации; проблема гонки 8/10 нарушает целостность доступа без участия внешнего атакующего.
- Наиболее сильные части реализации: брендированные server-side capability-объекты,
  fail-closed перепроверка Bitrix identity, portal scoping, транзакционные access-команды,
  идемпотентность, RLS/revoke для прикладных таблиц и отсутствие опасного HTML API во frontend.
- Главные риски: защита `service_role` секрета, корректность lease автоматического отзыва,
  браузерная политика iframe/CSP, CSRF, привилегированные SQL-функции и доверие к внешним URL.

Оценка 1–10 отражает совокупность влияния, достижимости и вероятности, а не только CVSS:
10 — немедленный критический компромисс; 8–9 — высокий риск или обязательный release blocker;
6–7 — существенная уязвимость; 4–5 — hardening/ограниченная достижимость; 1–3 — низкий риск.

## Методика и границы

Проверены цепочки:

1. request → body validation → session → current Bitrix identity → effective access → route;
2. access draft → preflight → confirmation → command → Queue → consumer → SQL transaction → audit;
3. cron → reconciliation lease → Bitrix snapshot → автоматический отзыв → notification/audit;
4. React bootstrap/routes → API clients → shared contracts → backend serializers;
5. Supabase client → migrations/RPC/RLS/grants → repository parsing;
6. Cloudflare bindings, Queue/R2 probes, dependency tree и предыдущий security-аудит.

Выполнены статический анализ и `bun audit`. Тесты, build, typecheck, lint, форматирование,
миграционные проверки и runtime smoke tests **не запускались** согласно правилам репозитория.
Реальные `.env` и `.dev.vars` не читались. Незавершённые задачи 014–035 не объявляются
дефектами; опасные предпосылки для них отмечены как release blockers.

## Общий реестр

| ID | Оценка | Статус | Слой | Проблема | Связанные задачи |
| --- | ---: | --- | --- | --- | --- |
| SEC-2026-001 | 9/10 | open | Backend/config | `service_role` может уйти на произвольный HTTPS Supabase host | 005–006 |
| SEC-2026-002 | 8/10 | open | DB/Cron | Просроченный lease не останавливает применение автоматического отзыва | 012 |
| SEC-2026-003 | 8/10 | open | Frontend/HTTP | Нет CSP, точного `frame-ancestors` и полного набора security headers | 002, 009, 013, 035 |
| SEC-2026-004 | 7/10 | open | HTTP/Auth | Нет общей CSRF/Fetch-Metadata политики и обязательного JSON content type | 009, 011, 035 |
| SEC-2026-005 | 7/10 | open | PostgreSQL | Многие `SECURITY DEFINER` используют непустой `search_path` | 005–008, 012 |
| SEC-2026-006 | 7/10 | open | Contracts/UI | Внешние URL проверяются только через `z.string().url()` | 003–004, 006, 013 |
| SEC-2026-007 | 7/10 | open | Audit | Redaction допускает секрет в разрешённой строке | 007, 011–012 |
| SEC-2026-008 | 6/10 | open | Supply chain | `bun audit`: 21 advisory, включая 9 high | 001–002 |
| SEC-2026-009 | 6/10 | open | API/DoS | Rate limit покрывает только часть дорогих маршрутов | 011–012 |
| SEC-2026-010 | 6/10 | open | API/DB/DoS | Число `fieldIds` не ограничено, HTTP лимит несогласован с DB | 011 |
| SEC-2026-011 | 6/10 | open | PostgreSQL/test | Production migration публикует destructive test-fixture RPC | 008 |
| SEC-2026-012 | 6/10 | open | Data boundary | Mutation repository требует лишь `app_access` | 006, 008, 010 |
| SEC-2026-013 | 5/10 | open | Auth | Stateless bearer нельзя отозвать; launch nonce не single-use | 009, 035 |
| SEC-2026-014 | 5/10 | open | Local/Queue/R2 | Runtime probe допускает flood и не гарантирует cleanup | 002 |
| SEC-2026-015 | 5/10 | open | Secrets/Auth | Session и confirmation подписываются одним ключом без `kid`/rotation | 009, 011 |
| SEC-2026-016 | 4/10 | open | Observability | Public health раскрывает readiness и всегда отвечает 200 | 002 |
| SEC-2026-017 | 4/10 | open | Queue | Handler выбирается по подстроке в имени Queue | 002, 011 |
| SEC-2026-018 | 4/10 | open | Config/types | Generated bindings и ручной `RuntimeEnvironment` расходятся | 002 |

## Детальные находки и план закрытия

### SEC-2026-001 — произвольный Supabase origin получает `service_role` key — 9/10

**Доказательство.** `backend/src/data/client.ts:17-24` возвращает `true` для любого
`APP_ENV !== 'local'`. После проверки только протокола `https:` строка URL вместе с
`SUPABASE_SERVICE_ROLE_KEY` передаётся в `createClient` (`:30-53`). Сравнение local allowlist
учитывает только hostname, не полный origin. Supabase service-role обходит RLS и должен оставаться
только в доверенной server-side среде.

**Сценарий.** Ошибка deployment variable, компромисс конфигурации или подмена значения на
`https://attacker.example` приводит к отправке полного привилегированного ключа этому серверу.

**План под мою техническую ответственность.** Ввести обязательный список точных origins для
каждого окружения; разрешать только канонический `https://host[:expected-port]` без credentials,
path, query и fragment; проводить проверку до создания клиента/любого fetch; разделить ключи
staging/production и описать rotation. Добавить отрицательные unit tests с перехватом fetch.

**Gate закрытия.** Произвольный host, DNS alias, credentials, неожиданный port/path/query/fragment
отклоняются во всех окружениях, и тест доказывает, что до отказа сеть не вызывается.

### SEC-2026-002 — stale lease способен применить устаревший отзыв — 8/10

**Доказательство.** В `supabase/migrations/20260814000000_automatic_access_revocation.sql:159-167`
`UPDATE access_reconciliation_job ... WHERE lease_token = p_lease_token` может обновить 0 строк,
но функция не проверяет `FOUND`/row count и продолжает менять `user_settings` (`:179-208`).

**Сценарий.** Worker A получает `inactive`, зависает, его lease истекает. Worker B получает новый
lease и более свежий `active`. Затем A продолжает с просроченным токеном: освобождение lease не
проходит, но старое решение всё равно отзывает права. Это нарушение целостности и доступности.

**План.** Для `cron`/`queue` до блокировки/изменения settings атомарно требовать совпадающий,
неистёкший lease; при несовпадении возвращать `stale_lease` без side effects. Ветку `request`
оформить отдельным RPC или явно запретить lease. Добавить конкурентный DB-тест с двумя worker и
просроченным токеном, а также тест active-after-inactive.

**Gate закрытия.** Ни одна запись settings/audit/notification не создаётся владельцем stale lease;
только текущий lease может завершить cron/queue reconciliation.

### SEC-2026-003 — нет browser security policy и доверенного iframe boundary — 8/10

**Доказательство.** В API и static assets отсутствуют CSP, `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy` и HSTS policy; `backend/src/api.ts:127-162` устанавливает
только correlation/cache headers. Frontend проверяет факт iframe, но не доверенный parent. Для
Bitrix embed нельзя использовать безусловный `X-Frame-Options: DENY`; нужен точный CSP
`frame-ancestors`.

**Риск.** Произвольный сайт может обрамить UI и проводить clickjacking. Отсутствие CSP увеличивает
последствия будущей XSS/скомпрометированного asset и не фиксирует допустимые `connect-src`,
`img-src`, `object-src`, `base-uri`.

**План.** Определить origin приложения и доверенные portal origins; отдавать CSP с точным
`frame-ancestors`, `default-src 'self'`, `object-src 'none'`, `base-uri 'none'`, минимальными
`script/style/connect/img` директивами; добавить остальные заголовки в Worker и `_headers` static
assets. Передавать доверенный portal origin только из проверенного launch/OAuth state, не из query.

**Gate закрытия.** HTTP-тесты проверяют API и HTML/assets; iframe работает только в разрешённом
Bitrix origin; внешний proof page не может встроить приложение.

Официальная база: [Cloudflare security headers](https://developers.cloudflare.com/workers/examples/security-headers/),
[Hono secure headers](https://hono.dev/docs/middleware/builtin/secure-headers).

### SEC-2026-004 — нет централизованной CSRF и media-type защиты — 7/10

**Доказательство.** `backend/src/http/validation.ts:72-100` разбирает JSON независимо от
`Content-Type`; `requireJsonContentType` вызывается только для `/api/_dev/session`. Мутации session,
draft, preflight, confirm и commands не проверяют `Origin`/`Sec-Fetch-Site`. Cookie сейчас
`SameSite=Lax` (`backend/src/auth/session-service.ts:103-111`), но окончательная iframe cookie
policy отложена в задачу 035.

**Риск.** Текущая Lax cookie снижает вероятность классического cross-site POST, но не заменяет
проверку same-site sibling origins и не переживёт возможный переход к `SameSite=None` для iframe.
Принимаемый `text/plain` упрощает simple cross-origin request.

**План.** Для всех unsafe methods требовать `application/json`; проверять точный Origin и Fetch
Metadata; определить исключения только для документированных machine endpoints; при необходимости
добавить CSRF token, привязанный к session/portal. DELETE session также включить в политику.

**Gate закрытия.** Cross-site и same-site-untrusted requests отклоняются до side effect; same-origin
JSON и разрешённый Bitrix handshake проходят; есть тесты для отсутствующего/поддельного Origin.

Официальная база: [Hono CSRF middleware](https://hono.dev/docs/middleware/builtin/csrf/).

### SEC-2026-005 — небезопасно широкая настройка `SECURITY DEFINER` — 7/10

**Доказательство.** Новые access-management функции используют безопасный `set search_path = ''`,
но функции в миграциях schema/data/audit/operation/automatic-revocation используют
`set search_path = public` или `public, extensions`; примеры:
`20260811030000_append_only_audit.sql:104,147,232`,
`20260812000000_operation_state_machine_hardening.sql:59-1408` и
`20260814000000_automatic_access_revocation.sql:29-128`. Репозиторий также не фиксирует revoke
`CREATE` на `public` и default function privileges как инвариант миграций.

**Риск.** `SECURITY DEFINER` исполняется с правами владельца. При появлении права создавать/подменять
объекты в schema из `search_path` неполностью квалифицированная ссылка может привести к privilege
escalation. Эксплуатируемость зависит от фактических grants проекта, поэтому это высокий
конфигурационный риск, а не доказанный bypass сегодня.

**План.** Инвентаризировать каждую definer-функцию; заменить path на `''`; квалифицировать все
relations/functions/operators/extensions; перенести внутренние RPC в private schema где возможно;
явно revoke execute from `public, anon, authenticated`, настроить default privileges и проверить
schema grants миграционным тестом.

**Gate закрытия.** DB lint не находит definer с непустым path; тест под `anon/authenticated`
доказывает отсутствие execute/create; service role имеет только необходимый RPC surface.

Официальная база: [Supabase Database Functions](https://supabase.com/docs/guides/database/functions).

### SEC-2026-006 — URL получают доверенный тип без проверки scheme/origin — 7/10

**Доказательство.** `packages/contracts/src/operations.ts:85,122,166,175`,
`packages/contracts/src/access-management.ts:254`,
`backend/src/integrations/bitrix/schemas.ts:68,103,181-182,237-276` и
`backend/src/data/repositories.ts:102` используют `z.string().url()`. Frontend уже загружает
`avatarUrl` напрямую в `<img src>` (`webapp/src/features/access/access-page.tsx:34-39`).

**Риск.** Синтаксически допустимые `data:`, `javascript:`, `file:` или произвольные HTTPS origins
становятся «проверенными». Сейчас React не вставляет HTML и `javascript:` не исполняется в `img`,
но произвольный image origin даёт tracking/privacy primitive; будущий `href` создаст XSS/phishing
boundary.

**План.** Создать shared schemas: относительный app route, HTTPS portal URL, HTTPS media URL;
запретить credentials и неожиданные ports; связывать Bitrix URLs с проверенным portal origin;
добавить безопасный frontend link/avatar wrapper с fallback.

**Gate закрытия.** Все опасные schemes и чужие origins отклоняются в contract, adapter, repository
и UI tests; raw URL никогда не попадает в `href/src` без повторной политики.

### SEC-2026-007 — audit redaction не гарантирует отсутствие секретов — 7/10

**Доказательство.** `backend/src/data/audit.ts:22-45` удаляет ограниченный набор key names и
распознаёт Bearer/Bitrix REST/query tokens. Разрешённая строка с Basic credentials, JWT без префикса,
API key, service-role key или URL-encoded вариантом проходит в append-only журнал.

**Риск.** Журнал намеренно неизменяем; случайно записанный секрет трудно удалить и он расширяет
радиус компромисса для всех читателей аудита.

**План.** Перейти на action-specific factories и enum code вместо произвольных сообщений;
никогда не принимать raw exception/upstream payload; расширить redaction defense-in-depth;
добавить canary-тесты для каждого поля actor/subject/related/details и безопасный emergency purge
процесс для подтверждённой утечки с отдельным security audit trail.

**Gate закрытия.** Набор secret canaries не появляется ни в RPC args, ни в БД, ни в logs/snapshots;
сырой exception невозможно передать через типизированный audit API.

### SEC-2026-008 — 21 известная уязвимость dependency tree — 6/10

**Доказательство.** `bun audit` 2026-08-15 завершился с code 1: **9 high, 10 moderate, 2 low**.
Затронуты nested `wrangler <4.59.1`, `ws <8.20.1`, `nanoid <3.3.18`, `sharp <0.35.0` и
`undici <7.18.2`. Среди advisory: command injection в `wrangler pages deploy`, WebSocket DoS,
memory disclosure, request/response smuggling и cache/cookie/header parsing issues.

**Риск.** Большинство путей относится к local/test/build tooling и может быть недостижимо в Worker
runtime, но command injection опасен в CI/deploy, а сетевые parsers обрабатывают недоверенный ввод
в dev/test инфраструктуре.

**План.** Обновить Cloudflare Vite plugin, pool и Wrangler совместимым набором; проверить dedupe;
не использовать vulnerable deploy command до обновления; для каждого оставшегося advisory
зафиксировать reachability и срок, не скрывать его override без проверки.

**Gate закрытия.** `bun audit` чист либо каждое исключение имеет доказанную недостижимость, владельца
и expiry; после обновления пользователь выполняет полный `bun run check` и runtime compatibility.

### SEC-2026-009 — неполное rate limiting дорогих endpoint — 6/10

**Доказательство.** DB buckets существуют для draft/preflight/command/target/filtered search
(`20260813000000_access_management_state.sql:524-545,950-1000`). Но `/users?status=all` не
лимитируется (`backend/src/access-management/routes.ts:378-412`), как и session creation,
capabilities, profiles, departments, fields, confirmation, health и local probe.

**Риск.** Авторизованный пользователь или украденная cookie может создавать дорогой Bitrix/DB
fan-out. Session/probe endpoints допускают анонимный computational/queue flood в своём контуре.

**План.** Ввести многоуровневые limits: edge IP для анонимных routes; portal+actor+action для
авторизованных; отдельные budgets для Bitrix fan-out и confirmations; `Retry-After`, bounded
concurrency и метрики reject. Не полагаться только на upstream Bitrix limits.

**Gate закрытия.** Burst и sustained тесты подтверждают квоты, tenant isolation и отсутствие
side effects после reject; нормальная пагинация не блокируется.

### SEC-2026-010 — неограниченное число полей и несогласованные byte limits — 6/10

**Доказательство.** `accessManagementDraftIntentSchema` ограничивает uniqueness, но не `.max()` для
`fieldIds` (`packages/contracts/src/access-management.ts:332-358`). Routes принимают до 1 500 000
байт (`backend/src/access-management/routes.ts:745-819`), затем создают field-set; DB draft payload
ограничен 131 072 байт, но сами field-set rows создаются до сохранения draft.

**Риск.** Большой список уникальных полей вызывает дорогие Set/adapter/SQL/hash/insert операции,
рост immutable field-set tables и отказ позднее на несогласованном DB лимите.

**План.** Установить продуктовый `maxManagedFields`; согласовать HTTP/Zod/RPC/DB limits; проверять
count и bytes до Bitrix/DB; сделать field-set creation и draft save одной атомарной операцией либо
ввести безопасный GC для orphan sets.

**Gate закрытия.** Запрос выше лимита отклоняется до adapter/DB; boundary tests совпадают на всех
слоях; неуспешный save не оставляет новый field set.

### SEC-2026-011 — destructive fixture cleanup находится в production migration — 6/10

**Доказательство.** `purge_integration_test_fixture` создаётся в
`20260812000000_operation_state_machine_hardening.sql:1417-1466` и получает execute для
`service_role` (`:1537`). Проверки имени/ID существенно сужают область удаления, но тестовый
destructive RPC остаётся частью production surface.

**Риск.** Ошибка в будущей модификации проверки или совпавшие fixture-предикаты дают привилегированный
delete path. Компромисс service role получает лишнюю destructive capability.

**План.** Удалить функцию отдельной forward migration; перенести cleanup в test harness с прямым
DB admin connection/транзакционным rollback; добавить production assertion, что функция отсутствует.

**Gate закрытия.** RPC отсутствует в production schema и generated types; integration tests очищают
только изолированную test DB без deployable destructive function.

### SEC-2026-012 — mutation repository защищён только общим `app_access` — 6/10

**Доказательство.** `createDataAccessContext` требует `app_access`, а методы create/start/cancel/
retry/finalize operation и record result в `backend/src/data/repositories.ts:604-892` вызывают
главным образом `requireDataAccessContext`, без method-specific user permission или отдельного
trusted-worker capability. Фактические task-field checks существуют отдельно в
`backend/src/data/access.ts:301-347`.

**Риск.** Будущий route/consumer легко подключить к repository в неверном порядке и превратить
integration mistake в authorization bypass. Бренд защищает происхождение identity, но не доказывает
разрешение конкретного действия.

**План.** Разделить user-command и system-consumer contexts; требовать method-specific permission
и preflight/field authorization proof на user mutations; worker mutations принимать только
внутренний unforgeable capability; добавить compile/runtime negative tests.

**Gate закрытия.** Пользователь с одним `app_access` не может создать/запустить/остановить операцию
через любой слой; consumer не может быть вызван с user context; обход проверки не компилируется
или fail-closed в runtime.

### SEC-2026-013 — bearer replay и отсутствие server-side revocation — 5/10

**Доказательство.** Session HMAC token живёт 15 минут, session store/revocation list отсутствует;
DELETE только удаляет browser cookie. Mock launch содержит nonce, но nonce не сохраняется и может
быть повторён в течение 5 минут (`backend/src/auth/signed-token.ts:18-32,229-258`). Решение задачи
009 явно переносит production single-use/CSRF policy в задачу 035.

**Риск.** Украденная session cookie продолжает работать после logout до expiry. Повтор launch token
создаёт новые sessions. Текущая перепроверка Bitrix activity и access уменьшает ущерб, но не отзывает
конкретный скомпрометированный session.

**План.** Для production ввести одноразовый OAuth/launch state, `jti` и server-side session
revocation/rotation; logout инвалидирует session id; ограничить concurrent sessions; логировать
безопасные события create/revoke/replay без токена.

**Gate закрытия.** Повтор launch state отклоняется; украденный token после logout/revoke не проходит;
race tests доказывают single-use атомарность.

### SEC-2026-014 — local runtime probe: flood и негарантированный cleanup — 5/10

**Доказательство.** `/api/_runtime/probe` проверяет только `APP_ENV=local`, не loopback, custom
header, Origin или rate limit (`backend/src/api.ts:225-244`). `verifyRuntimeProbeArtifact` удаляет
R2 object только по успешной ветке; ошибка get/mismatch пропускает delete
(`backend/src/runtime/probe.ts:38-59`).

**Риск.** При доступном dev server чужая страница/процесс создаёт Queue/R2 нагрузку; retry оставляет
объекты и усиливает накопление. Риск ограничен local окружением, пока флаг надёжно соблюдается.

**План.** Отдельный disabled-by-default enable flag, loopback + Origin/Fetch Metadata + custom header,
rate limit; best-effort delete в `finally`; DLQ policy для malformed probes вместо бесконечного retry.

**Gate закрытия.** Cross-site/non-loopback probe не создаёт сообщение; failed read/mismatch пытается
очистить объект; cleanup failure не скрывает исходную ошибку.

### SEC-2026-015 — один signing secret и нет ротации ключей — 5/10

**Доказательство.** Session и access-confirmation имеют разные `typ`/`aud`, что предотвращает
cross-token substitution, но обе подписи используют `SESSION_SIGNING_SECRET`
(`backend/src/access-management/routes.ts:1240-1248,1308-1314`). Header не содержит `kid`, verifier
поддерживает только один ключ.

**Риск.** Компромисс одного ключа одновременно позволяет подделывать sessions и подтверждения;
без key ring ротация мгновенно инвалидирует все активные токены либо вынуждает опасно держать старый
ключ без явной политики.

**План.** Развести session/confirmation keys; добавить version/`kid`, current+previous verification
window и documented rotation; confirmation сделать короткоживущим и, для destructive действий,
одноразовым на command ID.

**Gate закрытия.** Ключ одного token class не подписывает другой; ротация проверена без silent
downgrade; старый key прекращает приниматься после bounded grace period.

### SEC-2026-016 — health раскрывает конфигурацию и не является readiness — 4/10

**Доказательство.** Public `/api/health` напрямую отдаёт `getRuntimeReadiness` и всегда использует
обычный JSON 200 (`backend/src/api.ts:164`). Ответ раскрывает готовность Supabase/Bitrix/Queue/R2 и
не имеет отдельного no-store middleware.

**Риск.** Это reconnaissance signal и ложноположительный health для оркестратора/мониторинга.

**План.** Разделить минимальный public liveness и защищённый/internal readiness; degraded readiness
возвращает 503; добавить no-store и безопасные aggregate codes без списка секретных bindings.

**Gate закрытия.** Public ответ не раскрывает топологию; обязательная dependency failure даёт 503;
monitoring использует документированный endpoint.

### SEC-2026-017 — Queue dispatch зависит от подстроки имени — 4/10

**Доказательство.** `backend/src/consumer.ts:230-237` выбирает access handler через
`batch.queue.includes('access-commands')`; всё остальное считается runtime probe queue.

**Риск.** Rename/alias с совпавшей или отсутствующей подстрокой направляет trusted message в чужой
handler. Access path malformed messages ack, probe path retry; ошибка конфигурации способна тихо
терять команды или раздувать DLQ.

**План.** Отдельные Worker entrypoints/configs либо точный allowlist queue names с fail-closed ack/DLQ
policy; startup/deployment assertion и contract test каждого binding.

**Gate закрытия.** Неизвестное имя не выбирает бизнес-handler; rename ломает проверку до deploy,
а не данные во время исполнения.

### SEC-2026-018 — binding type drift скрывается casts — 4/10

**Доказательство.** Hono использует ручной `RuntimeEnvironment` с optional bindings, Queue извлекается
cast в `backend/src/api.ts:232-235`; consumer имеет отдельный Wrangler config, но runtime code не
компилируется против отдельного generated Env. Аналогичная проблема была в аудите 2026-08-11.

**Риск.** Отсутствующий/неверный binding обнаруживается только при side effect. Разные compatibility
dates/configs могут давать ложную уверенность тестов.

**План.** Генерировать и использовать отдельные `ApiEnv`/`ConsumerEnv`; убрать casts; синхронизировать
compatibility baseline; проверять config-to-types drift в CI после `cf-typegen`.

**Gate закрытия.** Каждый entrypoint компилируется со своим generated type, bindings не optional без
реальной optional-семантики, runtime cast для Queue/R2 отсутствует.

## Перепроверка отчёта 2026-08-11

| Старый ID | Текущее состояние | Результат перепроверки |
| --- | --- | --- |
| SEC-001 | closed by implementation | EffectiveAccess/DataAccessContext брендированы, permissions читаются server-side |
| SEC-002 | open | Перенесён в SEC-2026-001; non-local allowlist всё ещё отсутствует |
| SEC-003 | partially fixed | Streaming byte limit исправлен; content type/413 policy остаётся в SEC-2026-004 |
| SEC-004 | partially fixed | Большинство DB byte/count constraints добавлено; остаётся SEC-2026-010 |
| SEC-005 | open | Перенесён в SEC-2026-006; frontend уже использует внешний avatar URL |
| SEC-006 | open | Перенесён в SEC-2026-007 |
| SEC-007 | closed by implementation | Operation/result state invariants усилены в task 008 migration/RPC |
| SEC-008 | open, изменился состав | Перенесён в SEC-2026-008; актуально 21 advisory |
| SEC-009 | open | Объединён в SEC-2026-014 |
| SEC-010 | open | Объединён в SEC-2026-014 |
| SEC-011 | open | Разделён на SEC-2026-003 и SEC-2026-016 |
| SEC-012 | open | Перенесён в SEC-2026-018 |

Статус `closed by implementation` здесь означает, что статический код устраняет исходную причину;
окончательное закрытие требует выполнения тестов пользователем.

## Подтверждённые защитные свойства

- Нет `dangerouslySetInnerHTML`, `innerHTML`, `eval` или `new Function`; React выводит строки как text.
- Frontend не хранит session/confirmation secrets в `localStorage`; confirmation token остаётся в
  памяти, session cookie — `HttpOnly; Secure; Path=/api`.
- HMAC verifier строго проверяет header, audience, canonical base64url, signature length, TTL и skew.
- Cookie parser ограничивает размер и отвергает дубликаты session cookie.
- Каждый защищённый request повторно проверяет текущего Bitrix user; inactive/identity mismatch
  fail-closed. Ошибка durable auto-revoke не разрешает сам request.
- Effective access и repository context являются unforgeable WeakSet capabilities; admin rights
  выводятся на сервере, а не принимаются из request.
- Access-management route повторно проверяет leadership, admin state, target visibility, field
  capabilities, actor/target versions и permission dependency closure.
- Preflight и confirmation привязаны к portal, actor, draft revision и имеют короткий TTL;
  confirmation token не сохраняется в БД.
- Access command idempotent, имеет outbox/recovery, а consumer повторно валидирует actor/target перед
  применением каждой цели.
- SQL access transition блокирует строки и повторно проверяет actor scope/version внутри транзакции.
- Прикладные таблицы имеют RLS; прямые grants для anon/authenticated отозваны; access evidence и
  audit защищены от обычных update/delete.
- HTTP errors не возвращают stack/raw exception; logs в просмотренном коде содержат только safe IDs
  и error names.
- JSON body действительно ограничивается по фактическим bytes, включая chunked requests, и UTF-8
  декодируется в fatal mode.
- Нет чтения/экспорта Supabase service-role во frontend bundle.

## Порядок исправлений и ответственность

Я беру техническую ответственность за предложенную последовательность, минимальность change
surface и критерии закрытия. Это не означает автоматического изменения исходников: по правилам
репозитория реализация начнётся только после явной команды пользователя. Проблема не будет объявлена
закрытой без доказательств и результатов проверок, которые запускает пользователь.

### P0 — немедленно, до любого non-local deployment

1. SEC-2026-001 — блокировать утечку service-role через origin policy.
2. SEC-2026-002 — сделать lease ownership атомарным security invariant.
3. SEC-2026-003 и SEC-2026-004 — browser boundary, CSP и CSRF.
4. SEC-2026-005 — привести все privileged RPC к безопасному path/grants.
5. SEC-2026-006 и SEC-2026-007 — закрыть URL и audit confidentiality boundaries.

**Release gate:** ни один non-local deployment до закрытия всех P0 и прохождения DB/API/browser
security tests.

### P1 — до подключения task-search и массовых операций

1. SEC-2026-012 — action-specific user/worker capabilities.
2. SEC-2026-009 и SEC-2026-010 — rate/count/byte limits.
3. SEC-2026-008 — обновить dependency tree.
4. SEC-2026-011 — убрать test-only destructive RPC из deployable schema.
5. SEC-2026-013 и SEC-2026-015 — production session/replay/key rotation design совместно с task 035.

**Integration gate:** routes задач 014–022 не получают mutation repositories до action-specific
proof и отрицательных authorization tests.

### P2 — hardening local/runtime/operations

1. SEC-2026-014 — probe isolation и R2 cleanup.
2. SEC-2026-016 — liveness/readiness split.
3. SEC-2026-017 — deterministic queue routing.
4. SEC-2026-018 — generated binding types и config parity.

## Рекомендуемая структура работ по каждой проблеме

Для каждой записи применяется один и тот же контролируемый цикл:

1. отдельная scoped change без несвязанных рефакторингов;
2. отрицательный regression test, который воспроизводит риск до исправления;
3. минимальное исправление в owning layer, затем защита соседних границ;
4. синхронизация contract/runtime/DB constraints, если затронуты данные;
5. миграция только forward и rollback/rollout note для production state;
6. пользователь запускает целевые и общие проверки;
7. повторный статический review и только затем статус `closed`.

## Команды проверки после реализации

Команды запускает пользователь:

```bash
bun audit
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run db:docker:reset
bun run db:docker:test
bun run db:docker:lint
```

После P0 дополнительно обязательны целевые проверки:

- hostile Supabase URL tests с assert «fetch не вызван»;
- concurrent stale-lease DB test;
- cross-origin/Fetch-Metadata/JSON media-type API tests;
- CSP/frame-ancestors browser test из разрешённого и запрещённого parent origin;
- DB privilege inventory для `SECURITY DEFINER`, schema grants и function execute grants;
- URL-scheme/origin и audit secret-canary tests.

## Источники актуальных требований

- [Cloudflare: Set security headers](https://developers.cloudflare.com/workers/examples/security-headers/)
- [Cloudflare: static asset headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Hono: CSRF Protection](https://hono.dev/docs/middleware/builtin/csrf/)
- [Hono: Secure Headers](https://hono.dev/docs/middleware/builtin/secure-headers/)
- [Supabase: Database Functions — SECURITY DEFINER, search_path и privileges](https://supabase.com/docs/guides/database/functions)
- [Supabase: Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [GitHub Advisory: Wrangler command injection](https://github.com/advisories/GHSA-36p8-mvp6-cv38)
- Остальные точные advisory перечислены в выводе `bun audit` от 2026-08-15.

## Остаточная неопределённость

- Не выполнены динамические тесты, DAST, browser instrumentation и тест реального Bitrix iframe.
- Не проверялись реальные Cloudflare/Supabase dashboard grants, WAF/rate-limit rules и secret rotation.
- Production OAuth/Bitrix adapter отсутствуют по плану; их безопасность должна пройти отдельный audit
  в задаче 035.
- Dependency advisories оценены по lockfile; reachability каждого сетевого parser path требует
  повторной проверки после обновления.
- Frontend задачи 013 существует в рабочем дереве, но задача не отмечена завершённой; выводы по нему
  являются ранним security gate, а не заявлением о выполнении задачи 013.
