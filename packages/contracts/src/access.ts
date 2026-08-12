import { z } from 'zod';

import { fieldIdSchema } from './primitives';

export const appPermissions = Object.freeze([
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
] as const);

export const permissionSchema = z.enum(appPermissions);

export type Permission = z.infer<typeof permissionSchema>;

const uniquePermissionsSchema = z
  .array(permissionSchema)
  .max(appPermissions.length)
  .refine((permissions) => new Set(permissions).size === permissions.length, {
    message: 'Permissions must be unique.',
  });

const uniqueFieldIdsSchema = z
  .array(fieldIdSchema)
  .max(256)
  .refine((fieldIds) => new Set(fieldIds).size === fieldIds.length, {
    message: 'Field IDs must be unique.',
  });

export const fieldScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z
    .object({
      kind: z.literal('subset'),
      fieldIds: uniqueFieldIdsSchema,
    })
    .strict(),
]);

export type FieldScope = z.infer<typeof fieldScopeSchema>;

export const effectiveAccessResponseSchema = z
  .object({
    permissions: uniquePermissionsSchema,
    fieldScope: fieldScopeSchema,
  })
  .strict();

export type EffectiveAccessResponse = z.infer<typeof effectiveAccessResponseSchema>;
