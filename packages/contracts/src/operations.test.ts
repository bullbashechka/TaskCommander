import { describe, expect, it } from 'vitest';

import {
  preflightPreviewSchema,
  retryTaskIntentSchema,
  taskPreflightRequestSchema,
} from './operations';

describe('retry intent contract', () => {
  it('preserves field 64 without a numeric bit mask', () => {
    const targetValues = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`field_${index + 1}`, `target_${index + 1}`]),
    );
    const intent = retryTaskIntentSchema.parse({ taskId: '42', targetValues });
    expect(intent.targetValues.field_64).toBe('target_64');
    expect(
      retryTaskIntentSchema.safeParse({
        taskId: '42',
        targetValues: {
          ...targetValues,
          field_65: 'too many',
        },
      }).success,
    ).toBe(false);
  });
});

const eligibleEntry = {
  taskId: '42',
  title: 'Task',
  taskUrl: 'https://example.test/tasks/42',
  disposition: 'eligible' as const,
  changedFieldIds: ['title'],
  reasonCode: null,
  reasonMessage: null,
  relevantVersion: 'version-1',
  currentValues: { title: 'Before' },
  targetValues: { title: 'After' },
};

const summary = {
  selected: 1,
  eligible: 1,
  excluded: 0,
  unchanged: 0,
  successful: 0,
  failed: 0,
  unconfirmed: 0,
  conflicted: 0,
  partiallyApplied: 0,
  notProcessed: 0,
};

describe('task preflight contracts', () => {
  it('accepts only a draft and positive expected revision as input', () => {
    expect(
      taskPreflightRequestSchema.parse({
        draftId: '123e4567-e89b-42d3-a456-426614174000',
        expectedRevision: 3,
      }),
    ).toEqual({
      draftId: '123e4567-e89b-42d3-a456-426614174000',
      expectedRevision: 3,
    });
    expect(
      taskPreflightRequestSchema.safeParse({
        draftId: '123e4567-e89b-42d3-a456-426614174000',
        expectedRevision: 3,
        selectedTaskIds: ['99'],
      }).success,
    ).toBe(false);
  });

  it('binds values, revision, access version, and summary to exact entries', () => {
    const preview = {
      draftId: '123e4567-e89b-42d3-a456-426614174000',
      sourceDraftRevision: 2,
      draftRevision: 3,
      actorAccessVersion: 7,
      checkedAt: '2026-09-04T10:00:00Z',
      canProceed: true,
      entries: [eligibleEntry],
      summary,
    };

    expect(preflightPreviewSchema.parse(preview)).toEqual(preview);
    expect(preflightPreviewSchema.safeParse({ ...preview, canProceed: false }).success).toBe(false);
    expect(
      preflightPreviewSchema.safeParse({
        ...preview,
        entries: [eligibleEntry, eligibleEntry],
        summary: { ...summary, selected: 2, eligible: 2 },
      }).success,
    ).toBe(false);
  });

  it('rejects contradictory eligible, excluded, and no-change entries', () => {
    const preview = {
      draftId: '123e4567-e89b-42d3-a456-426614174000',
      sourceDraftRevision: 2,
      draftRevision: 3,
      actorAccessVersion: null,
      checkedAt: '2026-09-04T10:00:00Z',
      canProceed: true,
      entries: [{ ...eligibleEntry, changedFieldIds: [] }],
      summary,
    };
    expect(preflightPreviewSchema.safeParse(preview).success).toBe(false);
    expect(
      preflightPreviewSchema.safeParse({
        ...preview,
        entries: [
          {
            ...eligibleEntry,
            changedFieldIds: ['title', 'title'],
            currentValues: { title: 'Before' },
            targetValues: { description: 'After' },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
