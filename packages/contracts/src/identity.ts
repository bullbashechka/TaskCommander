import { z } from 'zod';

import { permissionSchema } from './access';
import { bitrixIdSchema, fieldIdSchema, isoDateTimeSchema } from './primitives';

export const portalIdSchema = z.string().trim().min(1).max(128);

export const createSessionRequestSchema = z
  .object({
    launchContext: z.string().trim().min(1).max(4_096),
  })
  .strict();

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const sessionPrincipalSchema = z
  .object({
    portalId: portalIdSchema,
    userId: bitrixIdSchema,
    displayName: z.string().trim().min(1).max(256),
    isBitrixAdmin: z.boolean(),
  })
  .strict();

export type SessionPrincipal = z.infer<typeof sessionPrincipalSchema>;

export const sessionResponseSchema = z.object({ principal: sessionPrincipalSchema }).strict();

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const userSummarySchema = z
  .object({
    id: bitrixIdSchema,
    displayName: z.string().trim().min(1).max(256),
    isActive: z.boolean(),
  })
  .strict();

export type UserSummary = z.infer<typeof userSummarySchema>;

export const userAccessSchema = z
  .object({
    user: userSummarySchema,
    permissions: z
      .array(permissionSchema)
      .max(10)
      .refine((permissions) => new Set(permissions).size === permissions.length),
    allowedFieldIds: z
      .array(fieldIdSchema)
      .max(256)
      .refine((fieldIds) => new Set(fieldIds).size === fieldIds.length),
    grantedAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    grantedByUserId: bitrixIdSchema.nullable(),
  })
  .strict();

export type UserAccess = z.infer<typeof userAccessSchema>;
