import { type QueryClient, useQuery } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import {
  listenForAccessInvalidation,
  listenForSecurityContextInvalidation,
  notifySecurityContextInvalidated,
} from '@/app/access-sync';
import {
  AppApiError,
  createLocalDevSession,
  fetchEffectiveAccess,
  fetchSession,
  isRetryableAppError,
  verifyManageAccess,
} from '@/app/app-api';
import type { AccessManagementState, AppAccessSnapshot } from '@/app/app-context';
import { AppState } from '@/components/ui/app-state';

const offlineGraceMs = 5_000;

type LocalLoginStatus = 'idle' | 'creating' | 'refreshing';

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function retryDelay(error: unknown): number {
  return error instanceof AppApiError && error.retryAfterMs !== undefined
    ? error.retryAfterMs
    : 1_000;
}

function isEmbeddedProductionContext(): boolean {
  if (!import.meta.env.PROD || typeof window === 'undefined') return true;
  return window.self !== window.top;
}

function errorState(error: unknown): {
  title: string;
  description: string;
  kind: 'session' | 'access' | 'offline' | 'temporary' | 'invalid';
  eventId?: string;
} {
  const eventId = error instanceof AppApiError ? error.eventId : undefined;
  if (error instanceof AppApiError) {
    switch (error.kind) {
      case 'session_required':
        return {
          title: 'Сессия завершена',
          description: 'Откройте Task Commander из Bitrix24 и повторите проверку.',
          kind: 'session',
          eventId,
        };
      case 'access_denied':
        return {
          title: 'Доступ к Task Commander закрыт',
          description: 'Обратитесь к администратору Bitrix24, если доступ требуется для работы.',
          kind: 'access',
          eventId,
        };
      case 'offline':
        return {
          title: 'Нет соединения',
          description: 'Подключитесь к сети и повторите проверку доступа.',
          kind: 'offline',
          eventId,
        };
      case 'invalid_response':
        return {
          title: 'Не удалось безопасно загрузить приложение',
          description: 'Сервер вернул неожиданный ответ. Повторите попытку позже.',
          kind: 'invalid',
          eventId,
        };
      default:
        return {
          title: 'Проверка доступа временно недоступна',
          description: 'Повторите попытку позже. Ваши данные и права не были показаны.',
          kind: 'temporary',
          eventId,
        };
    }
  }
  return {
    title: 'Проверка доступа временно недоступна',
    description: 'Повторите попытку позже. Ваши данные и права не были показаны.',
    kind: 'temporary',
  };
}

export function isLocalDevLoginEnabled(isDevelopmentBuild: boolean, error: unknown): boolean {
  return isDevelopmentBuild && error instanceof AppApiError && error.kind === 'session_required';
}

function localLoginErrorState(error: unknown): {
  title: string;
  description: string;
  eventId?: string;
} {
  const eventId = error instanceof AppApiError ? error.eventId : undefined;
  if (error instanceof AppApiError && error.status === 404) {
    return {
      title: 'Локальный вход недоступен',
      description: 'Этот сервер не поддерживает локальную mock-сессию.',
      eventId,
    };
  }
  if (error instanceof AppApiError && error.status === 503) {
    return {
      title: 'Не удалось войти локально',
      description: 'Проверьте настройку локальных signing secrets и повторите попытку.',
      eventId,
    };
  }
  if (error instanceof AppApiError && ['offline', 'temporary'].includes(error.kind)) {
    return {
      title: 'Не удалось войти локально',
      description: 'Не удалось подключиться к локальному серверу. Повторите попытку позже.',
      eventId,
    };
  }
  return {
    title: 'Не удалось войти локально',
    description: 'Не удалось создать локальную mock-сессию. Повторите попытку позже.',
    eventId,
  };
}

export function AppBootstrap({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: (snapshot: AppAccessSnapshot) => ReactNode;
}) {
  const [online, setOnline] = useState(isOnline);
  const [offlineBlocked, setOfflineBlocked] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [securityEpoch, setSecurityEpoch] = useState(0);
  const [securityRefreshTargetEpoch, setSecurityRefreshTargetEpoch] = useState<number | null>(null);
  const [localLoginStatus, setLocalLoginStatus] = useState<LocalLoginStatus>('idle');
  const [localLoginError, setLocalLoginError] = useState<unknown>(null);
  const previousIdentity = useRef<string | null>(null);
  const localLoginInFlight = useRef(false);
  const securityEpochSequence = useRef(0);
  const securityRefreshPending = securityRefreshTargetEpoch !== null;

  const session = useQuery({
    queryKey: ['app', 'session', securityEpoch],
    queryFn: ({ signal }) => fetchSession(signal),
    retry: (count, error) => count < 1 && isRetryableAppError(error),
    retryDelay,
    refetchOnWindowFocus: false,
  });
  const access = useQuery({
    queryKey: ['app', 'access', securityEpoch, session.data?.portalId, session.data?.userId],
    queryFn: ({ signal }) => fetchEffectiveAccess(signal),
    enabled: session.isSuccess,
    retry: (count, error) => count < 1 && isRetryableAppError(error),
    retryDelay,
    refetchOnWindowFocus: false,
  });
  const needsManageAccessProbe =
    access.isSuccess &&
    (session.data?.isBitrixAdmin === true || access.data.permissions.includes('manage_access'));
  const manageAccess = useQuery({
    queryKey: ['app', 'manage-access', securityEpoch, session.data?.portalId, session.data?.userId],
    queryFn: ({ signal }) => verifyManageAccess(signal),
    enabled: needsManageAccessProbe,
    retry: (count, error) => count < 1 && isRetryableAppError(error),
    retryDelay,
    refetchOnWindowFocus: false,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['app'], refetchType: 'active' });
  }, [queryClient]);

  const refreshSecurityContext = useCallback(async () => {
    const targetEpoch = securityEpochSequence.current + 1;
    securityEpochSequence.current = targetEpoch;
    setSecurityRefreshTargetEpoch(targetEpoch);
    try {
      await queryClient.cancelQueries();
    } catch {
      // Revalidation still proceeds and remains fail-closed if cancellation is unavailable.
    }
    queryClient.getMutationCache().clear();
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] !== 'app',
    });
    setSecurityEpoch((current) => Math.max(current, targetEpoch));
    setGeneration((current) => current + 1);
  }, [queryClient]);

  const startLocalLogin = useCallback(async () => {
    if (localLoginInFlight.current) return;

    localLoginInFlight.current = true;
    setLocalLoginError(null);
    setLocalLoginStatus('creating');
    try {
      await createLocalDevSession();
      notifySecurityContextInvalidated();
      setLocalLoginStatus('refreshing');
    } catch (error) {
      localLoginInFlight.current = false;
      setLocalLoginError(error);
      setLocalLoginStatus('idle');
    }
  }, [refreshSecurityContext]);

  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      void refreshSecurityContext();
    };
    const onOffline = () => setOnline(false);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh, refreshSecurityContext]);

  useEffect(
    () => listenForAccessInvalidation(() => void refreshSecurityContext()),
    [refreshSecurityContext],
  );

  useEffect(
    () => listenForSecurityContextInvalidation(() => void refreshSecurityContext()),
    [refreshSecurityContext],
  );

  useEffect(() => {
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] === 'app' && query.queryKey[2] !== securityEpoch,
    });
  }, [queryClient, securityEpoch]);

  const isReady = session.isSuccess && access.isSuccess;

  useEffect(() => {
    if (securityRefreshTargetEpoch === null || securityEpoch !== securityRefreshTargetEpoch) return;
    if (!session.isError && !(session.isSuccess && (access.isError || access.isSuccess))) return;

    setSecurityRefreshTargetEpoch(null);
    if (localLoginStatus === 'refreshing') {
      localLoginInFlight.current = false;
      setLocalLoginStatus('idle');
    }
  }, [
    access.isError,
    access.isSuccess,
    localLoginStatus,
    securityEpoch,
    securityRefreshTargetEpoch,
    session.isError,
    session.isSuccess,
  ]);

  useEffect(() => {
    if (online || !isReady) {
      setOfflineBlocked(false);
      return undefined;
    }
    const timeout = window.setTimeout(() => setOfflineBlocked(true), offlineGraceMs);
    return () => window.clearTimeout(timeout);
  }, [isReady, online]);

  useEffect(() => {
    if (!session.data) return;
    const identity = `${session.data.portalId}:${session.data.userId}`;
    if (previousIdentity.current !== null && previousIdentity.current !== identity) {
      void queryClient.cancelQueries();
      queryClient.getMutationCache().clear();
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'app',
      });
      setGeneration((current) => current + 1);
    }
    previousIdentity.current = identity;
  }, [queryClient, session.data]);

  useEffect(() => {
    if (
      !(session.error instanceof AppApiError) ||
      !['session_required', 'access_denied'].includes(session.error.kind)
    )
      return;
    queryClient.getMutationCache().clear();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'app' });
  }, [queryClient, session.error]);

  useEffect(() => {
    if (!(access.error instanceof AppApiError) || access.error.kind !== 'access_denied') return;
    queryClient.getMutationCache().clear();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'app' });
  }, [access.error, queryClient]);

  const hasTerminalManageAccessFailure =
    manageAccess.error instanceof AppApiError &&
    (manageAccess.error.kind === 'session_required' || manageAccess.error.code === 'ACCESS_REVOKED');

  useEffect(() => {
    if (!hasTerminalManageAccessFailure) return;
    void queryClient.cancelQueries();
    queryClient.getMutationCache().clear();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'app' });
  }, [hasTerminalManageAccessFailure, queryClient]);

  if (!isEmbeddedProductionContext()) {
    return (
      <AppState
        title="Откройте приложение из Bitrix24"
        description="Task Commander работает внутри веб-версии корпоративного портала."
      />
    );
  }
  if (localLoginStatus !== 'idle') {
    return (
      <AppState
        action={
          <button className="button-primary" disabled type="button">
            Входим…
          </button>
        }
        description="Создаём локальную mock-сессию и повторно проверяем права доступа."
        title="Сессия завершена"
      />
    );
  }
  if (securityRefreshPending) {
    return (
      <AppState
        description="Повторно проверяем сессию и права доступа."
        title="Проверяем доступ…"
      />
    );
  }
  if (!online && !isReady) {
    return (
      <AppState
        title="Нет соединения"
        description="Подключитесь к сети, чтобы безопасно проверить доступ к Task Commander."
        action={
          <button className="button-primary" onClick={() => void refresh()} type="button">
            Повторить
          </button>
        }
      />
    );
  }
  if (session.isPending || (session.isSuccess && access.isPending)) {
    return (
      <AppState
        title="Проверяем доступ…"
        description="Проверяем сессию Bitrix24 и ваши права в Task Commander."
      />
    );
  }
  if (session.isError) {
    const { title, description, eventId } = errorState(session.error);
    if (isLocalDevLoginEnabled(import.meta.env.DEV, session.error)) {
      const localError = localLoginError === null ? null : localLoginErrorState(localLoginError);
      return (
        <AppState
          action={
            <button className="button-primary" onClick={() => void startLocalLogin()} type="button">
              Войти локально
            </button>
          }
          description={
            localError?.description ??
            'Будет создана локальная сессия mock-администратора. Она доступна только в режиме разработки.'
          }
          eventId={localError?.eventId ?? eventId}
          title={localError?.title ?? title}
        />
      );
    }
    return (
      <AppState
        action={
          <button className="button-primary" onClick={() => void refresh()} type="button">
            Повторить проверку
          </button>
        }
        description={description}
        eventId={eventId}
        title={title}
      />
    );
  }
  if (access.isError) {
    const { title, description, eventId } = errorState(access.error);
    return (
      <AppState
        action={
          <button className="button-primary" onClick={() => void refresh()} type="button">
            Повторить проверку
          </button>
        }
        description={description}
        eventId={eventId}
        title={title}
      />
    );
  }
  if (!session.data || !access.data) return null;
  if (offlineBlocked) {
    return (
      <AppState
        title="Соединение потеряно"
        description="Данные скрыты до повторной безопасной проверки доступа."
        action={
          <button className="button-primary" onClick={() => void refresh()} type="button">
            Повторить проверку
          </button>
        }
      />
    );
  }

  if (hasTerminalManageAccessFailure && manageAccess.error instanceof AppApiError) {
    const { title, description, eventId } = errorState(manageAccess.error);
    return (
      <AppState
        action={
          <button
            className="button-primary"
            onClick={() => void refreshSecurityContext()}
            type="button"
          >
            Повторить проверку
          </button>
        }
        description={description}
        eventId={eventId}
        title={title}
      />
    );
  }

  const accessManagement: AccessManagementState = !needsManageAccessProbe
    ? 'denied'
    : manageAccess.isSuccess
      ? 'allowed'
      : manageAccess.isError
        ? manageAccess.error instanceof AppApiError && manageAccess.error.kind === 'access_denied'
          ? 'denied'
          : 'unavailable'
        : 'checking';
  const snapshot: AppAccessSnapshot = Object.freeze({
    principal: session.data,
    access: access.data,
    accessManagement,
    generation,
    canMutate: online,
  });

  return (
    <>
      {!online ? (
        <div aria-live="polite" className="connection-banner">
          Соединение потеряно. Изменения временно заблокированы.
        </div>
      ) : null}
      {accessManagement === 'unavailable' ? (
        <div aria-live="polite" className="connection-banner connection-banner-warning">
          Не удалось подтвердить право управления доступом. Остальные разделы доступны.
        </div>
      ) : null}
      {children(snapshot)}
    </>
  );
}
