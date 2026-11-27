import i18next from "i18next";
import {
  chunkTextForSpeech,
  cleanTextForSpeech,
} from "../../../electron/shared/speechText";
import { speechClient, type SpeechPreferences } from "./client";

export type SpeechPlaybackStatus = "idle" | "loading" | "playing" | "error";

export interface SpeechPlaybackSnapshot {
  activeMessageId: string | null;
  status: SpeechPlaybackStatus;
  error?: string;
}

type PlaybackListener = (snapshot: SpeechPlaybackSnapshot) => void;

class SpeechPlaybackController {
  private snapshot: SpeechPlaybackSnapshot = {
    activeMessageId: null,
    status: "idle",
  };
  private listeners = new Set<PlaybackListener>();
  private runToken = 0;
  private activeAudio: HTMLAudioElement | null = null;
  private activeObjectUrl: string | null = null;
  private activeAudioReject: ((err?: unknown) => void) | null = null;
  private inFlightRequestIds = new Set<string>();

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): SpeechPlaybackSnapshot {
    return this.snapshot;
  }

  private emit(next: SpeechPlaybackSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  private cleanupAudio(): void {
    if (this.activeAudio) {
      this.activeAudio.onended = null;
      this.activeAudio.onerror = null;
      try {
        this.activeAudio.pause();
        this.activeAudio.removeAttribute("src");
        this.activeAudio.load();
      } catch {
        // ignore audio cleanup failures
      }
      this.activeAudio = null;
    }
    if (this.activeObjectUrl) {
      try {
        URL.revokeObjectURL(this.activeObjectUrl);
      } catch {
        // ignore
      }
      this.activeObjectUrl = null;
    }
    if (this.activeAudioReject) {
      const reject = this.activeAudioReject;
      this.activeAudioReject = null;
      reject(new Error("stopped"));
    }
  }

  stop(): void {
    this.runToken += 1;
    const ids = [...this.inFlightRequestIds];
    this.inFlightRequestIds.clear();
    for (const id of ids) {
      if (speechClient.isAvailable()) {
        void speechClient.cancel(id).catch(() => {});
      }
    }
    this.cleanupAudio();
    this.emit({ activeMessageId: null, status: "idle" });
  }

  private playSingleBuffer(
    token: number,
    audioBytes: Uint8Array,
    mimeType: string,
    playbackRate: number
  ): Promise<void> {
    if (this.runToken !== token) return Promise.resolve();
    this.cleanupAudio();

    const copy = new Uint8Array(audioBytes.byteLength);
    copy.set(audioBytes);
    const blob = new Blob([copy.buffer], { type: mimeType || "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.playbackRate = Math.min(Math.max(playbackRate || 1.0, 0.5), 2.0);

    this.activeObjectUrl = url;
    this.activeAudio = audio;

    return new Promise<void>((resolve, reject) => {
      this.activeAudioReject = reject;

      const finish = (err?: unknown) => {
        if (this.activeAudio === audio) {
          this.activeAudioReject = null;
          this.cleanupAudio();
        } else {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // ignore
          }
        }
        if (err) reject(err);
        else resolve();
      };

      audio.onended = () => finish();
      audio.onerror = () => finish(new Error("Failed to decode or play synthesized audio"));

      void audio.play().catch((err) => finish(err));
    });
  }

  async playPreview(
    id: string,
    audioBytes: Uint8Array,
    mimeType: string,
    playbackRate = 1.0
  ): Promise<void> {
    this.stop();
    const token = this.runToken;
    this.emit({ activeMessageId: id, status: "playing" });
    try {
      await this.playSingleBuffer(token, audioBytes, mimeType, playbackRate);
      if (this.runToken === token) {
        this.emit({ activeMessageId: null, status: "idle" });
      }
    } catch (err) {
      if (this.runToken !== token) return;
      this.emit({
        activeMessageId: id,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async speakMessage(
    messageId: string,
    rawText: string,
    prefs: SpeechPreferences
  ): Promise<void> {
    this.stop();
    const token = this.runToken;

    const cleaned = cleanTextForSpeech(rawText, {
      stripCodeBlocks: prefs.ttsStripCodeBlocks,
      stripMarkdown: prefs.ttsStripMarkdown,
    });
    const chunks = chunkTextForSpeech(cleaned, prefs.ttsMaxChunkChars);
    if (chunks.length === 0) {
      this.emit({
        activeMessageId: messageId,
        status: "error",
        error: i18next.t("speech.emptyText"),
      });
      return;
    }

    const requestChunk = (idx: number) => {
      const requestId = `tts-${token}-${idx}`;
      this.inFlightRequestIds.add(requestId);
      return speechClient
        .synthesize({
          requestId,
          text: chunks[idx],
          stripCodeBlocks: false,
          stripMarkdown: false,
        })
        .finally(() => {
          this.inFlightRequestIds.delete(requestId);
        });
    };

    try {
      let nextPromise = requestChunk(0);

      for (let i = 0; i < chunks.length; i += 1) {
        if (this.runToken !== token) return;
        this.emit({ activeMessageId: messageId, status: "loading" });

        const synthesized = await nextPromise;
        if (this.runToken !== token) return;

        // Prefetch the next chunk while playing the current one to keep speech seamless.
        if (i + 1 < chunks.length) {
          nextPromise = requestChunk(i + 1);
        }

        this.emit({ activeMessageId: messageId, status: "playing" });
        await this.playSingleBuffer(
          token,
          synthesized.audio,
          synthesized.mimeType,
          prefs.ttsPlaybackRate
        );
      }

      if (this.runToken === token) {
        this.emit({ activeMessageId: null, status: "idle" });
      }
    } catch (err) {
      if (this.runToken !== token) return;
      const message = err instanceof Error ? err.message : String(err);
      if (message === "stopped" || /cancelled/i.test(message)) {
        this.emit({ activeMessageId: null, status: "idle" });
        return;
      }
      this.emit({
        activeMessageId: messageId,
        status: "error",
        error: message,
      });
    }
  }
}

export const speechPlayer = new SpeechPlaybackController();
