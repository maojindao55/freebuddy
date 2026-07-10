import { create } from "zustand";

import { cliClient } from "@/services/cli/client";
import type { CLIAdapterId } from "@/config/cliAdapters";

export type CliInstallPanelState = "expanded" | "minimized";

export interface CliInstallJob {
  id: string;
  adapterId: string;
  label: string;
  command: string;
  output: string;
  done: boolean;
  exitCode: number | null;
  panelState: CliInstallPanelState;
}

interface State {
  jobs: CliInstallJob[];
  startJob(args: { adapterId: string; label: string; command: string }): void;
  setPanelState(id: string, panelState: CliInstallPanelState): void;
  dismissJob(id: string): void;
  isInstalling(adapterId: string): boolean;
}

const unsubscribers = new Map<string, () => void>();
const pendingOutput = new Map<string, string>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

const FLUSH_MS = 120;
const MAX_OUTPUT_CHARS = 80_000;

function trimOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return "…\n" + output.slice(-MAX_OUTPUT_CHARS);
}

function flushOutput(id: string, set: (fn: (s: State) => Partial<State>) => void) {
  flushTimers.delete(id);
  const chunk = pendingOutput.get(id);
  if (!chunk) return;
  pendingOutput.delete(id);
  set((s) => ({
    jobs: s.jobs.map((j) =>
      j.id === id ? { ...j, output: trimOutput(j.output + chunk) } : j
    )
  }));
}

function scheduleFlush(id: string, set: (fn: (s: State) => Partial<State>) => void) {
  if (flushTimers.has(id)) return;
  flushTimers.set(
    id,
    setTimeout(() => flushOutput(id, set), FLUSH_MS)
  );
}

function finishJob(
  id: string,
  exitCode: number | null,
  set: (fn: (s: State) => Partial<State>) => void
) {
  const timer = flushTimers.get(id);
  if (timer) clearTimeout(timer);
  flushOutput(id, set);
  pendingOutput.delete(id);

  set((s) => ({
    jobs: s.jobs.map((j) =>
      j.id === id
        ? { ...j, done: true, exitCode, panelState: "expanded" as const }
        : j
    )
  }));

  if (exitCode === 0) {
    void import("@/store/cliExecutorStore").then(({ useCliExecutorStore }) => {
      void useCliExecutorStore.getState().check(id as CLIAdapterId);
    });
  }
}

export const useCliInstallStore = create<State>((set, get) => ({
  jobs: [],

  startJob({ adapterId, label, command }) {
    if (!cliClient.isAvailable()) return;

    unsubscribers.get(adapterId)?.();
    unsubscribers.delete(adapterId);
    pendingOutput.delete(adapterId);
    const timer = flushTimers.get(adapterId);
    if (timer) clearTimeout(timer);
    flushTimers.delete(adapterId);

    const job: CliInstallJob = {
      id: adapterId,
      adapterId,
      label,
      command,
      output: "",
      done: false,
      exitCode: null,
      panelState: "expanded"
    };

    set((s) => ({
      jobs: [...s.jobs.filter((j) => j.adapterId !== adapterId), job]
    }));

    const off = cliClient.installStream(adapterId, command, (event) => {
      if (event.type === "stdout" || event.type === "stderr") {
        pendingOutput.set(adapterId, (pendingOutput.get(adapterId) ?? "") + event.content);
        scheduleFlush(adapterId, set);
      } else if (event.type === "done") {
        finishJob(adapterId, event.exitCode, set);
        off();
        unsubscribers.delete(adapterId);
      }
    });

    unsubscribers.set(adapterId, off);
  },

  setPanelState(id, panelState) {
    set((s) => ({
      jobs: s.jobs.map((j) => (j.id === id ? { ...j, panelState } : j))
    }));
  },

  dismissJob(id) {
    const job = get().jobs.find((j) => j.id === id);
    if (!job) return;
    if (!job.done) {
      get().setPanelState(id, "minimized");
      return;
    }
    unsubscribers.get(id)?.();
    unsubscribers.delete(id);
    pendingOutput.delete(id);
    const timer = flushTimers.get(id);
    if (timer) clearTimeout(timer);
    flushTimers.delete(id);
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
  },

  isInstalling(adapterId) {
    return get().jobs.some((j) => j.adapterId === adapterId && !j.done);
  }
}));
