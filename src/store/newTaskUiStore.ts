import { create } from "zustand";

export type NewTaskMode = "normal" | "team";

interface NewTaskUiState {
  taskMode: NewTaskMode;
  requestedTeamId?: string;
  /** Bumped whenever a new-task cwd should be applied (including clear). */
  cwdRequestToken: number;
  /** Absolute project cwd to prefill; undefined clears the field. */
  requestedCwd?: string;
  setTaskMode(mode: NewTaskMode): void;
  setRequestedTeamId(teamId?: string): void;
  requestNewTaskCwd(cwd?: string): void;
}

export const useNewTaskUiStore = create<NewTaskUiState>((set) => ({
  taskMode: "normal",
  requestedTeamId: undefined,
  cwdRequestToken: 0,
  requestedCwd: undefined,
  setTaskMode: (taskMode) =>
    set((state) => ({
      taskMode,
      requestedTeamId: taskMode === "normal" ? undefined : state.requestedTeamId
    })),
  setRequestedTeamId: (requestedTeamId) => set({ requestedTeamId }),
  requestNewTaskCwd: (cwd) =>
    set((state) => ({
      requestedCwd: cwd,
      cwdRequestToken: state.cwdRequestToken + 1
    }))
}));
