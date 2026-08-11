# Аудит безопасности выполненного среза

Дата аудита: 2026-08-11  
Статус документа: рабочий реестр исправлений  
Область аудита: задачи 001–007, отмеченные как выполненные в `TASKS.md`

## Назначение

Документ фиксирует найденные дефекты и слабые места безопасности. Он является рабочим
реестром для последующего исправления, проверки и закрытия проблем.

Отсутствующая функциональность задач 008–035 не считается дефектом выполненного среза.
Если существующая реализация создаёт опасную границу для будущей задачи, проблема отмечена
как отложенный блокер и должна быть устранена до подключения соответствующего API или
consumer.

## Сводная оценка

- Безопасность выполненного среза: 6/10.
- Готовность к production: 2/10.
- Прямо эксплуатируемые критические уязвимости уровня 9–10/10 в текущем локальном
  foundation shell не обнаружены.
- Найдено 12 проблем и архитектурных блокеров.

## Правила ведения реестра

Допустимые статусы:

- `open` — исправление не начато;
- `in_progress` — выполняется реализация;
- `verification` — реализация завершена, требуются проверки;
- `closed` — критерии закрытия выполнены;
- `accepted` — риск принят явно и документирован отдельно.

Проблема переводится в `closed` только после выполнения всех критериев закрытия и
указанных проверок. Снижение оценки риска без изменения реализации не закрывает проблему.

## Общий реестр

| ID | Оценка | Статус | Проблема | Тип |
| --- | ---: | --- | --- | --- |
| SEC-001 | 8/10 | open | Права принимаются из переданного `DataAccessContext` | Отложенный блокер доступа |
| SEC-002 | 8/10 | open | Production Supabase URL не ограничен allowlist | Конфиденциальность секретов |
| SEC-003 | 8/10 | open | JSON-тело полностью буферизуется без лимита | DoS |
| SEC-004 | 7/10 | open | Snapshot JSON и элементы массивов не имеют полного byte-limit | Persistent DoS |
| SEC-005 | 7/10 | open | URL-контракты разрешают опасные схемы | XSS / phishing primitive |
| SEC-006 | 7/10 | open | Audit redaction допускает секреты в разрешённых строках | Утечка секретов |
| SEC-007 | 7/10 | open | Результат задачи не связан со selection и статусом операции | Целостность данных |
| SEC-008 | 6/10 | open | В lockfile присутствуют известные уязвимые зависимости | Supply chain |
| SEC-009 | 6/10 | open | Runtime probe не защищён от CSRF и flood | DoS / CSRF |
| SEC-010 | 4/10 | open | R2 probe не гарантирует очистку объекта | Накопление данных |
| SEC-011 | 4/10 | open | Нет security headers и корректного readiness endpoint | Hardening / observability |
| SEC-012 | 4/10 | open | Типы bindings и runtime-конфигурации расходятся | Конфигурационная целостность |

## SEC-001. Недоверенный контекст авторизации

Оценка: **8/10**  
Статус: `open`  
Текущая эксплуатируемость: внешнего data API нет; проблема блокирует его подключение.

### Доказательство

- `backend/src/data/access.ts` принимает `permissions` внутри произвольного входного объекта.
- `createDataAccessContext(value: unknown)` возвращает обычный структурный объект без
  доказательства происхождения identity и permissions.
- `backend/src/data/repositories.ts` принимает решение о `view_all_reports` и `view_audit`
  на основании этого объекта.
- Supabase client использует service-role key, поэтому ошибка на уровне Worker обходит RLS.

### Риск

Будущий HTTP handler может передать `portalId`, `actorId` или `permissions` из тела запроса,
заголовка или неподтверждённой сессии. Это даст межпользовательский или межпортальный доступ.

### Исправление

1. Запретить публичное создание доверенного контекста из `unknown`.
2. Ввести отдельный брендированный тип `VerifiedAccessContext`.
3. Создавать его только после проверки активной Bitrix-сессии.
4. Получать effective permissions из серверного источника, а не из запроса.
5. Проверять `access_active` при каждом пользовательском запросе.
6. Не передавать набор прав через JSON-границу API.

### Критерии закрытия

- Подделка `portalId`, `actorId` и `permissions` не меняет фактические права.
- Неактивный пользователь не получает доступ к данным.
- Есть отрицательные cross-user и cross-portal тесты.
- Ни один пользовательский route не принимает обычный `DataAccessContext`.

## SEC-002. Неограниченный Supabase origin вне local-режима

Оценка: **8/10**  
Статус: `open`

### Доказательство

`backend/src/data/client.ts` возвращает `true` из проверки host для любого
`APP_ENV !== 'local'`. Единственным ограничением остаётся протокол HTTPS.

### Риск

Ошибка или подмена production-конфигурации отправит service-role key на произвольный
HTTPS endpoint.

### Исправление

1. Сделать allowlist точных Supabase origin обязательным для каждого окружения.
2. Сравнивать полный origin, а не только hostname.
3. Запретить username, password, query и fragment в URL.
4. Запретить неожиданный порт и path.
5. Завершать запуск с ошибкой при отсутствии allowlist.

### Критерии закрытия

- Произвольный HTTPS host отклоняется в local, staging и production.
- URL с credentials, нестандартным портом или неожиданным path отклоняется.
- В тестах доказано, что service-role key не отправляется до завершения проверки URL.

## SEC-003. Неограниченная буферизация HTTP body

Оценка: **8/10**  
Статус: `open`

### Доказательство

`backend/src/http/validation.ts` вызывает `request.text()` до проверки размера тела.

### Риск

Большой или бесконечный chunked request способен исчерпать память Worker. Общий helper
перенесёт уязвимость во все будущие JSON endpoints.

Cloudflare рекомендует не буферизовать неограниченные тела:
https://developers.cloudflare.com/workers/best-practices/workers-best-practices/

### Исправление

1. Определить общий максимальный размер JSON-запроса.
2. Проверять `Content-Length` до чтения.
3. Читать chunked body с фактическим счётчиком байтов и ранним прерыванием.
4. Возвращать `413 PAYLOAD_TOO_LARGE`.
5. Требовать допустимый JSON content type.
6. Ограничить или запретить неожиданные content encodings.

### Критерии закрытия

- Oversized body отклоняется до полной буферизации.
- Chunked body без `Content-Length` также ограничен.
- Пограничный допустимый размер обрабатывается корректно.
- Проверки применяются централизованно ко всем JSON routes.

## SEC-004. Неполные ограничения размера сохраняемых данных

Оценка: **7/10**  
Статус: `open`

### Доказательство

В `supabase/migrations/20260811000000_task_commander_schema.sql` ограничивается количество
элементов `selected_task_ids`, `allowed_field_ids` и result field arrays, но не длина каждого
элемента. Для `filter_snapshot`, `sort_snapshot` и `preflight_snapshot` проверяется тип JSON,
но не полный размер в байтах.

Repository methods принимают TypeScript-интерфейсы без общей runtime-валидации входа перед
записью.

### Риск

Worker с service-role способен сохранить чрезмерно большие payloads. Это создаёт рост БД,
дорогие запросы, замедление индексов и отказ обработки.

### Исправление

1. Добавить `octet_length` ограничения для каждого JSON snapshot.
2. Ограничить длину каждого task ID и field ID через database constraints.
3. Ограничить общий byte-size массивов.
4. Ввести Zod-схемы входа для каждого repository write method.
5. Согласовать ограничения TypeScript, Zod и PostgreSQL.

### Критерии закрытия

- Большой JSON отклоняется одинаково на Worker и DB уровнях.
- Слишком длинный элемент массива отклоняется даже при допустимом количестве элементов.
- Миграционные тесты покрывают верхние границы и превышение лимита.

## SEC-005. URL-контракты разрешают опасные схемы

Оценка: **7/10**  
Статус: `open`  
Текущая эксплуатируемость: frontend пока не выводит эти значения как ссылки.

### Доказательство

`packages/contracts/src/operations.ts`, `backend/src/integrations/bitrix/schemas.ts` и
`backend/src/data/repositories.ts` используют `z.string().url()`. Такая проверка подтверждает
синтаксис URL, но не ограничивает протокол или доверенный origin.

### Риск

`javascript:`, `data:` и другие нежелательные схемы могут получить тип доверенного URL.
Будущий вывод такого значения в `href` создаст XSS или phishing primitive.

### Исправление

1. Ввести общий `httpsUrlSchema`.
2. Запретить username и password в URL.
3. Task и Disk URLs связывать с доверенным portal origin.
4. `operationUrl` ограничить origin приложения или относительным маршрутом.
5. Повторно проверять URL перед созданием кликабельной ссылки.

### Критерии закрытия

- `javascript:`, `data:`, `file:`, `http:` и URL с credentials отклоняются.
- Разрешены только ожидаемые HTTPS origins.
- Frontend-тест подтверждает отсутствие опасного `href`.

## SEC-006. Неполная защита audit от секретов

Оценка: **7/10**  
Статус: `open`

### Доказательство

`backend/src/data/audit.ts` удаляет ограниченный набор ключей и распознаёт несколько
строковых шаблонов. Одновременно `packages/contracts/src/audit.ts` разрешает произвольные
строки в `reasonCode`, `errorCode` и `component`.

### Риск

API key, Basic credential, raw upstream identifier или фрагмент service-role/JWT может быть
передан в разрешённом поле и сохранён в неизменяемом журнале.

### Исправление

1. Заменить свободные error/reason codes на enum или строгий code regex.
2. Создавать события через action-specific factories.
3. Запретить raw exception messages в audit API.
4. Добавить распознавание Basic auth, API keys, JWT, service-role tokens и URL-encoded tokens.
5. Оставить redaction последним защитным слоем после структурного построения события.

### Критерии закрытия

- Секрет не проходит через ни одно разрешённое строковое поле.
- Тесты покрывают секреты в actor, subject, related objects и каждом details variant.
- Raw upstream response или exception невозможно передать в audit contract.

## SEC-007. Недостаточные инварианты записи task result

Оценка: **7/10**  
Статус: `open`  
Связь с планом: должно быть исправлено до подключения задачи 008 и consumer.

### Доказательство

`supabase/migrations/20260811020000_data_access_hardening.sql` блокирует operation row по
`portal_id + operation_id`, но не проверяет:

- наличие `task_id` в `selected_task_ids`;
- допустимый статус операции для записи результата;
- запрет изменения завершённой операции.

### Риск

Внутренняя ошибка или скомпрометированный Worker может добавить результат посторонней задачи
или изменить агрегаты финальной операции.

### Исправление

1. Проверять `task_id = any(selected_task_ids)`.
2. Разрешать запись результата только в допустимом processing status.
3. Сделать финальные статусы неизменяемыми для result RPC.
4. Проверять непревышение ожидаемого количества результатов до insert.

### Критерии закрытия

- Результат невыбранной задачи отклоняется.
- Результат для завершённой, отменённой или interrupted операции отклоняется.
- Повтор идентичного результата остаётся идемпотентным.
- Проверки выполняются внутри той же транзакции.

## SEC-008. Известные уязвимости dependency tree

Оценка: **6/10**  
Статус: `open`  
Текущая эксплуатируемость: найденные версии находятся преимущественно в local/test tooling.

### Доказательство

`bun audit` завершился с exit code 1. В `bun.lock` присутствуют:

- `sharp 0.33.5`;
- `undici 7.14.0` и `7.28.0`;
- `ws 8.18.x`;
- nested `wrangler 4.56.0`.

Advisories:

- https://github.com/advisories/GHSA-f88m-g3jw-g9cj
- https://github.com/advisories/GHSA-4cwx-7wf7-3272
- https://github.com/advisories/GHSA-96hv-2xvq-fx4p
- https://github.com/advisories/GHSA-36p8-mvp6-cv38

### Исправление

1. Обновить `@cloudflare/vitest-pool-workers`.
2. Обновить `@cloudflare/vite-plugin`.
3. Получить дерево с `undici >= 7.29.0`, `ws >= 8.21.0`, `sharp >= 0.35.0` и
   `wrangler >= 4.59.1`.
4. Не использовать overrides без проверки peer dependencies и Cloudflare runtime.

### Критерии закрытия

- `bun audit` не возвращает известные high/moderate уязвимости в достижимом дереве.
- Оставшийся advisory имеет документированное доказательство недостижимости и владельца риска.
- Local Worker и Worker tests используют совместимые версии workerd/miniflare.

## SEC-009. Runtime probe допускает CSRF и flood

Оценка: **6/10**  
Статус: `open`

### Доказательство

`POST /api/_runtime/probe` в `backend/src/api.ts` проверяет только `APP_ENV=local`. Маршрут
не требует специального заголовка, не проверяет Origin/Fetch Metadata и не имеет rate limit.

### Риск

Вредоносная страница может инициировать простой cross-origin POST к локальному dev server.
CORS запрещает чтение ответа, но не отправку запроса. Flood создаёт Queue, DLQ и R2 нагрузку.

### Исправление

1. Добавить отдельный `ENABLE_RUNTIME_PROBE` с безопасным значением по умолчанию.
2. Проверять `Origin` и `Sec-Fetch-Site`.
3. Требовать custom header, исключающий simple cross-origin request.
4. Добавить rate limit.
5. Не регистрировать route при выключенном probe.

### Критерии закрытия

- Cross-site request отклоняется до Queue side effect.
- Probe отсутствует без явного enable-флага.
- Rate-limit тест подтверждает ограничение burst и sustained traffic.

## SEC-010. R2 probe не гарантирует cleanup

Оценка: **4/10**  
Статус: `open`

### Доказательство

`backend/src/runtime/probe.ts` удаляет объект только после успешного `put`, `get` и compare.
Ошибка чтения или mismatch пропускает `delete`.

### Риск

Неуспешные probe-сообщения оставляют технические объекты в bucket. Flood увеличивает
накопление.

### Исправление

1. Перенести best-effort cleanup в `finally`.
2. Не скрывать исходную ошибку при вторичной ошибке удаления.
3. Логировать отдельный безопасный cleanup outcome.

### Критерии закрытия

- Объект удаляется после mismatch и ошибки чтения, если R2 доступен.
- Тесты покрывают отказ `get`, mismatch и отказ `delete`.

## SEC-011. Нет security headers и корректного readiness

Оценка: **4/10**  
Статус: `open`

### Доказательство

- В проекте отсутствует security-header policy.
- `/api/health` возвращает подробное состояние подсистем.
- Degraded runtime продолжает отвечать HTTP 200 и `status: ok`.

### Риск

Endpoint раскрывает конфигурационное состояние и непригоден для корректного исключения
неработоспособного instance. Отсутствие CSP увеличит последствия будущего frontend XSS.

### Исправление

1. Разделить минимальный публичный liveness и закрытый readiness.
2. Возвращать 503 для неготового readiness.
3. Добавить CSP, `X-Content-Type-Options`, Referrer-Policy и Permissions-Policy.
4. Добавить HSTS только для production HTTPS.
5. Добавить `Cache-Control: no-store` для чувствительных API responses.
6. Настроить точный CSP `frame-ancestors` для доверенного Bitrix portal origin.

### Критерии закрытия

- Публичный health не раскрывает состав bindings и конфигурации.
- Readiness возвращает 503 при недоступной обязательной подсистеме.
- Security headers проверяются автоматическим HTTP-тестом.

## SEC-012. Расхождение Env types и runtime-конфигурации

Оценка: **4/10**  
Статус: `open`

### Доказательство

- `backend/worker-configuration.d.ts` содержит generated `Env`.
- Hono использует ручной `RuntimeEnvironment` с optional и `unknown` bindings.
- Queue binding извлекается через cast.
- Consumer имеет отдельный Wrangler config, но не отдельный generated Env.
- `backend/wrangler.test.jsonc` использует более старую compatibility date.
- Consumer config не включает observability.

### Риск

Binding drift скрывает отсутствие или неправильный тип Queue/R2. Разные runtime dates способны
скрыть поведение, которое отличается между тестом и фактическим Worker.

Cloudflare рекомендует generated binding types и актуальную compatibility date:
https://developers.cloudflare.com/workers/best-practices/workers-best-practices/

### Исправление

1. Генерировать отдельные `ApiEnv` и `ConsumerEnv` из соответствующих config files.
2. Удалить `unknown` bindings и cast.
3. Синхронизировать compatibility dates.
4. Включить structured observability для consumer.
5. Проверять binding-code consistency при изменении конфигурации.

### Критерии закрытия

- Каждый Worker компилируется против собственного generated Env.
- В runtime code отсутствуют casts для получения bindings.
- Test и development runtime используют согласованный compatibility baseline.
- Consumer errors видимы в structured logs.

## Подтверждённые защитные свойства

- Реальные секреты не найдены в tracked frontend и Worker config.
- `.dev.vars` и `.env*` исключены из Git.
- Service-role client находится только в backend.
- Local Supabase требует HTTPS и exact-host allowlist.
- RLS включён на прикладных таблицах.
- `anon` и `authenticated` лишены прямого доступа к прикладным таблицам и RPC.
- Direct audit `INSERT`, `UPDATE` и `DELETE` закрыты для runtime service role.
- Audit update/delete блокируются триггерами.
- SQL queries используют Supabase query builder и RPC.
- Cursor values проходят datetime/UUID validation.
- API errors не возвращают exception message или stack.
- Security-sensitive IDs используют Web Crypto и `crypto.randomUUID()`.
- Frontend не содержит `dangerouslySetInnerHTML`, `innerHTML`, `eval`, browser storage или
  клиентских токенов.
- Mock Bitrix активируется только при `APP_ENV=local` и `BITRIX_ADAPTER=mock`.

## Порядок исправления

### P0. До подключения пользовательского data API

1. SEC-001 — доверенный identity/permissions context.
2. SEC-002 — обязательный Supabase origin allowlist.
3. SEC-004 — runtime и database payload limits.
4. SEC-005 — безопасные URL-контракты.
5. SEC-006 — строгая audit confidentiality.
6. SEC-007 — инварианты task result RPC.

Gate: пользовательские routes не получают доступ к repositories до закрытия всех P0 проблем.

### P1. Устойчивость локального контура

1. SEC-003 — bounded JSON parser.
2. SEC-008 — обновление dependency tree.
3. SEC-009 — probe access policy и rate limit.
4. SEC-010 — гарантированный R2 cleanup.
5. SEC-012 — generated Env и runtime parity.

Gate: local/test tooling не содержит недокументированных известных high/moderate
уязвимостей.

### P2. До первого non-local deployment

1. SEC-011 — liveness/readiness split и security headers.
2. Повторная проверка client bundle на secrets и source maps.
3. Проверка CSP в контексте Bitrix iframe.

## Команды итоговой проверки

Команды выполняет пользователь после реализации исправлений:

```powershell
bun.cmd audit
bun.cmd run check
bun.cmd run build
bun.cmd run db:docker:reset
bun.cmd run db:docker:test
bun.cmd run db:docker:lint
```

Дополнительно должны выполняться целевые security-тесты, указанные в критериях закрытия
каждой проблемы.

## Ограничения исходного аудита

- Тесты, typecheck, lint, build, форматирование, миграции и runtime smoke tests не запускались.
- Выполнены статический анализ репозитория и `bun.cmd audit`.
- Функциональность незавершённых задач 008–035 не оценивалась как реализованная.
