import {
  apiErrorResponseSchema,
  bulkOperationDraftAvailabilitySchema,
  bulkOperationDraftSchema,
  preflightPreviewSchema,
  correlationIdSchema,
  effectiveAccessResponseSchema,
  savedTaskFilterListResponseSchema,
  savedTaskFilterSchema,
  sessionResponseSchema,
  saveBulkOperationDraftRequestSchema,
  taskChangeCatalogResponseSchema,
  taskPreflightRequestSchema,
  taskFilterCatalogResponseSchema,
  taskFilterUserSearchResponseSchema,
  taskSearchApiRequestSchema,
  taskSearchApiResponseSchema,
  taskSelectAllApiRequestSchema,
  taskSelectAllApiResponseSchema,
  type ApiErrorCode,
  type BulkOperationDraft,
  type BulkOperationDraftAvailability,
  type PreflightPreview,
  type EffectiveAccessResponse,
  type SavedTaskFilter,
  type SessionPrincipal,
  type SaveBulkOperationDraftRequest,
  type TaskChangeCatalogResponse,
  type TaskPreflightRequest,
  type TaskFilterCatalogResponse,
  type TaskFilterList,
  type TaskFilterUserSearchResponse,
  type TaskSearchApiRequest,
  type TaskSearchApiResponse,
  type TaskSelectAllApiRequest,
  type TaskSelectAllApiResponse,
} from '@task-commander/contracts';

import { notifySecurityContextInvalidated } from '@/app/access-sync';

export type AppApiErrorKind =
  | 'session_required'
  | 'access_denied'
  | 'rate_limited'
  | 'temporary'
  | 'offline'
  | 'invalid_response'
  | 'internal';

export class AppApiError extends Error {
  public constructor(
    message: string,
    public readonly kind: AppApiErrorKind,
    public readonly status?: number,
    public readonly code?: ApiErrorCode,
    public readonly eventId?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const requestTimeoutMs = 5_000;
let terminalSecurityInvalidationPending = false;

type SafeParser<T> = Readonly<{
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
}>;

const manageAccessResponseSchema: SafeParser<{ canManageAccess: true }> = {
  safeParse(value) {
    if (
      typeof value === 'object' &&
      value !== null &&
      (value as { canManageAccess?: unknown }).canManageAccess === true
    ) {
      return { success: true, data: { canManageAccess: true } };
    }
    return { success: false };
  },
};

function errorKind(status: number, code: ApiErrorCode | undefined): AppApiErrorKind {
  if (status === 401 || code === 'UNAUTHENTICATED') return 'session_required';
  if (status === 403 || code === 'FORBIDDEN' || code === 'ACCESS_REVOKED') return 'access_denied';
  if (status === 429 || code === 'RATE_LIMITED') return 'rate_limited';
  if (
    status >= 500 ||
    code === 'UPSTREAM_UNAVAILABLE' ||
    code === 'ACCESS_VERIFICATION_UNAVAILABLE'
  ) {
    return 'temporary';
  }
  return 'internal';
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 30) return seconds * 1_000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const milliseconds = date - Date.now();
    return milliseconds >= 1_000 && milliseconds <= 30_000 ? milliseconds : undefined;
  }
  return undefined;
}

function composeAbortSignal(signal: AbortSignal | undefined): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function request<T>(
  path: string,
  parseSuccess: (payload: unknown, response: Response) => T,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<T> {
  const abort = composeAbortSignal(signal);
  try {
    const headers = new Headers(init?.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    const response = await fetch(path, {
      ...init,
      headers,
      signal: abort.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = apiErrorResponseSchema.safeParse(payload);
      const headerEventId = correlationIdSchema.safeParse(response.headers.get('x-correlation-id'));
      const eventId = parsed.success
        ? parsed.data.error.correlationId
        : headerEventId.success
          ? headerEventId.data
          : undefined;
      const code = parsed.success ? parsed.data.error.code : undefined;
      if (
        !terminalSecurityInvalidationPending &&
        (response.status === 401 || code === 'ACCESS_REVOKED')
      ) {
        terminalSecurityInvalidationPending = true;
        notifySecurityContextInvalidated();
      }
      throw new AppApiError(
        parsed.success
          ? parsed.data.error.message
          : 'Не удалось безопасно обработать ответ сервера.',
        errorKind(response.status, code),
        response.status,
        code,
        eventId,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }
    const result = parseSuccess(payload, response);
    terminalSecurityInvalidationPending = false;
    return result;
  } catch (error) {
    if (error instanceof AppApiError) throw error;
    if (abort.didTimeout()) {
      throw new AppApiError('Время ожидания ответа истекло.', 'temporary');
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new AppApiError('Нет соединения с сетью.', 'offline');
    }
    throw new AppApiError('Не удалось подключиться к серверу.', 'temporary');
  } finally {
    abort.dispose();
  }
}

async function requestJson<T>(
  path: string,
  schema: SafeParser<T>,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<T> {
  return request(
    path,
    (payload, response) => {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        const eventId = correlationIdSchema.safeParse(response.headers.get('x-correlation-id'));
        throw new AppApiError(
          'Сервер вернул неожиданный ответ.',
          'invalid_response',
          response.status,
          undefined,
          eventId.success ? eventId.data : undefined,
        );
      }
      return parsed.data;
    },
    signal,
    init,
  );
}

async function requestEmpty(
  path: string,
  signal: AbortSignal | undefined,
  init: RequestInit,
): Promise<void> {
  await request(
    path,
    (payload, response) => {
      if (response.status !== 204 || payload !== null) {
        const eventId = correlationIdSchema.safeParse(response.headers.get('x-correlation-id'));
        throw new AppApiError(
          'Сервер вернул неожиданный ответ.',
          'invalid_response',
          response.status,
          undefined,
          eventId.success ? eventId.data : undefined,
        );
      }
    },
    signal,
    init,
  );
}

export function fetchSession(signal?: AbortSignal): Promise<SessionPrincipal> {
  return requestJson('/api/session', sessionResponseSchema, signal).then(
    (response) => response.principal,
  );
}

export function fetchEffectiveAccess(signal?: AbortSignal): Promise<EffectiveAccessResponse> {
  return requestJson('/api/access', effectiveAccessResponseSchema, signal);
}

export function createLocalDevSession(signal?: AbortSignal): Promise<void> {
  return requestEmpty('/api/_dev/session', signal, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: '1' }),
  });
}

export async function verifyManageAccess(signal?: AbortSignal): Promise<true> {
  await requestJson('/api/access-management/capabilities', manageAccessResponseSchema, signal);
  return true;
}

const jsonHeaders = { 'content-type': 'application/json' };

export function fetchTaskFilterCatalog(signal?: AbortSignal): Promise<TaskFilterCatalogResponse> {
  return requestJson('/api/tasks/fields', taskFilterCatalogResponseSchema, signal);
}

export function searchTaskFilterUsers(
  input: { q: string; cursor?: string | null; pageSize?: number },
  signal?: AbortSignal,
): Promise<TaskFilterUserSearchResponse> {
  const query = new URLSearchParams({ q: input.q });
  if (input.cursor) query.set('cursor', input.cursor);
  if (input.pageSize) query.set('pageSize', String(input.pageSize));
  return requestJson(
    `/api/tasks/users?${query.toString()}`,
    taskFilterUserSearchResponseSchema,
    signal,
  );
}

export function searchTasks(
  input: TaskSearchApiRequest,
  signal?: AbortSignal,
): Promise<TaskSearchApiResponse> {
  const parsed = taskSearchApiRequestSchema.parse(input);
  return requestJson('/api/tasks/search', taskSearchApiResponseSchema, signal, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(parsed),
  });
}

export function selectAllTasks(
  input: TaskSelectAllApiRequest,
  signal?: AbortSignal,
): Promise<TaskSelectAllApiResponse> {
  const parsed = taskSelectAllApiRequestSchema.parse(input);
  return requestJson('/api/tasks/select-all', taskSelectAllApiResponseSchema, signal, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(parsed),
  });
}

export function fetchTaskChangeCatalog(signal?: AbortSignal): Promise<TaskChangeCatalogResponse> {
  return requestJson('/api/tasks/change-fields', taskChangeCatalogResponseSchema, signal);
}

export function getBulkOperationDraft(
  signal?: AbortSignal,
): Promise<BulkOperationDraftAvailability> {
  return requestJson('/api/tasks/draft', bulkOperationDraftAvailabilitySchema, signal);
}

export function saveBulkOperationDraft(
  input: SaveBulkOperationDraftRequest,
  signal?: AbortSignal,
): Promise<BulkOperationDraft> {
  const parsed = saveBulkOperationDraftRequestSchema.parse(input);
  return requestJson('/api/tasks/draft', bulkOperationDraftSchema, signal, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(parsed),
  });
}

export function createTaskPreflight(
  input: TaskPreflightRequest,
  signal?: AbortSignal,
): Promise<PreflightPreview> {
  const parsed = taskPreflightRequestSchema.parse(input);
  return requestJson('/api/tasks/preflight', preflightPreviewSchema, signal, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(parsed),
  });
}

export function listSavedTaskFilters(signal?: AbortSignal): Promise<SavedTaskFilter[]> {
  return requestJson('/api/tasks/saved-filters', savedTaskFilterListResponseSchema, signal).then(
    (response) => response.items,
  );
}

export function createSavedTaskFilter(
  input: { name: string; filters: TaskFilterList },
  signal?: AbortSignal,
): Promise<SavedTaskFilter> {
  return requestJson('/api/tasks/saved-filters', savedTaskFilterSchema, signal, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
}

export function updateSavedTaskFilter(
  input: SavedTaskFilter,
  signal?: AbortSignal,
): Promise<SavedTaskFilter> {
  return requestJson(`/api/tasks/saved-filters/${input.id}`, savedTaskFilterSchema, signal, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({
      name: input.name,
      expectedRevision: input.revision,
    }),
  });
}

export function deleteSavedTaskFilter(
  input: Pick<SavedTaskFilter, 'id' | 'revision'>,
  signal?: AbortSignal,
): Promise<void> {
  return requestEmpty(`/api/tasks/saved-filters/${input.id}`, signal, {
    method: 'DELETE',
    headers: jsonHeaders,
    body: JSON.stringify({ expectedRevision: input.revision }),
  });
}

export function isRetryableAppError(error: unknown): error is AppApiError {
  return (
    error instanceof AppApiError && (error.kind === 'rate_limited' || error.kind === 'temporary')
  );
}
