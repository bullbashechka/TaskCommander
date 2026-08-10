import { normalize, relative, resolve } from 'node:path';

export const localRuntimeStateRelativePath = normalize('.wrangler/state/task-commander-local');

export interface LocalRuntimeStateFileSystem {
  removeDirectory(path: string): Promise<void>;
}

export function resolveLocalRuntimeStatePath(repositoryRoot: string): string {
  return resolve(repositoryRoot, localRuntimeStateRelativePath);
}

export function assertLocalRuntimeStatePath(repositoryRoot: string, candidatePath: string): void {
  const expectedPath = resolveLocalRuntimeStatePath(repositoryRoot);
  const resolvedCandidatePath = resolve(candidatePath);

  if (
    resolvedCandidatePath !== expectedPath ||
    relative(resolve(repositoryRoot), resolvedCandidatePath) !== localRuntimeStateRelativePath
  ) {
    throw new Error(
      'Refusing to reset a path outside the dedicated local runtime state directory.',
    );
  }
}

export async function resetLocalRuntimeState(
  repositoryRoot: string,
  fileSystem: LocalRuntimeStateFileSystem,
): Promise<string> {
  const statePath = resolveLocalRuntimeStatePath(repositoryRoot);
  assertLocalRuntimeStatePath(repositoryRoot, statePath);
  await fileSystem.removeDirectory(statePath);
  return statePath;
}
