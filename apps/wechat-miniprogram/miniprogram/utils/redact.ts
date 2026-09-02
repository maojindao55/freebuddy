/**
 * Redaction helpers shared by error handling and diagnostics.
 *
 * Relay, host logs and any future report must never receive chat content, terminal output,
 * login codes or token material. These helpers are deliberately conservative: they truncate
 * before matching and prefer masking extra text over leaking one secret.
 */

const MAX_MESSAGE_CHARS = 500;

const KEY_VALUE_PATTERN =
  /("?(?:access_?token|refresh_?token|id_?token|token|secret|app_?secret|password|passwd|authorization|cookie|session_?key|code|openid)"?\s*[:=]\s*)("[^"]*"|'[^']*'|(?:Bearer\s+)?[^\s,;}&]+)/gi;

const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

const QUERY_PATTERN = /([?&](?:code|token|access_token|secret)=)[^&\s"']+/gi;

/** Masks key/value pairs, bearer headers and query parameters that carry credentials. */
export function redactText(text: string): string {
  return text
    .replace(KEY_VALUE_PATTERN, "$1[redacted]")
    .replace(BEARER_PATTERN, "$1[redacted]")
    .replace(QUERY_PATTERN, "$1[redacted]");
}

/**
 * Turns an unknown thrown value into a short, redacted, single-line message.
 * Stack traces are dropped: they can embed request payloads and file paths.
 */
export function safeMessage(error: unknown): string {
  let text: string;
  if (typeof error === "string") {
    text = error;
  } else if (error instanceof Error) {
    text = error.message || error.name;
  } else if (error && typeof error === "object") {
    const record = error as { errMsg?: unknown; message?: unknown };
    if (typeof record.errMsg === "string") {
      text = record.errMsg;
    } else if (typeof record.message === "string") {
      text = record.message;
    } else {
      text = "unknown error";
    }
  } else {
    text = "unknown error";
  }

  const singleLine = text.replace(/\s+/g, " ").trim();
  const truncated =
    singleLine.length > MAX_MESSAGE_CHARS
      ? `${singleLine.slice(0, MAX_MESSAGE_CHARS)}…`
      : singleLine;

  return redactText(truncated);
}
