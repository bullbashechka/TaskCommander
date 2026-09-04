const channelName = 'task-commander:access';
const accessInvalidatedMessageType = 'access-invalidated';
const securityContextInvalidatedMessageType = 'security-context-invalidated';
const securityContextInvalidatedEvent = 'task-commander:security-context-invalidated';
const synchronizationSourceId = (() => {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
})();

type InvalidationMessageType =
  typeof accessInvalidatedMessageType | typeof securityContextInvalidatedMessageType;

function notify(type: InvalidationMessageType): void {
  if (typeof BroadcastChannel === 'undefined') return;
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(channelName);
    channel.postMessage({ sourceId: synchronizationSourceId, type });
  } catch {
    // Cross-tab synchronization is best-effort; the initiating tab still refreshes locally.
  } finally {
    try {
      channel?.close();
    } catch {
      // A broken BroadcastChannel must not change the result of the completed user action.
    }
  }
}

export function notifyAccessInvalidated(): void {
  notify(accessInvalidatedMessageType);
}

export function notifySecurityContextInvalidated(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(securityContextInvalidatedEvent));
  }
  notify(securityContextInvalidatedMessageType);
}

function listenFor(type: InvalidationMessageType, onInvalidate: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(channelName);
  } catch {
    return () => undefined;
  }
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as { sourceId?: unknown; type?: unknown };
    if (
      typeof event.data === 'object' &&
      event.data !== null &&
      message.type === type &&
      message.sourceId !== synchronizationSourceId
    ) {
      onInvalidate();
    }
  };
  return () => {
    try {
      channel.close();
    } catch {
      // Cleanup stays safe if the browser channel has already failed.
    }
  };
}

export function listenForAccessInvalidation(onInvalidate: () => void): () => void {
  return listenFor(accessInvalidatedMessageType, onInvalidate);
}

export function listenForSecurityContextInvalidation(onInvalidate: () => void): () => void {
  if (typeof window !== 'undefined') {
    window.addEventListener(securityContextInvalidatedEvent, onInvalidate);
  }
  const unsubscribe = listenFor(securityContextInvalidatedMessageType, onInvalidate);
  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener(securityContextInvalidatedEvent, onInvalidate);
    }
    unsubscribe();
  };
}
