import { create } from "zustand";

import type {
  CliAuthenticationRequest,
  CliAuthenticationTerminalRequest
} from "@/services/cli/types";
import { cliClient } from "@/services/cli/client";

interface QueuedAuthentication extends CliAuthenticationRequest {
  conversationId: string;
  resolving?: boolean;
}

interface AuthenticationState {
  queue: QueuedAuthentication[];
  terminalQueue: Array<
    CliAuthenticationTerminalRequest & {
      conversationId: string;
      output: string;
      running: boolean;
      exitCode?: number;
    }
  >;
  enqueue: (
    conversationId: string,
    request: CliAuthenticationRequest
  ) => void;
  remove: (requestId: string) => void;
  removeForSession: (sessionId: string) => void;
  removeForConversation: (conversationId: string) => void;
  startTerminal: (
    conversationId: string,
    request: CliAuthenticationTerminalRequest
  ) => void;
  updateTerminal: (
    requestId: string,
    update: { output: string; running: boolean; exitCode?: number }
  ) => void;
  removeTerminal: (requestId: string) => void;
  writeTerminal: (requestId: string, data: string) => Promise<void>;
  cancelTerminal: (requestId: string) => Promise<void>;
  decide: (
    requestId: string,
    decision:
      | { outcome: "selected"; methodId: string }
      | { outcome: "cancelled" }
  ) => Promise<void>;
}

export const useAuthenticationStore = create<AuthenticationState>((set, get) => ({
  queue: [],
  terminalQueue: [],
  enqueue(conversationId, request) {
    set((state) => {
      if (state.queue.some((entry) => entry.requestId === request.requestId)) {
        return state;
      }
      return {
        queue: [...state.queue, { ...request, conversationId }]
      };
    });
  },
  remove(requestId) {
    set((state) => ({
      queue: state.queue.filter((entry) => entry.requestId !== requestId)
    }));
  },
  removeForSession(sessionId) {
    set((state) => ({
      queue: state.queue.filter((entry) => entry.sessionId !== sessionId),
      terminalQueue: state.terminalQueue.filter(
        (entry) => entry.sessionId !== sessionId
      )
    }));
  },
  removeForConversation(conversationId) {
    set((state) => ({
      queue: state.queue.filter(
        (entry) => entry.conversationId !== conversationId
      ),
      terminalQueue: state.terminalQueue.filter(
        (entry) => entry.conversationId !== conversationId
      )
    }));
  },
  startTerminal(conversationId, request) {
    set((state) => ({
      terminalQueue: state.terminalQueue.some(
        (entry) => entry.requestId === request.requestId
      )
        ? state.terminalQueue
        : [
            ...state.terminalQueue,
            { ...request, conversationId, output: "", running: true }
          ]
    }));
  },
  updateTerminal(requestId, update) {
    set((state) => ({
      terminalQueue: state.terminalQueue.map((entry) =>
        entry.requestId === requestId ? { ...entry, ...update } : entry
      )
    }));
  },
  removeTerminal(requestId) {
    set((state) => ({
      terminalQueue: state.terminalQueue.filter(
        (entry) => entry.requestId !== requestId
      )
    }));
  },
  async writeTerminal(requestId, data) {
    const entry = get().terminalQueue.find(
      (item) => item.requestId === requestId
    );
    if (!entry || !entry.running) return;
    await cliClient.authenticationTerminalInput({
      sessionId: entry.sessionId,
      requestId,
      data
    });
  },
  async cancelTerminal(requestId) {
    const entry = get().terminalQueue.find(
      (item) => item.requestId === requestId
    );
    if (!entry) return;
    await cliClient.authenticationTerminalCancel({
      sessionId: entry.sessionId,
      requestId
    });
  },
  async decide(requestId, decision) {
    const entry = get().queue.find((item) => item.requestId === requestId);
    if (!entry || entry.resolving) return;
    set((state) => ({
      queue: state.queue.map((item) =>
        item.requestId === requestId ? { ...item, resolving: true } : item
      )
    }));
    try {
      await cliClient.authenticationDecision({
        sessionId: entry.sessionId,
        requestId,
        outcome: decision.outcome,
        methodId:
          decision.outcome === "selected" ? decision.methodId : undefined
      });
    } finally {
      set((state) => ({
        queue: state.queue.filter((item) => item.requestId !== requestId)
      }));
    }
  }
}));
