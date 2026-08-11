import { operationIdSchema } from '@task-commander/contracts';
import { z } from 'zod';

export const OPERATION_QUEUE_SCHEMA_VERSION = 1;
export const OPERATION_QUEUE_KIND = 'operation.execute';

export const operationQueueMessageSchema = z
  .object({
    schemaVersion: z.literal(OPERATION_QUEUE_SCHEMA_VERSION),
    messageId: z.string().uuid(),
    kind: z.literal(OPERATION_QUEUE_KIND),
    operationId: operationIdSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type OperationQueueMessage = z.infer<typeof operationQueueMessageSchema>;

export function createOperationQueueMessage(operationId: string): OperationQueueMessage {
  return operationQueueMessageSchema.parse({
    schemaVersion: OPERATION_QUEUE_SCHEMA_VERSION,
    messageId: crypto.randomUUID(),
    kind: OPERATION_QUEUE_KIND,
    operationId,
    createdAt: new Date().toISOString(),
  });
}
