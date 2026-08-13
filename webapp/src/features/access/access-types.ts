import type {
  AccessFieldScopeReference,
  AccessChangeMode,
  AccessManagementCommandReceipt,
  AccessManagementDraftIntent,
  AccessManagementPreflight,
  EmploymentState,
  Permission,
} from '@task-commander/contracts';

export type AccessStatus = 'active' | 'quarantined' | 'none' | 'review';

export type AccessCapabilities = {
  canManageAccess: boolean;
  canGrantManageAccess: boolean;
  isAdmin: boolean;
  permissions: readonly Permission[];
  bitrixCheckedAt: string | null;
  permissionCatalogVersion: number;
  actorAccessVersion: number;
  actorUserId?: string;
  degraded?: boolean;
};

export type AccessUser = {
  id: string;
  displayName: string;
  position: string;
  department: string;
  avatarUrl?: string;
  status: AccessStatus;
  permissionCount: number;
  permissions: Permission[];
  isBitrixAdmin?: boolean;
  isManager?: boolean;
  isSelf: boolean;
  employmentState: EmploymentState;
  canManage: boolean;
  attentionReason?: string;
  accessVersion: number | null;
  fieldScope: AccessFieldScopeReference | null;
  availableModes: AccessChangeMode[];
};

export type UsersPage = {
  items: AccessUser[];
  total: number;
  nextCursor: string | null;
};

export type AccessField = { id: string; label: string; group?: string };
export type Department = { id: string; name: string };

export type AccessDraft = AccessManagementDraftIntent;

export type AccessPreflight = AccessManagementPreflight;

export type AccessConfirmation = {
  id: string;
  token: string;
};

export type AccessCommand = AccessManagementCommandReceipt;
