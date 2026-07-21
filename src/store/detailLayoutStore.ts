import { create } from "zustand";

import { cliClient } from "@/services/cli/client";

const OVERVIEW_KEY = "detailOverviewWidth";
const PREVIEW_KEY = "detailPreviewWidth";
const COLLAPSED_KEY = "detailCollapsed";

export const DEFAULT_OVERVIEW_WIDTH = 360;
export const DEFAULT_PREVIEW_WIDTH = 680;
export const DETAIL_MIN_WIDTH = 320;
export const DETAIL_MAX_WIDTH = 960;

export type DetailTab = "overview" | "preview";

function clampWidth(value: number): number {
  return Math.min(
    DETAIL_MAX_WIDTH,
    Math.max(DETAIL_MIN_WIDTH, Math.round(value))
  );
}

interface DetailLayoutState {
  overviewWidth: number;
  previewWidth: number;
  activeTab: DetailTab;
  detailCollapsed: boolean;
  loaded: boolean;
  load(): Promise<void>;
  setActiveTab(tab: DetailTab): void;
  setWidth(width: number): void;
  setDetailCollapsed(collapsed: boolean): void;
  toggleDetailCollapsed(): void;
}

export const useDetailLayoutStore = create<DetailLayoutState>((set, get) => ({
  overviewWidth: DEFAULT_OVERVIEW_WIDTH,
  previewWidth: DEFAULT_PREVIEW_WIDTH,
  activeTab: "overview",
  detailCollapsed: false,
  loaded: false,

  async load() {
    if (get().loaded) return;
    let overviewWidth = DEFAULT_OVERVIEW_WIDTH;
    let previewWidth = DEFAULT_PREVIEW_WIDTH;
    let detailCollapsed = false;
    try {
      const o = await cliClient.getSetting(OVERVIEW_KEY);
      if (o) {
        const n = Number(o);
        if (Number.isFinite(n)) overviewWidth = clampWidth(n);
      }
      const p = await cliClient.getSetting(PREVIEW_KEY);
      if (p) {
        const n = Number(p);
        if (Number.isFinite(n)) previewWidth = clampWidth(n);
      }
      const c = await cliClient.getSetting(COLLAPSED_KEY);
      if (c === "true") detailCollapsed = true;
    } catch {
      // ignore — fall back to defaults
    }
    set({ overviewWidth, previewWidth, detailCollapsed, loaded: true });
  },

  setActiveTab(tab) {
    set({ activeTab: tab });
  },

  setWidth(width) {
    const clamped = clampWidth(width);
    if (get().activeTab === "overview") {
      set({ overviewWidth: clamped });
      void cliClient.setSetting(OVERVIEW_KEY, String(clamped)).catch(() => {
        // ignore persistence failures
      });
    } else {
      set({ previewWidth: clamped });
      void cliClient.setSetting(PREVIEW_KEY, String(clamped)).catch(() => {
        // ignore persistence failures
      });
    }
  },

  setDetailCollapsed(collapsed) {
    set({ detailCollapsed: collapsed });
    void cliClient.setSetting(COLLAPSED_KEY, String(collapsed)).catch(() => {
      // ignore persistence failures
    });
  },

  toggleDetailCollapsed() {
    get().setDetailCollapsed(!get().detailCollapsed);
  }
}));

export function selectDetailWidth(state: DetailLayoutState): number {
  return state.activeTab === "overview"
    ? state.overviewWidth
    : state.previewWidth;
}
