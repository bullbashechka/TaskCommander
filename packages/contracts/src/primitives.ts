import { z } from 'zod';

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const correlationIdSchema = z
  .string()
  .regex(/^TC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

export const bitrixIdSchema = z.string().regex(/^\d+$/).min(1).max(32);

export const fieldIdSchema = z.string().trim().min(1).max(128);

function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      (url.port === '' || url.port === '443')
    );
  } catch {
    return false;
  }
}

export const safeHttpsUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .refine(isSafeHttpsUrl, { message: 'Expected a safe HTTPS URL.' });

export const operationIdSchema = z.string().uuid();

export const draftIdSchema = z.string().uuid();

export const messageIdSchema = z.string().uuid();

export const nonNegativeIntegerSchema = z.number().int().nonnegative();

export const positiveIntegerSchema = z.number().int().positive();
