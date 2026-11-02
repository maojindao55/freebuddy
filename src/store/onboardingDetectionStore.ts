import type { CliRuntime } from "@/services/cli/types";
import { create } from "zustand";
import { cliClient } from "@/services/cli/client";
import { useCliExecutorStore } from "./cliExecutorStore";

interface State {
  phase: "idle" | "checking" | "done" | "error";
  failedIds: string[];
  discoveryRuntimes: Record<string, CliRuntime>;
  detect(): Promise<void>;
}

export const useOnboardingDetectionStore = create<State>((set, get) => ({
  phase: "idle",
  failedIds: [],
  discoveryRuntimes: {},
  async detect() {
    if (get().phase === "checking") return;
    set({ phase: "checking", failedIds: [] });
    if (!cliClient.isAvailable()) {
      set({ phase: "error" });
      return;
    }
    try {
      await useCliExecutorStore.getState().load();
      const adapters = useCliExecutorStore.getState().adapters.filter((a) => a.protocol === "acp" && a.id !== "pi-acp");
      const results = await Promise.allSettled(adapters.map((a) => useCliExecutorStore.getState().check(a.id)));
      const failedIds = adapters.filter((_, i) => results[i].status === "rejected").map((a) => a.id);
      set({ phase: failedIds.length ? "error" : "done", failedIds, discoveryRuntimes: useCliExecutorStore.getState().runtimes });
    } catch {
      set({ phase: "error" });
    }
  }
}));
