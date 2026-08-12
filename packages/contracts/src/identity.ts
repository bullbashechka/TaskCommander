import { z } from 'zod';

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

export const permissionSchema = z.enum([
  'app_access',
  'run_bulk_operations',
  'change_allowed_fields',
  'retry_operations',
  'restore_operations',
  'view_own_reports',
  'view_all_reports',
  'export_reports',
  'view_audit',
  'manage_access',
]);

export type Permission = z.infer<typeof permissionSchema>;

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
    permissions: z.array(permissionSchema).max(10),
    allowedFieldIds: z.array(fieldIdSchema).max(256),
    grantedAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    grantedByUserId: bitrixIdSchema.nullable(),
  })
  .strict();

export type UserAccess = z.infer<typeof userAccessSchema>;
