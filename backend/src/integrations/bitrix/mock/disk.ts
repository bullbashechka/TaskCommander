import type { BitrixDisk, BitrixDiskFile, BitrixFailure } from '../contract';
import type { MockScenarioController, MockScenarioEffect } from './scenario';
import type { MockDiskRecord, MockPortalState } from './state';

function getFailure(effects: readonly MockScenarioEffect[]): BitrixFailure | null {
  const effect = effects.find((candidate) => candidate.kind === 'return_failure');
  return effect?.kind === 'return_failure' ? effect.failure : null;
}

function toDiskFile(record: MockDiskRecord): BitrixDiskFile {
  return {
    id: record.id,
    operationId: record.operationId,
    format: record.format,
    name: record.name,
    url: record.url,
    folder: record.folder,
    contentHash: record.contentHash,
    access: record.access.map((grant) => ({ ...grant })),
  };
}

function operationFormatKey(operationId: string, format: 'xlsx' | 'csv'): string {
  return `${operationId}:${format}`;
}

export function createMockDisk(
  state: MockPortalState,
  scenario: MockScenarioController = { take: () => [] },
): BitrixDisk {
  return {
    async putReportOnce(request) {
      const effects = scenario.take('disk.putReportOnce', request.operationId);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };

      const key = operationFormatKey(request.operationId, request.format);
      const existingId = state.diskRecordIdsByOperationFormat.get(key);
      const existing = existingId ? state.diskRecords.get(existingId) : undefined;
      if (existing && !existing.deleted) {
        if (existing.contentHash !== request.contentHash) {
          return {
            ok: false,
            failure: {
              kind: 'permanent_failure',
              reasonCode: 'report_idempotency_conflict',
              fieldIds: [],
            },
          };
        }
        return { ok: true, value: toDiskFile(existing) };
      }

      state.diskFolders.add('active');
      const id = String(state.nextDiskRecordId);
      state.nextDiskRecordId += 1;
      const record: MockDiskRecord = {
        id,
        operationId: request.operationId,
        format: request.format,
        name: request.fileName,
        url: `https://portal.bitrix24.ru/disk/file/${id}/`,
        folder: 'active',
        contentHash: request.contentHash,
        access: request.access.map((grant) => ({ ...grant })),
        content: new Uint8Array(request.content),
        deleted: false,
      };
      state.diskRecords.set(id, record);
      state.diskRecordIdsByOperationFormat.set(key, id);

      if (effects.some((effect) => effect.kind === 'save_file_then_drop_response')) {
        return {
          ok: false,
          failure: { kind: 'temporary_failure', reasonCode: 'disk_write_response_lost' },
        };
      }

      return { ok: true, value: toDiskFile(record) };
    },
    async getReport(fileId) {
      const effects = scenario.take('disk.getReport', fileId);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };

      const record = state.diskRecords.get(fileId);
      if (!record || record.deleted) {
        return { ok: false, failure: { kind: 'not_found_or_forbidden' } };
      }
      return {
        ok: true,
        value: { file: toDiskFile(record), content: new Uint8Array(record.content) },
      };
    },
    async archiveReport(fileId) {
      const effects = scenario.take('disk.archiveReport', fileId);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };

      const record = state.diskRecords.get(fileId);
      if (!record || record.deleted) {
        return { ok: false, failure: { kind: 'not_found_or_forbidden' } };
      }
      state.diskFolders.add('archive');
      record.folder = 'archive';
      return { ok: true, value: toDiskFile(record) };
    },
    async deleteReport(fileId) {
      const effects = scenario.take('disk.deleteReport', fileId);
      const failure = getFailure(effects);
      if (failure) return { ok: false, failure };

      const record = state.diskRecords.get(fileId);
      if (!record || record.deleted) return { ok: true, value: { deleted: false } };
      record.deleted = true;
      return { ok: true, value: { deleted: true } };
    },
  };
}
