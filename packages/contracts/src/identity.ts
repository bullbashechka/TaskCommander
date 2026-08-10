import { z } from 'zod';

import { bitrixIdSchema, fieldIdSchema, isoDateTimeSchema } from './primitives';

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
