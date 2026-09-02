type EventBroadcaster = (channel: string, payload: unknown) => void;

const broadcasters = new Map<number, EventBroadcaster>();
let nextSubscriptionId = 0;
let legacyUnsubscribe: (() => void) | null = null;

/**
 * Subscribe to internal desktop events. Listeners added during a broadcast
 * start receiving the next event; listeners removed before their turn do not
 * receive the current event.
 */
export function subscribeEventBroadcaster(
  broadcaster: EventBroadcaster
): () => void {
  const subscriptionId = nextSubscriptionId;
  nextSubscriptionId += 1;
  broadcasters.set(subscriptionId, broadcaster);

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    broadcasters.delete(subscriptionId);
  };
}

/** @deprecated Use subscribeEventBroadcaster for independent subscriptions. */
export function setEventBroadcaster(fn: EventBroadcaster | null): void {
  legacyUnsubscribe?.();
  legacyUnsubscribe = fn ? subscribeEventBroadcaster(fn) : null;
}

export function hasEventBroadcaster(): boolean {
  return broadcasters.size > 0;
}

export function getEventBroadcasterCount(): number {
  return broadcasters.size;
}

export function broadcastEvent(channel: string, payload: unknown): void {
  const currentListeners = [...broadcasters.entries()];
  for (const [subscriptionId, broadcaster] of currentListeners) {
    if (!broadcasters.has(subscriptionId)) continue;
    try {
      broadcaster(channel, payload);
    } catch {
      // A broadcaster must never disrupt the desktop send path or its peers.
    }
  }
}
