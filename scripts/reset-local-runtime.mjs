import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { resetLocalRuntimeState } from '../backend/src/runtime/local-state.ts';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const statePath = await resetLocalRuntimeState(repositoryRoot, {
  removeDirectory: (path) => rm(path, { recursive: true, force: true }),
});

stdout.write(`Reset local runtime state: ${statePath}\n`);
