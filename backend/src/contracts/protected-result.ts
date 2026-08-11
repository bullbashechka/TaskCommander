import { bitrixIdSchema, fieldIdSchema, operationIdSchema } from '@task-commander/contracts';
import { z } from 'zod';

export const protectedTaskResultSchema = z
  .object({
    operationId: operationIdSchema,
    taskId: bitrixIdSchema,
    previousValues: z.record(fieldIdSchema, z.unknown()),
    beforeVersion: z.string().trim().min(1).max(256),
    afterVersion: z.string().trim().min(1).max(256).nullable(),
  })
  .strict();

export type ProtectedTaskResult = z.infer<typeof protectedTaskResultSchema>;
