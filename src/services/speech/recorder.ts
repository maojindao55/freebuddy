import {
  computePeakLevel,
  computeRmsLevel,
  downsampleFloat32,
  encodePcm16Wav,
  mergeFloat32Chunks,
  mixChannelsToMono,
} from "./wavEncoder";

export const SPEECH_TARGET_SAMPLE_RATE = 16000;
export const SPEECH_DEFAULT_MAX_DURATION_SEC = 115;

export interface SpeechRecorderOptions {
  maxDurationSec?: number;
  deviceId?: string;
  onLevel?: (level: number) => void;
  onElapsed?: (elapsedMs: number) => void;
  onAutoStop?: () => void;
}

export interface SpeechRecordingOutput {
  wav: Uint8Array;
  durationMs: number;
  peak: number;
  rms: number;
}

function pickSupportedRecorderMime(): string | undefined {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return undefined;
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/webm",
  ];
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime));
}

export class SpeechRecorder {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private muteGainNode: GainNode | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedMimeType = "";
  private encodedChunks: Blob[] = [];
  private elapsedTimer: number | null = null;
  private levelTimer: number | null = null;
  private fallbackChunks: Float32Array[] = [];
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
    const deviceId = options.deviceId?.trim();
    const audioConstraint: MediaTrackConstraints | boolean = deviceId
      ? { deviceId: { ideal: deviceId } }
      : true;

    this.encodedChunks = [];
    this.fallbackChunks = [];
    this.recordedMimeType = "";
    this.autoStopFired = false;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraint,
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
      const analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 1024;
      const timeDomain = new Float32Array(analyserNode.fftSize);
      sourceNode.connect(analyserNode);

      this.stream = stream;
      this.audioContext = audioContext;
      this.sourceNode = sourceNode;
      this.analyserNode = analyserNode;
      this.sampleRate = audioContext.sampleRate;
      this.startedAt = Date.now();
      this.active = true;

      let usingMediaRecorder = false;
      if (typeof MediaRecorder !== "undefined") {
        try {
          const preferredMime = pickSupportedRecorderMime();
          const recorder = preferredMime
            ? new MediaRecorder(stream, { mimeType: preferredMime })
            : new MediaRecorder(stream);
          this.recordedMimeType = recorder.mimeType || preferredMime || "audio/webm";
          recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
              this.encodedChunks.push(event.data);
            }
          };
          recorder.start(250);
          this.mediaRecorder = recorder;
          usingMediaRecorder = true;
        } catch {
          this.mediaRecorder = null;
          this.encodedChunks = [];
          usingMediaRecorder = false;
        }
      }

      if (usingMediaRecorder) {
        this.levelTimer = window.setInterval(() => {
          if (!this.active || !this.analyserNode) return;
          this.analyserNode.getFloatTimeDomainData(timeDomain);
          options.onLevel?.(computeRmsLevel(timeDomain));
        }, 60);
      } else {
        this.attachScriptProcessorFallback(audioContext, sourceNode, options.onLevel);
      }

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

  private attachScriptProcessorFallback(
    audioContext: AudioContext,
    sourceNode: MediaStreamAudioSourceNode,
    onLevel?: (level: number) => void
  ): void {
    const channelCount = Math.max(1, Math.min(8, sourceNode.channelCount || 2));
    const processorNode = audioContext.createScriptProcessor(4096, channelCount, 1);
    const muteGainNode = audioContext.createGain();
    muteGainNode.gain.value = 0;

    processorNode.onaudioprocess = (event) => {
      if (!this.active) return;
      const channels: Float32Array[] = [];
      for (let ch = 0; ch < event.inputBuffer.numberOfChannels; ch += 1) {
        channels.push(event.inputBuffer.getChannelData(ch));
      }
      const mono = mixChannelsToMono(channels);
      this.fallbackChunks.push(mono);
      onLevel?.(computeRmsLevel(mono));
    };

    sourceNode.connect(processorNode);
    processorNode.connect(muteGainNode);
    muteGainNode.connect(audioContext.destination);

    this.processorNode = processorNode;
    this.muteGainNode = muteGainNode;
  }

  async stop(): Promise<SpeechRecordingOutput> {
    if (!this.active) {
      return {
        wav: encodePcm16Wav(new Float32Array(0), SPEECH_TARGET_SAMPLE_RATE),
        durationMs: 0,
        peak: 0,
        rms: 0,
      };
    }

    const durationMs = Math.max(0, Date.now() - this.startedAt);
    this.active = false;
    this.clearTimers();

    let sourceRate = this.sampleRate;
    let mono: Float32Array = new Float32Array(0);
    const recorder = this.mediaRecorder;
    this.mediaRecorder = null;

    if (recorder) {
      await this.stopMediaRecorder(recorder);
      const blobs = this.encodedChunks;
      this.encodedChunks = [];
      const blob = new Blob(blobs, {
        type: this.recordedMimeType || "audio/webm",
      });
      if (blob.size > 0 && this.audioContext) {
        try {
          const decoded = await this.audioContext.decodeAudioData(
            await blob.arrayBuffer()
          );
          const channelArrays: Float32Array[] = [];
          for (let ch = 0; ch < decoded.numberOfChannels; ch += 1) {
            channelArrays.push(decoded.getChannelData(ch));
          }
          mono = mixChannelsToMono(channelArrays);
          if (decoded.sampleRate > 0) {
            sourceRate = decoded.sampleRate;
          }
        } catch {
          mono = new Float32Array(0);
        }
      }
    }

    if (!mono.length && this.fallbackChunks.length > 0) {
      mono = mergeFloat32Chunks(this.fallbackChunks);
    }
    this.fallbackChunks = [];

    await this.teardown();

    const resampled = downsampleFloat32(
      mono,
      sourceRate,
      SPEECH_TARGET_SAMPLE_RATE
    );
    const peak = computePeakLevel(resampled);
    const rms = computeRmsLevel(resampled);
    const wav = encodePcm16Wav(resampled, SPEECH_TARGET_SAMPLE_RATE);
    return { wav, durationMs, peak, rms };
  }

  cancel(): void {
    this.active = false;
    this.encodedChunks = [];
    this.fallbackChunks = [];
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      try {
        this.mediaRecorder.stop();
      } catch {
        // ignore stop error during cancel
      }
    }
    this.mediaRecorder = null;
    void this.teardown();
  }

  private async stopMediaRecorder(recorder: MediaRecorder): Promise<void> {
    if (recorder.state === "inactive") return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(safetyTimer);
        resolve();
      };
      const safetyTimer = window.setTimeout(done, 1500);
      recorder.onstop = () => done();
      recorder.onerror = () => done();
      try {
        recorder.stop();
      } catch {
        done();
      }
    });
  }

  private clearTimers(): void {
    if (this.elapsedTimer !== null) {
      window.clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    if (this.levelTimer !== null) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
  }

  private teardownNodes(): void {
    this.clearTimers();
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      try {
        this.processorNode.disconnect();
      } catch {
        // ignore disconnect errors during cleanup
      }
      this.processorNode = null;
    }
    if (this.analyserNode) {
      try {
        this.analyserNode.disconnect();
      } catch {
        // ignore
      }
      this.analyserNode = null;
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
