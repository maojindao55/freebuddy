import {
  computeRmsLevel,
  downsampleFloat32,
  encodePcm16Wav,
  mergeFloat32Chunks,
} from "./wavEncoder";

export const SPEECH_TARGET_SAMPLE_RATE = 16000;
export const SPEECH_DEFAULT_MAX_DURATION_SEC = 115;

export interface SpeechRecorderOptions {
  maxDurationSec?: number;
  onLevel?: (level: number) => void;
  onElapsed?: (elapsedMs: number) => void;
  onAutoStop?: () => void;
}

export interface SpeechRecordingOutput {
  wav: Uint8Array;
  durationMs: number;
}

export class SpeechRecorder {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private muteGainNode: GainNode | null = null;
  private elapsedTimer: number | null = null;
  private chunks: Float32Array[] = [];
  private sampleRate = 48000;
  private startedAt = 0;
  private active = false;
  private autoStopFired = false;

  get isRecording(): boolean {
    return this.active;
  }

  async start(options: SpeechRecorderOptions = {}): Promise<void> {
    if (this.active) {
      throw new Error("Recorder already active");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone capture is unavailable in this environment");
    }

    const maxDurationSec = options.maxDurationSec ?? SPEECH_DEFAULT_MAX_DURATION_SEC;
    this.chunks = [];
    this.autoStopFired = false;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioContext = new AudioCtx();
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      const sourceNode = audioContext.createMediaStreamSource(stream);
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      const muteGainNode = audioContext.createGain();
      muteGainNode.gain.value = 0;

      this.stream = stream;
      this.audioContext = audioContext;
      this.sourceNode = sourceNode;
      this.processorNode = processorNode;
      this.muteGainNode = muteGainNode;
      this.sampleRate = audioContext.sampleRate;
      this.startedAt = Date.now();
      this.active = true;

      processorNode.onaudioprocess = (event) => {
        if (!this.active) return;
        const input = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        this.chunks.push(copy);
        options.onLevel?.(computeRmsLevel(copy));
      };

      sourceNode.connect(processorNode);
      processorNode.connect(muteGainNode);
      muteGainNode.connect(audioContext.destination);

      this.elapsedTimer = window.setInterval(() => {
        if (!this.active) return;
        const elapsedMs = Date.now() - this.startedAt;
        options.onElapsed?.(elapsedMs);
        if (!this.autoStopFired && elapsedMs >= maxDurationSec * 1000) {
          this.autoStopFired = true;
          options.onAutoStop?.();
        }
      }, 200);
    } catch (err) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      this.teardownNodes();
      throw err;
    }
  }

  async stop(): Promise<SpeechRecordingOutput> {
    if (!this.active) {
      return {
        wav: encodePcm16Wav(new Float32Array(0), SPEECH_TARGET_SAMPLE_RATE),
        durationMs: 0,
      };
    }

    const durationMs = Math.max(0, Date.now() - this.startedAt);
    const sourceRate = this.sampleRate;
    const collected = this.chunks;
    this.active = false;
    this.chunks = [];
    await this.teardown();

    const merged = mergeFloat32Chunks(collected);
    const resampled = downsampleFloat32(
      merged,
      sourceRate,
      SPEECH_TARGET_SAMPLE_RATE
    );
    const wav = encodePcm16Wav(resampled, SPEECH_TARGET_SAMPLE_RATE);
    return { wav, durationMs };
  }

  cancel(): void {
    this.active = false;
    this.chunks = [];
    void this.teardown();
  }

  private teardownNodes(): void {
    if (this.elapsedTimer !== null) {
      window.clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      try {
        this.processorNode.disconnect();
      } catch {
        // ignore disconnect errors during cleanup
      }
      this.processorNode = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }
    if (this.muteGainNode) {
      try {
        this.muteGainNode.disconnect();
      } catch {
        // ignore
      }
      this.muteGainNode = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      this.stream = null;
    }
  }

  private async teardown(): Promise<void> {
    this.teardownNodes();
    if (this.audioContext) {
      const ctx = this.audioContext;
      this.audioContext = null;
      if (ctx.state !== "closed") {
        await ctx.close().catch(() => {});
      }
    }
  }
}
