import { create } from "zustand";

import type { CliPermissionRequest } from "@/services/cli/types";
import { cliClient } from "@/services/cli/client";

interface QueuedPermission extends CliPermissionRequest {
  conversationId: string;
  resolving?: boolean;
}

interface PermissionState {
  queue: QueuedPermission[];
  enqueue: (
    conversationId: string,
    request: CliPermissionRequest
  ) => void;
  remove: (requestId: string) => void;
  removeForSession: (sessionId: string) => void;
  removeForConversation: (conversationId: string) => void;
  decide: (
    requestId: string,
    decision:
      | { outcome: "selected"; optionId: string }
      | { outcome: "cancelled" }
  ) => Promise<void>;
}

export const usePermissionStore = create<PermissionState>((set, get) => ({
  queue: [],
  enqueue(conversationId, request) {
    set((s) => {
      if (s.queue.some((q) => q.requestId === request.requestId)) return s;
      return {
        queue: [...s.queue, { ...request, conversationId }]
      };
    });
  },
  remove(requestId) {
    set((s) => ({
      queue: s.queue.filter((q) => q.requestId !== requestId)
    }));
  },
  removeForSession(sessionId) {
    set((s) => ({
      queue: s.queue.filter((q) => q.sessionId !== sessionId)
    }));
  },
  removeForConversation(conversationId) {
    set((s) => ({
      queue: s.queue.filter((q) => q.conversationId !== conversationId)
    }));
  },
  async decide(requestId, decision) {
    const entry = get().queue.find((q) => q.requestId === requestId);
    if (!entry || entry.resolving) return;
    set((s) => ({
      queue: s.queue.map((q) =>
        q.requestId === requestId ? { ...q, resolving: true } : q
      )
    }));
    try {
      await cliClient.permissionDecision({
        sessionId: entry.sessionId,
        requestId,
        outcome: decision.outcome,
        optionId:
          decision.outcome === "selected" ? decision.optionId : undefined
      });
    } finally {
      set((s) => ({
        queue: s.queue.filter((q) => q.requestId !== requestId)
      }));
    }
  }
}));
