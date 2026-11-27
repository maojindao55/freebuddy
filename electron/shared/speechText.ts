export interface CleanTextForSpeechOptions {
  stripCodeBlocks?: boolean;
  stripMarkdown?: boolean;
}

/**
 * Strips fenced code blocks, Markdown formatting, and bare URLs so TTS engines
 * read natural prose instead of punctuation and file paths.
 */
export function cleanTextForSpeech(
  text: string,
  options?: CleanTextForSpeechOptions
): string {
  const stripCodeBlocks = options?.stripCodeBlocks !== false;
  const stripMarkdown = options?.stripMarkdown !== false;

  let out = (text ?? "").replace(/\r\n?/g, "\n");
  if (!out.trim()) return "";

  if (stripCodeBlocks) {
    // Remove fenced code blocks (```...``` or ~~~...~~~)
    out = out.replace(/```[\s\S]*?```/g, "\n").replace(/~~~[\s\S]*?~~~/g, "\n");
    // Also drop trailing unclosed fence if a partial stream snippet was passed
    out = out.replace(/```[\s\S]*$/g, "\n");
  }

  if (stripMarkdown) {
    // Replace Markdown images ![alt](url) -> alt
    out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
    // Replace Markdown links [label](url) -> label
    out = out.replace(/\[([^\]]+)\]\((?:[^()]+|\([^()]*\))*\)/g, "$1");
    // Remove reference-style link definitions [id]: https://...
    out = out.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "");
    // Remove bare HTTP(S) URLs
    out = out.replace(/https?:\/\/[^\s<>()]+/gi, "");
    // Remove inline code backticks while preserving inner identifier/text
    out = out.replace(/`+([^`]+)`+/g, "$1");
    // Remove Markdown table divider rows like | --- | :---: |
    out = out.replace(/^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/gm, "");
    // Turn Markdown table pipes into spaces
    out = out.replace(/\|/g, " ");
    // Remove horizontal rules
    out = out.replace(/^\s*(?:[-*_]\s*){3,}$/gm, "");
    // Remove heading prefixes (#, ##, ...) and blockquote prefixes (>)
    out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
    out = out.replace(/^\s{0,3}(?:>\s*)+/gm, "");
    // Remove list item bullets / task checkboxes while keeping content
    out = out.replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/gm, "");
    out = out.replace(/^\s*\d+\.\s+/gm, "");
    // Strip emphasis / strikethrough markers without touching math or underscores inside words
    out = out.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
    out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
    out = out.replace(/__([^_]+)__/g, "$1");
    out = out.replace(/~~([^~]+)~~/g, "$1");
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:'"”’]|$)/g, "$1$2");
    // Remove leftover HTML tags commonly emitted in Markdown
    out = out.replace(/<\/?[a-z][^>\n]*>/gi, "");
  }

  // Collapse excessive whitespace and blank lines
  out = out
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  return out;
}

function splitLongSentence(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];
  const parts: string[] = [];
  let remaining = sentence;
  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars);
    // Prefer breaking at comma/clause punctuation or whitespace
    let cut = -1;
    for (let i = slice.length - 1; i >= Math.floor(maxChars * 0.4); i -= 1) {
      if (/[，,、；;：\s]/.test(slice[i])) {
        cut = i + 1;
        break;
      }
    }
    if (cut <= 0) cut = maxChars;
    const head = remaining.slice(0, cut).trim();
    if (head) parts.push(head);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

/**
 * Splits speech-cleaned text into natural sentence-aligned chunks <= maxChars
 * so long responses stay within vendor limits and start speaking quickly.
 */
export function chunkTextForSpeech(text: string, maxChars = 500): string[] {
  const limit = Math.max(50, Math.floor(maxChars || 500));
  const normalized = (text ?? "").trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = "";
  };

  for (const paragraph of paragraphs) {
    // Split on CJK sentence terminators or ASCII sentence endings followed by whitespace/end
    const rawSentences = paragraph
      .split(/(?<=[。！？!?；;])|(?<=\.)\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const units = rawSentences.flatMap((s) => splitLongSentence(s, limit));
    for (const unit of units) {
      if (!current) {
        current = unit;
        continue;
      }
      const sep = /[\x00-\x7F]$/.test(current) && /^[\x00-\x7F]/.test(unit) ? " " : "";
      if (current.length + sep.length + unit.length <= limit) {
        current = `${current}${sep}${unit}`;
      } else {
        flush();
        current = unit;
      }
    }
    flush();
  }

  flush();
  return chunks;
}

/**
 * Builds a minimal valid 16-bit mono PCM WAV buffer (used for ASR probe tests).
 */
export function buildSilentWav(durationMs = 600, sampleRate = 16000): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const numSamples = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const dataByteLength = numSamples * numChannels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
  view.setUint16(32, numChannels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataByteLength, true);

  return new Uint8Array(buffer);
}

export interface WavInspection {
  valid: boolean;
  sampleRate: number;
  channels: number;
  dataBytes: number;
  durationMs: number;
  peak: number;
  rms: number;
}

/**
 * Inspects a PCM16 WAV buffer for header integrity and peak/RMS amplitude.
 */
export function inspectPcm16Wav(wav: Uint8Array): WavInspection {
  const empty: WavInspection = {
    valid: false,
    sampleRate: 0,
    channels: 0,
    dataBytes: 0,
    durationMs: 0,
    peak: 0,
    rms: 0,
  };
  if (wav.byteLength < 44) return empty;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const readAscii = (offset: number, len: number): string => {
    let out = "";
    for (let i = 0; i < len && offset + i < wav.byteLength; i += 1) {
      out += String.fromCharCode(view.getUint8(offset + i));
    }
    return out;
  };
  if (readAscii(0, 4) !== "RIFF" || readAscii(8, 4) !== "WAVE") {
    return empty;
  }

  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  let offset = 12;
  while (offset + 8 <= wav.byteLength) {
    const chunkId = readAscii(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataStart = offset + 8;
    if (chunkId === "fmt " && chunkDataStart + 16 <= wav.byteLength) {
      audioFormat = view.getUint16(chunkDataStart, true);
      channels = view.getUint16(chunkDataStart + 2, true);
      sampleRate = view.getUint32(chunkDataStart + 4, true);
      bitsPerSample = view.getUint16(chunkDataStart + 14, true);
    } else if (chunkId === "data") {
      dataOffset = chunkDataStart;
      dataBytes = Math.min(chunkSize, Math.max(0, wav.byteLength - chunkDataStart));
      break;
    }
    if (chunkSize === 0 && chunkId !== "data") {
      break;
    }
    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (
    audioFormat !== 1 ||
    bitsPerSample !== 16 ||
    channels <= 0 ||
    sampleRate <= 0 ||
    dataOffset < 0
  ) {
    return {
      ...empty,
      sampleRate,
      channels,
      dataBytes,
    };
  }

  const sampleCount = Math.floor(dataBytes / 2);
  let maxAbs = 0;
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const raw = view.getInt16(dataOffset + i * 2, true);
    const norm = Math.abs(raw) / 32768;
    if (norm > maxAbs) maxAbs = norm;
    sumSq += norm * norm;
  }

  const frames = Math.floor(sampleCount / channels);
  const durationMs = Math.round((frames / sampleRate) * 1000);
  const peak = Math.min(1, maxAbs);
  const rms = sampleCount > 0 ? Math.min(1, Math.sqrt(sumSq / sampleCount)) : 0;

  return {
    valid: true,
    sampleRate,
    channels,
    dataBytes,
    durationMs,
    peak,
    rms,
  };
}
