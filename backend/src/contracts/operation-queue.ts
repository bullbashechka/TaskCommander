import { operationIdSchema, portalIdSchema } from '@task-commander/contracts';
import { z } from 'zod';

export const OPERATION_QUEUE_SCHEMA_VERSION = 1;
export const OPERATION_QUEUE_KIND = 'operation.execute';

export const operationQueueMessageSchema = z
  .object({
    schemaVersion: z.literal(OPERATION_QUEUE_SCHEMA_VERSION),
    messageId: z.string().uuid(),
    kind: z.literal(OPERATION_QUEUE_KIND),
    portalId: portalIdSchema,
    operationId: operationIdSchema,
    launchAttempt: z.number().int().positive(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type OperationQueueMessage = z.infer<typeof operationQueueMessageSchema>;

export function createOperationQueueMessage(input: {
  portalId: string;
  operationId: string;
  launchAttempt: number;
  messageId: string;
  createdAt: string;
}): OperationQueueMessage {
  return operationQueueMessageSchema.parse({
    schemaVersion: OPERATION_QUEUE_SCHEMA_VERSION,
    messageId: input.messageId,
    kind: OPERATION_QUEUE_KIND,
    portalId: input.portalId,
    operationId: input.operationId,
    launchAttempt: input.launchAttempt,
    createdAt: input.createdAt,
  });
}
