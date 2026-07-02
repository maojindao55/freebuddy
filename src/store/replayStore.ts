import { create } from "zustand";

export const REPLAY_SPEEDS = [1, 1.5, 2, 4, 8] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
export const REPLAY_DEFAULT_SPEED: ReplaySpeed = 1.5;
export const REPLAY_BASE_INTERVAL_MS = 800;
export const REPLAY_TYPING_INTERVAL_MS = 32;
export const REPLAY_TYPING_STEP = 3;

export interface ReplayFrame {
  messageIndex: number;
  blockLimit?: number;
  typingChars?: number;
}

export interface ReplayState {
  conversationId: string | null;
  frames: ReplayFrame[];
  index: number;
  playing: boolean;
  speed: number;
  start(conversationId: string, frames: ReplayFrame[]): void;
  stop(): void;
  play(): void;
  pause(): void;
  toggle(): void;
  next(): void;
  prev(): void;
  setIndex(i: number): void;
  setSpeed(s: number): void;
}

const EMPTY = {
  conversationId: null as string | null,
  frames: [] as ReplayFrame[],
  index: -1,
  playing: false
};

export function clampIndex(i: number, total: number): number {
  if (total <= 0) return -1;
  if (i < -1) return -1;
  if (i > total - 1) return total - 1;
  return i;
}

export function splitTextSteps(text: string): number[] {
  const len = text.length;
  if (len <= 0) return [];
  if (len <= REPLAY_TYPING_STEP) return [len];
  const steps: number[] = [];
  for (let k = REPLAY_TYPING_STEP; k < len; k += REPLAY_TYPING_STEP) {
    steps.push(k);
  }
  steps.push(len);
  return steps;
}

export const useReplayStore = create<ReplayState>((set, get) => ({
  ...EMPTY,
  speed: REPLAY_DEFAULT_SPEED,

  start(conversationId, frames) {
    set({ ...EMPTY, conversationId, frames, speed: REPLAY_DEFAULT_SPEED });
  },
  stop() {
    set({ ...EMPTY });
  },
  play() {
    const total = get().frames.length;
    const index = get().index;
    if (total <= 0) return;
    const atEnd = index >= total - 1;
    set({ playing: true, index: atEnd ? -1 : index });
  },
  pause() {
    set({ playing: false });
  },
  toggle() {
    const { playing } = get();
    if (playing) {
      get().pause();
    } else {
      get().play();
    }
  },
  next() {
    const { index, frames, playing } = get();
    const total = frames.length;
    if (total <= 0) return;
    const atEnd = index >= total - 1;
    if (atEnd) {
      set({ index: total - 1, playing: false });
      return;
    }
    set({ index: index + 1, playing });
  },
  prev() {
    const { index, frames } = get();
    set({ index: clampIndex(index - 1, frames.length) });
  },
  setIndex(i) {
    set({ index: clampIndex(i, get().frames.length), playing: false });
  },
  setSpeed(s) {
    set({ speed: s });
  }
}));
