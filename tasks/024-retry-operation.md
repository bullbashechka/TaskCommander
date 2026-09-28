# 024. Реализовать повторный прогон неуспешных задач

**Этап:** 5. Выполнение, повтор и восстановление

## Цель

Создавать отдельную подтверждаемую операцию для всех неуспешных категорий исходного отчёта.

## Контекст продукта

Повтор включает `Ошибка`, `Результат не подтверждён`, `Конфликт` и `Не обработана`, но не успешные и исключённые проверкой задачи.

## Объём

- Проверить право повтора и доступ к исходной операции.
- Сформировать набор повторного прогона из допустимых статусов.
- Повторить актуальную проверку, preview и подтверждение.
- Связать новый отчёт с исходной операцией.
- Для частично изменённой задачи строить изменения только из неприменённых полей; для уточнённого результата использовать уточнение как эффективный итог.

## Вне объёма

Автоматический бесконечный повтор постоянных ошибок.

## Требования

- Количество ручных повторов не ограничено в течение активного хранения.
- Для чужой операции нужны просмотр всех отчётов и право повтора.

## Критерии приёмки

- Успешные задачи исходной операции не попадают в повтор.
- Изменившиеся права или значения выявляются новой проверкой.
- Повтор требует нового явного подтверждения.
- Новый объект и отчёт содержат ссылку на исходную операцию.

## Зависимости

019–023.

## Implementation and review

Implemented retry selection from the effective source result and encrypted per-task plan, renewed preflight and confirmation, an atomic retry launch linked to its source, and UI navigation back to progress. The retry draft stores only fields selected for execution. Ordinary bulk-edit access can discard a stale retry draft by ID and revision without reading its values. Independent reviews reached 9/10 and 7/10; the two remaining findings were addressed before this commit. Verification remains with the user: `bun run check` and `bun run db:docker:test`. Real Bitrix24 execution remains unverified without a portal.
