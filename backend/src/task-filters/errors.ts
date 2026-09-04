import type { BitrixFailure } from '../integrations/bitrix/contract';
import { DataAccessError } from '../data/errors';
import { ApiHttpError } from '../http/errors';

export function toTaskFilterBitrixApiError(failure: BitrixFailure): ApiHttpError {
  switch (failure.kind) {
    case 'not_authenticated':
      return new ApiHttpError(401, 'UNAUTHENTICATED');
    case 'permission_denied':
    case 'not_found_or_forbidden':
      return new ApiHttpError(403, 'FORBIDDEN');
    case 'rate_limited':
      return new ApiHttpError(429, 'RATE_LIMITED');
    case 'temporary_failure':
    case 'permanent_failure':
    case 'invalid_external_response':
    case 'unsupported_capability':
      return new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
  }
}

export function throwTaskFilterDataApiError(error: unknown): never {
  if (error instanceof DataAccessError) {
    if (error.code === 'CONFLICT') throw new ApiHttpError(409, 'CONFLICT');
    if (error.code === 'SAVED_FILTER_LIMIT') {
      throw new ApiHttpError(409, 'SAVED_FILTER_LIMIT');
    }
    if (error.code === 'SAVED_FILTER_NAME_TAKEN') {
      throw new ApiHttpError(409, 'SAVED_FILTER_NAME_TAKEN');
    }
    if (error.code === 'UNAVAILABLE_RECORD') throw new ApiHttpError(404, 'NOT_FOUND');
    if (error.code === 'RATE_LIMITED') throw new ApiHttpError(429, 'RATE_LIMITED');
  }
  throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
}
