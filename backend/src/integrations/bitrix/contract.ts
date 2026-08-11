import type { z } from 'zod';

import {
  bitrixDepartmentSchema,
  bitrixFailureSchema,
  bitrixUserSchema,
  diskFileSchema,
  diskPutReportRequestSchema,
  notificationRequestSchema,
  notificationSchema,
  portalCalendarSchema,
  taskApplyOutcomeSchema,
  taskApplyRequestSchema,
  taskChangeSnapshotSchema,
  taskFieldCapabilitySchema,
  taskReadForChangeRequestSchema,
  taskSearchPageSchema,
  taskSearchRequestSchema,
} from './schemas';

export type BitrixFailure = z.infer<typeof bitrixFailureSchema>;
export type BitrixResult<T> = { ok: true; value: T } | { ok: false; failure: BitrixFailure };

export type TaskFieldCapability = z.infer<typeof taskFieldCapabilitySchema>;
export type TaskSearchRequest = z.infer<typeof taskSearchRequestSchema>;
export type TaskSearchPage = z.infer<typeof taskSearchPageSchema>;
export type TaskChangeSnapshot = z.infer<typeof taskChangeSnapshotSchema>;
export type TaskReadForChangeRequest = z.infer<typeof taskReadForChangeRequestSchema>;
export type TaskApplyRequest = z.infer<typeof taskApplyRequestSchema>;
export type TaskApplyOutcome = z.infer<typeof taskApplyOutcomeSchema>;
export type BitrixUser = z.infer<typeof bitrixUserSchema>;
export type BitrixDepartment = z.infer<typeof bitrixDepartmentSchema>;
export type PortalCalendar = z.infer<typeof portalCalendarSchema>;
export type NotificationRequest = z.infer<typeof notificationRequestSchema>;
export type BitrixNotification = z.infer<typeof notificationSchema>;
export type DiskPutReportRequest = z.infer<typeof diskPutReportRequestSchema>;
export type BitrixDiskFile = z.infer<typeof diskFileSchema>;

export interface BitrixTasks {
  getFieldCapabilities(): Promise<BitrixResult<readonly TaskFieldCapability[]>>;
  search(request: TaskSearchRequest): Promise<BitrixResult<TaskSearchPage>>;
  readForChange(request: TaskReadForChangeRequest): Promise<BitrixResult<TaskChangeSnapshot>>;
  applyChange(request: TaskApplyRequest): Promise<BitrixResult<TaskApplyOutcome>>;
}

export interface BitrixUsers {
  getCurrent(): Promise<BitrixResult<BitrixUser>>;
  getByIds(userIds: readonly string[]): Promise<BitrixResult<readonly BitrixUser[]>>;
}

export interface BitrixOrganization {
  getDepartments(): Promise<BitrixResult<readonly BitrixDepartment[]>>;
  getLeadership(userId: string): Promise<BitrixResult<readonly BitrixDepartment[]>>;
}

export interface BitrixCalendar {
  getPortalCalendar(
    input: { fromYear: number; toYear: number },
  ): Promise<BitrixResult<PortalCalendar>>;
}

export interface BitrixNotifications {
  sendOnce(request: NotificationRequest): Promise<BitrixResult<BitrixNotification>>;
}

export interface BitrixDisk {
  putReportOnce(request: DiskPutReportRequest): Promise<BitrixResult<BitrixDiskFile>>;
  getReport(fileId: string): Promise<BitrixResult<{ file: BitrixDiskFile; content: Uint8Array }>>;
  archiveReport(fileId: string): Promise<BitrixResult<BitrixDiskFile>>;
  deleteReport(fileId: string): Promise<BitrixResult<{ deleted: boolean }>>;
}

export interface BitrixAdapter {
  tasks: BitrixTasks;
  users: BitrixUsers;
  organization: BitrixOrganization;
  calendar: BitrixCalendar;
  notifications: BitrixNotifications;
  disk: BitrixDisk;
}
