import { create } from "zustand";
import {
  speechClient,
  type SpeechConfigSnapshot,
  type SpeechPreferences,
  type SpeechProviderConfig,
  type SpeechProviderConfigUpdate,
  type SpeechProviderKind,
  type SpeechTestRequest,
  type SpeechTestResult,
  type SpeechTranscribeResult,
} from "@/services/speech/client";
import {
  speechPlayer,
  type SpeechPlaybackStatus,
} from "@/services/speech/player";

interface SpeechState {
  config: SpeechConfigSnapshot | null;
  loaded: boolean;
  loading: boolean;
  error?: string;
  speakingMessageId: string | null;
  playbackStatus: SpeechPlaybackStatus;
  playbackError?: string;
  load(): Promise<void>;
  refresh(): Promise<void>;
  saveProvider(input: SpeechProviderConfigUpdate): Promise<SpeechProviderConfig>;
  savePreferences(patch: Partial<SpeechPreferences>): Promise<SpeechPreferences>;
  testProvider(req: SpeechTestRequest): Promise<SpeechTestResult>;
  transcribe(
    audio: Uint8Array,
    options?: { requestId?: string; mimeType?: string; provider?: SpeechProviderKind }
  ): Promise<SpeechTranscribeResult>;
  speakMessage(messageId: string, text: string): Promise<void>;
  playPreview(id: string, audio: Uint8Array, mimeType: string): Promise<void>;
  stopSpeaking(): void;
}

export const useSpeechStore = create<SpeechState>((set, get) => {
  speechPlayer.subscribe((snap) => {
    set({
      speakingMessageId: snap.activeMessageId,
      playbackStatus: snap.status,
      playbackError: snap.error,
    });
  });

  return {
    config: null,
    loaded: false,
    loading: false,
    error: undefined,
    speakingMessageId: null,
    playbackStatus: "idle",
    playbackError: undefined,

    async load() {
      if (get().loaded || get().loading) return;
      await get().refresh();
    },

    async refresh() {
      if (!speechClient.isAvailable()) {
        set({ loaded: true, loading: false, config: null });
        return;
      }
      set({ loading: true, error: undefined });
      try {
        const config = await speechClient.getConfig();
        set({ config, loaded: true, error: undefined });
      } catch (err) {
        set({
          loaded: true,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        set({ loading: false });
      }
    },

    async saveProvider(input) {
      const saved = await speechClient.saveProvider(input);
      await get().refresh();
      return saved;
    },

    async savePreferences(patch) {
      const prefs = await speechClient.savePreferences(patch);
      set((state) => ({
        config: state.config ? { ...state.config, preferences: prefs } : state.config,
      }));
      return prefs;
    },

    async testProvider(req) {
      const result = await speechClient.testProvider(req);
      if (!req.draft) {
        await get().refresh();
      }
      return result;
    },

    async transcribe(audio, options) {
      return speechClient.transcribe({
        audio,
        mimeType: options?.mimeType ?? "audio/wav",
        requestId: options?.requestId,
        provider: options?.provider,
      });
    },

    async speakMessage(messageId, text) {
      if (!get().loaded) {
        await get().load();
      }
      const prefs = get().config?.preferences;
      if (!prefs || !prefs.activeTtsProvider) {
        throw new Error("TTS provider not configured");
      }
      await speechPlayer.speakMessage(messageId, text, prefs);
    },

    async playPreview(id, audio, mimeType) {
      const rate = get().config?.preferences.ttsPlaybackRate ?? 1.0;
      await speechPlayer.playPreview(id, audio, mimeType, rate);
    },

    stopSpeaking() {
      speechPlayer.stop();
    },
  };
});
