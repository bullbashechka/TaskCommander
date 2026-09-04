import { z } from 'zod';

import { correlationIdSchema } from './primitives';

export const apiErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'ACCESS_REVOKED',
  'ACCESS_VERIFICATION_UNAVAILABLE',
  'NOT_FOUND',
  'CONFLICT',
  'SAVED_FILTER_LIMIT',
  'SAVED_FILTER_NAME_TAKEN',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiFieldErrorSchema = z
  .object({
    path: z.string().trim().min(1).max(512),
    code: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(512),
  })
  .strict();

export const apiErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: apiErrorCodeSchema,
        message: z.string().trim().min(1).max(512),
        correlationId: correlationIdSchema,
        fieldErrors: z.array(apiFieldErrorSchema).max(100).optional(),
      })
      .strict(),
  })
  .strict();

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
