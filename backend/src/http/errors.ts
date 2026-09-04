import { type ApiErrorCode, type ApiErrorResponse } from '@task-commander/contracts';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export interface ApiFieldError {
  path: string;
  code: string;
  message: string;
}

const safeMessages: Record<ApiErrorCode, string> = {
  INVALID_REQUEST: 'Некорректный запрос.',
  UNAUTHENTICATED: 'Требуется авторизация.',
  FORBIDDEN: 'Недостаточно прав для выполнения действия.',
  ACCESS_REVOKED: 'Доступ к Task Commander закрыт.',
  ACCESS_VERIFICATION_UNAVAILABLE: 'Не удалось проверить доступ. Повторите попытку позже.',
  NOT_FOUND: 'Маршрут API не найден.',
  CONFLICT: 'Данные изменились. Обновите страницу и повторите действие.',
  SAVED_FILTER_LIMIT: 'Достигнут лимит личных наборов фильтров.',
  SAVED_FILTER_NAME_TAKEN: 'Личный набор с таким именем уже существует.',
  RATE_LIMITED: 'Слишком много запросов. Повторите попытку позже.',
  UPSTREAM_UNAVAILABLE: 'Внешний сервис временно недоступен.',
  INTERNAL_ERROR: 'Внутренняя ошибка API.',
};

export class ApiHttpError extends Error {
  public constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: ApiErrorCode,
    public readonly fieldErrors?: ApiFieldError[],
  ) {
    super(code);
  }
}

export function createApiErrorResponse(
  code: ApiErrorCode,
  correlationId: string,
  fieldErrors?: ApiFieldError[],
): ApiErrorResponse {
  return {
    error: {
      code,
      message: safeMessages[code],
      correlationId,
      ...(fieldErrors && fieldErrors.length > 0 ? { fieldErrors } : {}),
    },
  };
}
