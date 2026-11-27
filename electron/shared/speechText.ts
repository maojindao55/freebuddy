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
