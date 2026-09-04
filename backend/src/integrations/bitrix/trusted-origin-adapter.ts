import type { RuntimeEnvironment } from '../../runtime/configuration';
import { canonicalOrigin, configuredOrigins, isUrlFromOrigins } from '../../runtime/origin-policy';
import type { BitrixAdapter, BitrixResult } from './contract';

function invalidExternalResponse<T>(): BitrixResult<T> {
  return { ok: false, failure: { kind: 'invalid_external_response' } };
}

async function validateResult<T>(
  result: Promise<BitrixResult<T>>,
  isValid: (value: T) => boolean,
): Promise<BitrixResult<T>> {
  const resolved = await result;
  return !resolved.ok || isValid(resolved.value) ? resolved : invalidExternalResponse();
}

export function enforceBitrixOriginPolicy(
  adapter: BitrixAdapter,
  env: RuntimeEnvironment,
): BitrixAdapter {
  const allowHttp = env.APP_ENV === 'local';
  const portalOrigins = configuredOrigins(env.BITRIX_PORTAL_ORIGIN, allowHttp);
  const mediaOrigins = configuredOrigins(env.BITRIX_MEDIA_ALLOWED_ORIGINS, allowHttp);
  const applicationOrigin = canonicalOrigin(env.APP_ORIGIN ?? '', allowHttp);
  const portalUrl = (value: string | null) =>
    value === null || isUrlFromOrigins(value, portalOrigins);
  const mediaUrl = (value: string | null) =>
    value === null || isUrlFromOrigins(value, [...portalOrigins, ...mediaOrigins]);
  const applicationUrl = (value: string) =>
    applicationOrigin !== null && isUrlFromOrigins(value, [applicationOrigin], allowHttp);
  const employee = (value: { photoUrl: string | null; profileUrl: string | null }) =>
    mediaUrl(value.photoUrl) && portalUrl(value.profileUrl);
  const diskFile = (value: { url: string }) => mediaUrl(value.url);

  return {
    tasks: {
      getFieldCapabilities: () => adapter.tasks.getFieldCapabilities(),
      search: (request) =>
        validateResult(adapter.tasks.search(request), (page) =>
          page.items.every((item) => portalUrl(item.taskUrl)),
        ),
      selectAll: (request) => adapter.tasks.selectAll(request),
      readForChange: (request) =>
        validateResult(adapter.tasks.readForChange(request), (snapshot) =>
          portalUrl(snapshot.taskUrl),
        ),
      applyChange: (request) => adapter.tasks.applyChange(request),
    },
    users: {
      getCurrent: () => adapter.users.getCurrent(),
      getByIds: (userIds) => adapter.users.getByIds(userIds),
      getAccessStatuses: (userIds) => adapter.users.getAccessStatuses(userIds),
      searchEmployees: (request) =>
        validateResult(adapter.users.searchEmployees(request), (page) =>
          page.items.every(employee),
        ),
      getEmployeeProfile: (userId) =>
        validateResult(adapter.users.getEmployeeProfile(userId), employee),
    },
    organization: adapter.organization,
    calendar: adapter.calendar,
    notifications: {
      sendOnce: (request) =>
        applicationUrl(request.operationUrl)
          ? validateResult(adapter.notifications.sendOnce(request), (notification) =>
              applicationUrl(notification.operationUrl),
            )
          : Promise.resolve(invalidExternalResponse()),
    },
    disk: {
      putReportOnce: (request) => validateResult(adapter.disk.putReportOnce(request), diskFile),
      getReport: (fileId) =>
        validateResult(adapter.disk.getReport(fileId), (report) => diskFile(report.file)),
      archiveReport: (fileId) => validateResult(adapter.disk.archiveReport(fileId), diskFile),
      deleteReport: (fileId) => adapter.disk.deleteReport(fileId),
    },
  };
}
