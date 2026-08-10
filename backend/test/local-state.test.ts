import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertLocalRuntimeStatePath,
  resetLocalRuntimeState,
  resolveLocalRuntimeStatePath,
} from '../src/runtime/local-state';

const repositoryRoot = 'C:/workspace/task-commander';
const expectedStatePath = resolve(repositoryRoot, '.wrangler', 'state', 'task-commander-local');

describe('local runtime state reset', () => {
  it('resolves only the dedicated Task Commander state directory', () => {
    expect(resolveLocalRuntimeStatePath(repositoryRoot)).toBe(expectedStatePath);
    expect(() =>
      assertLocalRuntimeStatePath(repositoryRoot, 'C:/workspace/task-commander/.wrangler/state'),
    ).toThrow('Refusing to reset a path outside the dedicated local runtime state directory.');
    expect(() =>
      assertLocalRuntimeStatePath(
        repositoryRoot,
        'C:/workspace/task-commander/.wrangler/state/task-commander-other',
      ),
    ).toThrow('Refusing to reset a path outside the dedicated local runtime state directory.');
  });

  it('passes only the dedicated state directory to the deletion boundary', async () => {
    const removedPaths: string[] = [];

    await resetLocalRuntimeState(repositoryRoot, {
      removeDirectory: async (path) => {
        removedPaths.push(path);
      },
    });

    expect(removedPaths).toEqual([expectedStatePath]);
  });

  it('allows the exact state directory to be absent', async () => {
    await expect(
      resetLocalRuntimeState(repositoryRoot, {
        removeDirectory: async () => undefined,
      }),
    ).resolves.toBe(expectedStatePath);
  });
});
