import { create } from "zustand";

interface DebugLogsDialogState {
  open: boolean;
  /** When set, session logs are scoped to this conversation on export. */
  conversationId: string | null;
  setOpen: (open: boolean, conversationId?: string) => void;
}

export const useDebugLogsDialogStore = create<DebugLogsDialogState>((set) => ({
  open: false,
  conversationId: null,
  setOpen: (open, conversationId) =>
    set({ open, conversationId: open ? conversationId ?? null : null })
}));
