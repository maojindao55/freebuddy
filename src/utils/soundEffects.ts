import { debugLogClient } from "@/services/debugLog";

const baseUrl = import.meta.env?.BASE_URL ?? "./";

const SOUNDS = {
  success: `${baseUrl}sounds/finish.mp3`,
  failure: `${baseUrl}sounds/failed.mp3`
} as const;

let audioCache: Partial<Record<keyof typeof SOUNDS, HTMLAudioElement>> = {};

function getAudio(kind: keyof typeof SOUNDS): HTMLAudioElement | undefined {
  if (audioCache[kind]) return audioCache[kind];
  try {
    const audio = new Audio(SOUNDS[kind]);
    audio.preload = "auto";
    audio.volume = 0.7;
    audioCache[kind] = audio;
    return audio;
  } catch {
    return undefined;
  }
}

let windowBlurred = false;
if (typeof window !== "undefined") {
  window.addEventListener("blur", () => {
    windowBlurred = true;
  });
  window.addEventListener("focus", () => {
    windowBlurred = false;
  });
}

export function isAppInBackground(): boolean {
  if (typeof document === "undefined") return false;
  return document.hidden || windowBlurred;
}

export function playTaskSuccess(backgroundOnly = true): void {
  if (backgroundOnly && !isAppInBackground()) return;
  const audio = getAudio("success");
  if (!audio) return;
  audio.currentTime = 0;
  void audio.play().catch((err: unknown) => {
    debugLogClient.error("sound", "success sound failed", {
      src: audio.currentSrc,
      message: err instanceof Error ? err.message : String(err)
    });
  });
}

export function playTaskFailure(backgroundOnly = true): void {
  if (backgroundOnly && !isAppInBackground()) return;
  const audio = getAudio("failure");
  if (!audio) return;
  audio.currentTime = 0;
  void audio.play().catch((err: unknown) => {
    debugLogClient.error("sound", "failure sound failed", {
      src: audio.currentSrc,
      message: err instanceof Error ? err.message : String(err)
    });
  });
}

export function notifyTaskFinished(
  kind: "success" | "failure",
  title: string,
  body?: string,
  conversationId?: string
): void {
  const documentHidden = typeof document !== "undefined" ? document.hidden : false;
  const background = isAppInBackground();
  debugLogClient.info("notification", "notifyTaskFinished evaluated", {
    kind,
    documentHidden,
    windowBlurred,
    isAppInBackground: background,
    willNotify: background,
    conversationId
  });
  if (!background) return;
  window.freebuddy?.window?.notifyTask
    ?.({ kind, title, body, conversationId })
    ?.catch(() => {});
}
