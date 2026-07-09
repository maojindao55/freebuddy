import { create } from "zustand";

export const WHIP_EFFECT_MS = 2300;
export const WHIP_HIT_AT_MS = 1050;

export interface WhipTargetPoint {
  /** Center X of the avatar, relative to the chat-view overlay. */
  x: number;
  /** Center Y of the avatar, relative to the chat-view overlay. */
  y: number;
}

interface WhipEffectState {
  nonce: number;
  active: boolean;
  /** Whip power for the current shot (drives lash force + feedback). ~0.6–1.6. */
  power: number;
  targetMessageId?: string;
  target?: WhipTargetPoint;
  trigger: (input: {
    messageId: string;
    target: WhipTargetPoint;
    power: number;
  }) => void;
  clear: () => void;
}

let clearTimer: number | null = null;

export const useWhipEffectStore = create<WhipEffectState>((set, get) => ({
  nonce: 0,
  active: false,
  power: 1,
  targetMessageId: undefined,
  target: undefined,
  trigger: ({ messageId, target, power }) => {
    if (get().active) return;
    const nonce = get().nonce + 1;
    set({
      active: true,
      nonce,
      power,
      targetMessageId: messageId,
      target
    });
    if (clearTimer != null) window.clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => {
      clearTimer = null;
      set({
        active: false,
        power: 1,
        targetMessageId: undefined,
        target: undefined
      });
    }, WHIP_EFFECT_MS);
  },
  clear: () => {
    if (clearTimer != null) {
      window.clearTimeout(clearTimer);
      clearTimer = null;
    }
    set({
      active: false,
      power: 1,
      targetMessageId: undefined,
      target: undefined
    });
  }
}));
