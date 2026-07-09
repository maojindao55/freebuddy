import { create } from "zustand";

export const WHIP_EFFECT_MS = 1200;

interface WhipEffectState {
  nonce: number;
  active: boolean;
  trigger: () => void;
  clear: () => void;
}

let clearTimer: number | null = null;

export const useWhipEffectStore = create<WhipEffectState>((set, get) => ({
  nonce: 0,
  active: false,
  trigger: () => {
    if (get().active) return;
    const nonce = get().nonce + 1;
    set({ active: true, nonce });
    if (clearTimer != null) window.clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => {
      clearTimer = null;
      set({ active: false });
    }, WHIP_EFFECT_MS);
  },
  clear: () => {
    if (clearTimer != null) {
      window.clearTimeout(clearTimer);
      clearTimer = null;
    }
    set({ active: false });
  }
}));
