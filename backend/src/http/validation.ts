import { z } from 'zod';

import { ApiHttpError, type ApiFieldError } from './errors';

function toFieldErrors(error: z.ZodError): ApiFieldError[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        path: key,
        code: 'unrecognized_key',
        message: 'Поле не поддерживается.',
      }));
    }

    return [
      {
        path: issue.path.map(String).join('.') || '$',
        code: issue.code,
        message: 'Некорректное значение.',
      },
    ];
  });
}

export async function parseJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let value: unknown = {};

  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      value = JSON.parse(text) as unknown;
    }
  } catch {
    throw new ApiHttpError(400, 'INVALID_REQUEST', [
      {
        path: '$',
        code: 'invalid_json',
        message: 'Некорректный JSON.',
      },
    ]);
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiHttpError(400, 'INVALID_REQUEST', toFieldErrors(parsed.error));
  }

  return parsed.data;
}
