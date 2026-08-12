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

async function readBoundedRequestText(request: Request, maximumBytes: number): Promise<string> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      throw new ApiHttpError(400, 'INVALID_REQUEST');
    }
  }

  if (!request.body) {
    return '';
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;

      receivedBytes += next.value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel();
        throw new ApiHttpError(400, 'INVALID_REQUEST');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new ApiHttpError(400, 'INVALID_REQUEST');
  }
}

export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maximumBytes = 65_536,
): Promise<T> {
  let value: unknown = {};

  try {
    const text = await readBoundedRequestText(request, maximumBytes);
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
