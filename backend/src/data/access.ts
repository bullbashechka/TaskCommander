import { bitrixIdSchema, permissionSchema, type Permission } from '@task-commander/contracts';
import { z } from 'zod';

import { DataAccessError } from './errors';

const dataAccessContextSchema = z
  .object({
    portalId: z.string().trim().min(1).max(128),
    actorId: bitrixIdSchema,
    permissions: z.array(permissionSchema).max(10),
  })
  .strict();

export interface DataAccessContext {
  portalId: string;
  actorId: string;
  permissions: readonly Permission[];
}

export function createDataAccessContext(value: unknown): DataAccessContext {
  const parsed = dataAccessContextSchema.parse(value);
  return {
    portalId: parsed.portalId,
    actorId: parsed.actorId,
    permissions: [...new Set(parsed.permissions)],
  };
}

export function hasPermission(context: DataAccessContext, permission: Permission): boolean {
  return context.permissions.includes(permission);
}

export function requirePermission(context: DataAccessContext, permission: Permission): void {
  if (!hasPermission(context, permission)) {
    throw new DataAccessError('UNAVAILABLE_RECORD', false);
  }
}
