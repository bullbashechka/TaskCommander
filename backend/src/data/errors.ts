export type DataAccessErrorCode =
  | 'CONFIGURATION'
  | 'UNAVAILABLE'
  | 'CONFLICT'
  | 'SAVED_FILTER_LIMIT'
  | 'SAVED_FILTER_NAME_TAKEN'
  | 'UNAVAILABLE_RECORD'
  | 'INTEGRITY'
  | 'ACTIVE_OPERATION'
  | 'IDEMPOTENCY_MISMATCH'
  | 'TASK_RESULT_MISMATCH'
  | 'INVALID_OPERATION_STATE'
  | 'RATE_LIMITED';

export class DataAccessError extends Error {
  public constructor(
    public readonly code: DataAccessErrorCode,
    public readonly retryable: boolean,
  ) {
    super(code);
  }
}

export function toDataAccessError(error: unknown): DataAccessError {
  if (error instanceof DataAccessError) {
    return error;
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    const message = typeof candidate.message === 'string' ? candidate.message : '';

    if (code === 'P0001' && message.startsWith('TC_ACCESS_RATE_LIMITED')) {
      return new DataAccessError('RATE_LIMITED', true);
    }

    if (code === 'P0001' && message.startsWith('TC_SAVED_FILTER_LIMIT')) {
      return new DataAccessError('SAVED_FILTER_LIMIT', false);
    }

    if (code === '23505' && message.includes('saved_filter_owner_name_key')) {
      return new DataAccessError('SAVED_FILTER_NAME_TAKEN', false);
    }

    if (code === 'P0001' && message.startsWith('TC_AUDIT_EVENT_CONFLICT')) {
      return new DataAccessError('INTEGRITY', false);
    }

    if (code === 'P0001' && message.startsWith('TC_OPERATION_UNAVAILABLE')) {
      return new DataAccessError('UNAVAILABLE_RECORD', false);
    }

    if (code === 'P0001' || code === '23505' || code === '40001' || code === 'PGRST116') {
      return new DataAccessError('CONFLICT', false);
    }

    if (code.startsWith('08') || code === '53300' || code === '57P01') {
      return new DataAccessError('UNAVAILABLE', true);
    }

    if (code.startsWith('23')) {
      return new DataAccessError('INTEGRITY', false);
    }
  }

  return new DataAccessError('UNAVAILABLE', true);
}
