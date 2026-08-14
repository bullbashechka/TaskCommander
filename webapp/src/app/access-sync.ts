const channelName = 'task-commander:access';
const messageType = 'access-invalidated';

export function notifyAccessInvalidated(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(channelName);
  channel.postMessage({ type: messageType });
  channel.close();
}

export function listenForAccessInvalidation(onInvalidate: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (
      typeof event.data === 'object' &&
      event.data !== null &&
      (event.data as { type?: unknown }).type === messageType
    ) {
      onInvalidate();
    }
  };
  return () => channel.close();
}
