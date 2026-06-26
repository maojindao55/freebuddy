import { create } from "zustand";

export interface BridgeToast {
  id: string;
  text: string;
}

interface AgentBridgeState {
  toasts: BridgeToast[];
  notify(text: string): void;
  dismiss(id: string): void;
}

export const useAgentBridgeStore = create<AgentBridgeState>((set) => ({
  toasts: [],

  notify(text) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({ toasts: [...s.toasts, { id, text }] }));
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4000);
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }
}));
