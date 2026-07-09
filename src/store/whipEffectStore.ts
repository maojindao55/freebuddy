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
  targetMessageId?: string;
  target?: WhipTargetPoint;
  trigger: (input: {
    messageId: string;
    target: WhipTargetPoint;
  }) => void;
  clear: () => void;
}

let clearTimer: number | null = null;

export const useWhipEffectStore = create<WhipEffectState>((set, get) => ({
  nonce: 0,
  active: false,
  targetMessageId: undefined,
  target: undefined,
  trigger: ({ messageId, target }) => {
    if (get().active) return;
    const nonce = get().nonce + 1;
    set({
      active: true,
      nonce,
      targetMessageId: messageId,
      target
    });
    if (clearTimer != null) window.clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => {
      clearTimer = null;
      set({
        active: false,
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
      targetMessageId: undefined,
      target: undefined
    });
  }
}));
