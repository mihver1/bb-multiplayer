import { useSyncExternalStore } from "react";

export type DiscussionTarget = {
  requestId: number;
  messageId: string;
  quote: string;
};
export type DiscussionRequest = {
  requestId: number;
  threadId: string;
  composerKey: string | null;
  target: DiscussionTarget | null;
};

// One app-overlay consumes explicit open requests. The originating thread and
// optional composer identity travel together; the current route is not proof
// that feedback belongs to that route's agent. No persisted drafts or credentials.
let pending: DiscussionRequest | null = null;
const listeners = new Set<() => void>();
let sequence = 0;

export function requestDiscussion(
  threadId: string,
  composerKey: string | null = null,
  target?: { messageId: string; quote: string },
) {
  const requestId = ++sequence;
  pending = {
    requestId,
    threadId,
    composerKey,
    target: target ? { ...target, requestId } : null,
  };
  listeners.forEach((notify) => notify());
}

export function consumeDiscussionRequest(requestId: number) {
  if (pending?.requestId !== requestId) return;
  pending = null;
  listeners.forEach((notify) => notify());
}

export function useDiscussionRequest(): DiscussionRequest | null {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    () => pending,
    () => null,
  );
}
