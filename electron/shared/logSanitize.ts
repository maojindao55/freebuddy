/**
 * Pure log-sanitization helpers shared by write-time redaction and
 * export-time filtering. No Node/Electron imports so tests can transpile
 * and load this file directly (see tests/log-sanitize.test.mjs).
 */

export type ExportMode = "standard" | "full";

/** data keys whose values are user message content, stripped in standard mode. */
export const CONTENT_KEYS: ReadonlySet<string> = new Set([
  "content",
  "prompt",
  "messageText",
  "output"
]);

export function redactedLengthMarker(length: number): string {
  return `<redacted: ${length} chars>`;
}

const secret_RULES: Array<[RegExp, (...args: string[]) => string]> = [
  [
    /(\\"name\\"\s*:\s*\\"[^"\\]*(?:token|key|secret|password)[^"\\]*\\"\s*,\s*\\"value\\"\s*:\s*\\")((?:\\.|[^"\\])*)(\\")/gi,
    (_m, prefix, _value, suffix) => `${prefix}<redacted>${suffix}`
  ],
  [
    /("name"\s*:\s*"[^"]*(?:token|key|secret|password)[^"]*"\s*,\s*"value"\s*:\s*")([^"]*)(")/gi,
    (_m, prefix, _value, suffix) => `${prefix}<redacted>${suffix}`
  ],
  [/Authorization(["'\s:=]+)[^\s"',\]}]{8,}/gi, (_m, sep) => `Authorization${sep}<redacted>`],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, () => "Bearer <redacted>"],
  [/sk-[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, 6)}…<redacted>`],
  [
    /((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|secret)["'\s:=]+)[^\s"',\]}]{8,}/gi,
    (_m, prefix) => `${prefix}<redacted>`
  ]
];

/** Mask API keys / tokens. Safe on JSON text: replacements contain no quotes. */
export function redactsecrets(text: string): string {
  let out = text;
  for (const [re, repl] of secret_RULES) out = out.replace(re, repl);
  return out;
}

export interface PathMask {
  prefix: string;
  label: string;
}

/** Longest-first so more specific paths (userData under home) win. */
export function buildPathMasks(input: {
  home: string;
  userData: string;
  workspaces: string[];
}): PathMask[] {
  const masks: PathMask[] = [
    { prefix: input.userData, label: "<appdata>" },
    { prefix: input.home, label: "<home>" },
    ...input.workspaces.map((prefix) => ({ prefix, label: "<workspace>" }))
  ].filter((m) => m.prefix.length > 0);
  return masks.sort((a, b) => b.prefix.length - a.prefix.length);
}

export function maskPaths(text: string, masks: PathMask[]): string {
  let out = text;
  for (const { prefix, label } of masks) {
    if (out.includes(prefix)) out = out.split(prefix).join(label);
  }
  return out;
}

/**
 * Recursive standard-mode filtering for our own log lines' `data` payloads.
 * CONTENT_KEYS are stripped at every depth; strings are masked; plain objects
 * and arrays are recursed into. Depth is capped to bound circular/deep
 * structures — beyond the cap values pass through unchanged.
 */
const MAX_SANITIZE_DEPTH = 6;

export function sanitizeLogData(data: unknown, masks: PathMask[]): unknown {
  return sanitizeValue(data, masks, 0);
}

function sanitizeValue(value: unknown, masks: PathMask[], depth: number): unknown {
  if (typeof value === "string") return maskPaths(redactsecrets(value), masks);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_SANITIZE_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, masks, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (CONTENT_KEYS.has(key) && typeof v === "string") {
      out[key] = redactedLengthMarker(v.length);
    } else {
      out[key] = sanitizeValue(v, masks, depth + 1);
    }
  }
  return out;
}

/** Export-time filter for one line of our own main/renderer JSONL logs. */
export function filterOwnLogLine(
  line: string,
  mode: ExportMode,
  masks: PathMask[]
): string {
  if (mode === "full") return redactsecrets(line);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return maskPaths(redactsecrets(line), masks);
  }
  const out: Record<string, unknown> = { ...obj };
  if (typeof out.msg === "string") out.msg = maskPaths(redactsecrets(out.msg), masks);
  if ("data" in out) out.data = sanitizeLogData(out.data, masks);
  return JSON.stringify(out);
}

/**
 * Export-time filter for one line of cli-logs/<sessionId>.jsonl
 * ({ts, type: "stdin"|"stdout"|"stderr"|"system", content}).
 * Standard mode keeps structure + numeric metadata + error messages,
 * replaces protocol payloads with a length marker.
 */
export function filterSessionLogLine(
  line: string,
  mode: ExportMode,
  masks: PathMask[]
): string {
  if (mode === "full") return redactsecrets(line);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return JSON.stringify({ type: "unparsed", content: redactedLengthMarker(line.length) });
  }
  const type = typeof obj.type === "string" ? obj.type : "unknown";
  const content = typeof obj.content === "string" ? obj.content : "";
  if (type === "system" || type === "stderr") {
    // Explicit field list: unknown extra fields must not leak through.
    return JSON.stringify({
      ts: obj.ts ?? null,
      type,
      content: maskPaths(redactsecrets(content), masks)
    });
  }
  const summary: Record<string, unknown> = { ts: obj.ts ?? null, type };
  try {
    const payload = JSON.parse(content) as Record<string, unknown>;
    const msg = (payload?.msg ?? payload) as Record<string, unknown>;
    if (typeof msg?.type === "string") summary.event = msg.type;
    else if (typeof payload?.method === "string") summary.event = payload.method;
    const err = (payload?.error ?? msg?.error) as Record<string, unknown> | undefined;
    if (err && typeof err.message === "string") {
      summary.error = maskPaths(redactsecrets(err.message), masks);
    }
    if (err && typeof err.code !== "undefined") summary.errorCode = err.code;
    const usage = (msg?.usage ?? payload?.usage) as Record<string, unknown> | undefined;
    if (usage && typeof usage === "object") {
      const numeric = Object.fromEntries(
        Object.entries(usage).filter(([, v]) => typeof v === "number")
      );
      if (Object.keys(numeric).length > 0) summary.usage = numeric;
    }
  } catch {
    /* content is not JSON — structure-only summary */
  }
  summary.content = redactedLengthMarker(content.length);
  return JSON.stringify(summary);
}
