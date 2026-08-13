import { z } from 'zod';

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const correlationIdSchema = z
  .string()
  .regex(/^TC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

export const bitrixIdSchema = z.string().regex(/^\d+$/).min(1).max(32);

export const fieldIdSchema = z.string().trim().min(1).max(128);

export const operationIdSchema = z.string().uuid();

export const draftIdSchema = z.string().uuid();

export const messageIdSchema = z.string().uuid();

export const nonNegativeIntegerSchema = z.number().int().nonnegative();

export const positiveIntegerSchema = z.number().int().positive();
