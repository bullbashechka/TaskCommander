import { describe, expect, it } from 'vitest';

import { createMockDisk } from '../src/integrations/bitrix/mock/disk';
import { createMockNotifications } from '../src/integrations/bitrix/mock/notifications';
import { createMockScenario } from '../src/integrations/bitrix/mock/scenario';
import { createMockPortalState } from '../src/integrations/bitrix/mock/state';

const operationId = '123e4567-e89b-42d3-a456-426614174000';

function expectSuccess<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('Expected a successful mock result.');
  return result.value;
}

describe('mock Bitrix delivery services', () => {
  it('deduplicates operation notifications by recipient and stable key', async () => {
    const state = createMockPortalState();
    const notifications = createMockNotifications(state);
    const request = {
      recipientId: '10',
      deduplicationKey: `operation:${operationId}:completed`,
      message: 'Operation completed.',
      operationUrl: `https://task-commander.example.test/operations/${operationId}`,
    };

    const first = expectSuccess(await notifications.sendOnce(request));
    const second = expectSuccess(await notifications.sendOnce(request));

    expect(second.id).toBe(first.id);
    expect(state.notifications).toHaveLength(1);
  });

  it('returns an existing report after a save succeeded but its response was lost', async () => {
    const state = createMockPortalState();
    const disk = createMockDisk(
      state,
      createMockScenario([
        { method: 'disk.putReportOnce', effect: { kind: 'save_file_then_drop_response' } },
      ]),
    );
    const request = {
      operationId,
      format: 'xlsx' as const,
      fileName: '2026-08-10-operation-123e4567.xlsx',
      content: new Uint8Array([1, 2, 3]),
      contentHash: 'sha256:fixture',
      access: [{ principal: 'user' as const, id: '10', level: 'read' as const }],
    };

    await expect(disk.putReportOnce(request)).resolves.toEqual({
      ok: false,
      failure: { kind: 'temporary_failure', reasonCode: 'disk_write_response_lost' },
    });

    const file = expectSuccess(await disk.putReportOnce(request));
    expect(file.folder).toBe('active');
    await expect(disk.archiveReport(file.id)).resolves.toEqual({
      ok: true,
      value: { ...file, folder: 'archive' },
    });
    await expect(disk.deleteReport(file.id)).resolves.toEqual({
      ok: true,
      value: { deleted: true },
    });
    await expect(disk.deleteReport(file.id)).resolves.toEqual({
      ok: true,
      value: { deleted: false },
    });
  });
});
