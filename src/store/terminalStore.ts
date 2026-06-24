import { create } from "zustand";

export interface TerminalSnapshot {
  output: string;
  truncated?: boolean;
  exitCode?: number | null;
  exited?: boolean;
  running?: boolean;
}

interface TerminalState {
  byId: Record<string, TerminalSnapshot>;
  upsert: (terminalId: string, snapshot: TerminalSnapshot) => void;
  clear: () => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  byId: {},
  upsert: (terminalId, snapshot) =>
    set((state) => ({
      byId: {
        ...state.byId,
        [terminalId]: { ...state.byId[terminalId], ...snapshot }
      }
    })),
  clear: () => set({ byId: {} })
}));
