# Решения реализации: задача 009

Дата: 2026-08-12
Статус: утверждено
Текущая задача: **009. Реализовать запуск и идентификацию через Битрикс24**.

## Контракт сессии

1. Единственный endpoint — `/api/session`: `POST` создаёт сессию, `GET` возвращает только
   безопасный principal, `DELETE` очищает cookie. Альтернативный `/api/auth/session` не
   вводится, чтобы API оставался компактным.
2. `POST` принимает bounded strict JSON `{ launchContext: string }`. Launch context —
   компактный HMAC-SHA-256 token adapter-specific mock-контура с claims `v`, `aud`,
   `portalId`, `userId`, `iat`, `exp`, `nonce`. Проверяются алгоритм, подпись, структура,
   аудитория, версия, canonical base64url и точный короткий TTL.
   Это короткоживущий bearer token: его можно повторно использовать до истечения TTL. `nonce`
   обеспечивает уникальность и корреляцию, но не является atomic anti-replay механизмом.
3. Mock launch secret и secret подписи session cookie независимы и имеют минимум 32 UTF-8
   байта. Значения не попадают в API-ответы, логи, browser storage или тестовые snapshots.
4. Каждая новая сессия после проверки token заново получает текущего пользователя из mock
   adapter. Совпадают user ID context и adapter, inactive user получает 403, отсутствующий
   пользователь и несовпадение identity получают 401. Признак администратора попадает в
   safe principal, но права из задачи 010 не вычисляются.
5. Cookie stateless, подписана и содержит только `v`, `aud`, `sessionId`, `portalId`,
   `userId`, `displayName`, `isBitrixAdmin`, `iat`, `exp`. OAuth-токены и permissions не
   сохраняются. Новый login всегда создаёт новый `sessionId`.

## Границы локального режима

- Cookie ограничена `/api`, `HttpOnly`, `Secure`, `SameSite=Lax` и 15 минутами. Это
  намеренно локальная mock-политика; production iframe/OAuth/cross-site policy будет выбрана
  в задаче 035.
- Single-use launch state, CSRF и production replay policy относятся к задаче 035. Local mock
  контур не создаёт persistent storage, migrations или Durable Objects для этих задач.
- Ошибки контекста и cookie возвращают безопасный 401, inactive user — 403, rate limit —
  429, временная ошибка adapter — 503. Adapter reason code и retry details не раскрываются.
  Сырые token, cookie и secrets не логируются.
- Изменение secret bindings в `wrangler.jsonc` требует `bun run cf-typegen`. Generated
  `backend/worker-configuration.d.ts` не редактируется вручную.
