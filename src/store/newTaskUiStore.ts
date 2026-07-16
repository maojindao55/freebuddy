import { create } from "zustand";

export type NewTaskMode = "normal" | "team";

interface NewTaskUiState {
  taskMode: NewTaskMode;
  requestedTeamId?: string;
  setTaskMode(mode: NewTaskMode): void;
  setRequestedTeamId(teamId?: string): void;
}

export const useNewTaskUiStore = create<NewTaskUiState>((set) => ({
  taskMode: "normal",
  requestedTeamId: undefined,
  setTaskMode: (taskMode) =>
    set((state) => ({
      taskMode,
      requestedTeamId: taskMode === "normal" ? undefined : state.requestedTeamId
    })),
  setRequestedTeamId: (requestedTeamId) => set({ requestedTeamId })
}));
