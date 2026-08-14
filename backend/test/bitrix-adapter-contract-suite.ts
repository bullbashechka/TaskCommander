import { expect } from 'vitest';

import type { BitrixAdapter, BitrixResult } from '../src/integrations/bitrix/contract';

function expectSuccess<T>(result: BitrixResult<T>): T {
  if (!result.ok) {
    throw new Error(`Expected a successful adapter result, received ${result.failure.kind}.`);
  }

  return result.value;
}

export async function expectBitrixAdapterContract(adapter: BitrixAdapter): Promise<void> {
  const capabilities = expectSuccess(await adapter.tasks.getFieldCapabilities());
  expect(capabilities).not.toHaveLength(0);

  const page = expectSuccess(
    await adapter.tasks.search({
      filters: [],
      sort: { fieldId: 'deadline', direction: 'asc' },
      page: 1,
      pageSize: 1,
    }),
  );
  expect(page.items).toHaveLength(1);

  const task = page.items[0];
  if (!task) {
    throw new Error('The adapter returned an empty first task page.');
  }
  const snapshot = expectSuccess(
    await adapter.tasks.readForChange({ taskId: task.id, fieldIds: ['deadline'] }),
  );
  expect(snapshot.relevantVersion).not.toBe('');

  expectSuccess(await adapter.users.getCurrent());
  expectSuccess(await adapter.users.getByIds(['10']));
  expectSuccess(await adapter.users.getAccessStatuses(['10']));
  expectSuccess(
    await adapter.users.searchEmployees({
      query: '',
      cursor: null,
      pageSize: 10,
      departmentId: null,
      includeInactive: true,
    }),
  );
  expectSuccess(await adapter.users.getEmployeeProfile('10'));
  expectSuccess(await adapter.organization.getDepartments());
  expectSuccess(await adapter.organization.getLeadership('20'));
  expectSuccess(await adapter.organization.snapshotDepartmentMembers('1'));
  expectSuccess(await adapter.calendar.getPortalCalendar({ fromYear: 2026, toYear: 2026 }));
  expectSuccess(
    await adapter.notifications.sendOnce({
      recipientId: '10',
      deduplicationKey: 'operation:123e4567-e89b-42d3-a456-426614174000:completed',
      message: 'Operation completed.',
      operationUrl:
        'https://task-commander.example.test/operations/123e4567-e89b-42d3-a456-426614174000',
    }),
  );
  expectSuccess(
    await adapter.disk.putReportOnce({
      operationId: '123e4567-e89b-42d3-a456-426614174000',
      format: 'csv',
      fileName: '2026-08-10-operation-123e4567.csv',
      content: new Uint8Array([1, 2, 3]),
      contentHash: 'sha256:adapter-contract',
      access: [{ principal: 'user', id: '10', level: 'read' }],
    }),
  );
}
