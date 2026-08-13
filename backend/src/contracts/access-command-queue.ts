import { z } from 'zod';

export const ACCESS_COMMAND_QUEUE_SCHEMA_VERSION = 1;
export const ACCESS_COMMAND_QUEUE_KIND = 'access.command.execute';

export const accessCommandQueueMessageSchema = z
  .object({
    schemaVersion: z.literal(ACCESS_COMMAND_QUEUE_SCHEMA_VERSION),
    messageId: z.string().uuid(),
    kind: z.literal(ACCESS_COMMAND_QUEUE_KIND),
    portalId: z.string().trim().min(1).max(128),
    commandId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type AccessCommandQueueMessage = z.infer<typeof accessCommandQueueMessageSchema>;

export function createAccessCommandQueueMessage(input: {
  portalId: string;
  commandId: string;
  now?: Date;
}): AccessCommandQueueMessage {
  return accessCommandQueueMessageSchema.parse({
    schemaVersion: ACCESS_COMMAND_QUEUE_SCHEMA_VERSION,
    messageId: crypto.randomUUID(),
    kind: ACCESS_COMMAND_QUEUE_KIND,
    portalId: input.portalId,
    commandId: input.commandId,
    createdAt: (input.now ?? new Date()).toISOString(),
  });
}
