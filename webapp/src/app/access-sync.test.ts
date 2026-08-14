import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  listenForSecurityContextInvalidation,
  notifySecurityContextInvalidated,
} from './access-sync';

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];

  public onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  public readonly postMessage = vi.fn();
  public readonly close = vi.fn();

  public constructor(public readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }
}

afterEach(() => {
  FakeBroadcastChannel.instances = [];
  vi.unstubAllGlobals();
});

describe('security context synchronization', () => {
  it('broadcasts and receives a security-context invalidation without identity data', () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const invalidate = vi.fn();
    const stop = listenForSecurityContextInvalidation(invalidate);

    notifySecurityContextInvalidated();

    const listener = FakeBroadcastChannel.instances[0];
    const sender = FakeBroadcastChannel.instances[1];
    expect(sender?.name).toBe('task-commander:access');
    expect(sender?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'security-context-invalidated' }),
    );
    expect(sender?.close).toHaveBeenCalledOnce();

    const ownMessage = sender?.postMessage.mock.calls[0]?.[0];
    listener?.onmessage?.(new MessageEvent('message', { data: ownMessage }));
    expect(invalidate).not.toHaveBeenCalled();

    listener?.onmessage?.(
      new MessageEvent('message', {
        data: { sourceId: 'another-tab', type: 'security-context-invalidated' },
      }),
    );
    expect(invalidate).toHaveBeenCalledOnce();

    stop();
    expect(listener?.close).toHaveBeenCalledOnce();
  });

  it('treats an unavailable BroadcastChannel as a best-effort notification failure', () => {
    class ThrowingBroadcastChannel {
      public constructor() {
        throw new Error('channel unavailable');
      }
    }
    vi.stubGlobal('BroadcastChannel', ThrowingBroadcastChannel);

    expect(() => notifySecurityContextInvalidated()).not.toThrow();
  });
});
