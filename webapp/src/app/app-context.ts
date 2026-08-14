import type {
  EffectiveAccessResponse,
  Permission,
  SessionPrincipal,
} from '@task-commander/contracts';

export type AccessManagementState = 'checking' | 'allowed' | 'denied' | 'unavailable';

export type AppAccessSnapshot = Readonly<{
  principal: SessionPrincipal;
  access: EffectiveAccessResponse;
  accessManagement: AccessManagementState;
  generation: number;
  canMutate: boolean;
}>;

export type HomeSectionState<T> =
  | Readonly<{ status: 'not_available' }>
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ready'; data: T }>
  | Readonly<{ status: 'error'; eventId?: string }>;

export type HomeSummary = Readonly<{
  running: number;
  completedLast30Days: number;
  processedTasksLast30Days: number;
  attentionCount: number;
}>;

export type ActiveOperationItem = Readonly<{
  id: string;
  title: string;
  status: string;
  progress: number;
  processed: string;
  tone: 'neutral' | 'warning';
}>;

export type RecentResultItem = Readonly<{
  id: string;
  title: string;
  completedAt: string;
  taskCount: string;
  result: string;
  tone: 'success' | 'warning' | 'neutral';
}>;

export type AttentionItem = Readonly<{
  id: string;
  title: string;
  action: string;
  tone: 'warning' | 'neutral';
}>;

export type HomeDashboardModel = Readonly<{
  summary: HomeSectionState<HomeSummary>;
  activeOperations: HomeSectionState<readonly ActiveOperationItem[]>;
  recentResults: HomeSectionState<readonly RecentResultItem[]>;
  attention: HomeSectionState<readonly AttentionItem[]>;
}>;

export const unavailableHomeDashboardModel: HomeDashboardModel = Object.freeze({
  summary: Object.freeze({ status: 'not_available' }),
  activeOperations: Object.freeze({ status: 'not_available' }),
  recentResults: Object.freeze({ status: 'not_available' }),
  attention: Object.freeze({ status: 'not_available' }),
});

export function hasAppPermission(snapshot: AppAccessSnapshot, permission: Permission): boolean {
  return snapshot.access.permissions.includes(permission);
}
