import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const ALPHA_VANTAGE_MCP_ENDPOINT = "https://mcp.alphavantage.co/mcp";

const INDEX_NAMES: Record<string, string> = {
  SPY: "S&P 500",
  QQQ: "Nasdaq-100",
  DIA: "Dow Jones",
  IWM: "Russell 2000"
};

type QuoteRow = Record<string, string>;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonText(value: string): unknown {
  const trimmed = value.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function parseCsvQuote(value: string): Record<string, unknown> | undefined {
  const lines = value
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2 || !/^symbol,/i.test(lines[0])) return undefined;
  const headers = lines[0].split(",").map((entry) => entry.trim());
  const values = lines[1].split(",").map((entry) => entry.trim());
  if (headers.length !== values.length) return undefined;
  return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
}

function findQuotePayload(value: unknown): Record<string, unknown> | undefined {
  const object = objectValue(value);
  if (!object) return undefined;
  for (const [key, entry] of Object.entries(object)) {
    if (key.toLowerCase().replace(/[^a-z]/g, "") === "globalquote") {
      return objectValue(entry);
    }
  }
  if (
    Object.keys(object).some((key) => /(?:^|\.\s*)symbol$/i.test(key)) &&
    Object.keys(object).some((key) => /(?:^|\.\s*)price$/i.test(key))
  ) {
    return object;
  }
  for (const entry of Object.values(object)) {
    const nested = findQuotePayload(entry);
    if (nested) return nested;
  }
  return undefined;
}

function field(payload: Record<string, unknown>, suffix: string): string {
  const entry = Object.entries(payload).find(([key]) =>
    key.toLowerCase().replace(/[^a-z]/g, "").endsWith(suffix)
  );
  return typeof entry?.[1] === "string" || typeof entry?.[1] === "number"
    ? String(entry[1]).trim()
    : "";
}

function quoteFromToolResult(result: unknown, requestedSymbol: string): QuoteRow {
  const root = objectValue(result);
  const candidates: unknown[] = [root?.structuredContent];
  const textCandidates: string[] = [];
  const structured = objectValue(root?.structuredContent);
  if (typeof structured?.result === "string") textCandidates.push(structured.result);
  const content = Array.isArray(root?.content) ? root.content : [];
  for (const item of content) {
    const object = objectValue(item);
    if (object?.type === "text" && typeof object.text === "string") {
      textCandidates.push(object.text);
      candidates.push(parseJsonText(object.text));
    }
  }
  const payload =
    candidates.map(findQuotePayload).find(Boolean) ||
    textCandidates.map(parseCsvQuote).find(Boolean);
  if (!payload) {
    const message = candidates
      .map(objectValue)
      .map((candidate) => candidate?.Information ?? candidate?.Note ?? candidate?.Error)
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
    throw new Error(message || `Alpha Vantage returned no quote for ${requestedSymbol}.`);
  }

  const symbol = field(payload, "symbol") || requestedSymbol;
  const price = field(payload, "price");
  if (!price) throw new Error(`Alpha Vantage returned no price for ${requestedSymbol}.`);
  const change = field(payload, "change");
  const changePercent = field(payload, "changepercent");
  const latestDay = field(payload, "latesttradingday") || field(payload, "latestday");
  const normalized = symbol.toUpperCase();
  return {
    name: INDEX_NAMES[normalized] ? `${INDEX_NAMES[normalized]} · ${normalized}` : normalized,
    value: price,
    change: [changePercent, change && `(${change})`].filter(Boolean).join(" "),
    status: latestDay
  };
}

async function collectQuoteRows(
  symbols: string[],
  callQuote: (symbol: string) => Promise<unknown>
): Promise<QuoteRow[]> {
  const rows: QuoteRow[] = [];
  const errors: string[] = [];
  for (const symbol of symbols) {
    try {
      rows.push(quoteFromToolResult(await callQuote(symbol), symbol));
    } catch (error) {
      errors.push(`${symbol}: ${(error as Error)?.message || String(error)}`);
    }
  }
  if (!rows.length) {
    throw new Error(errors.join("; ") || "Alpha Vantage returned no quotes.");
  }
  return rows;
}

/*
 * Alpha Vantage's remote endpoint can end a Streamable HTTP session after a
 * quote call. Keep each symbol in its own short-lived MCP session so later
 * symbols are not silently returned as empty quotes.
 */
export async function fetchAlphaVantageQuotes(
  apiKey: string,
  symbols: string[]
): Promise<QuoteRow[]> {
  return collectQuoteRows(symbols, async (symbol) => {
    const client = new Client({ name: "freebuddy-market-cards", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(ALPHA_VANTAGE_MCP_ENDPOINT), {
      requestInit: { headers: { apikey: apiKey } }
    });
    try {
      await client.connect(transport);
      return await client.callTool({
        name: "GLOBAL_QUOTE",
        arguments: { symbol }
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  });
}

export const alphaVantageInternals = {
  collectQuoteRows,
  findQuotePayload,
  parseCsvQuote,
  parseJsonText,
  quoteFromToolResult
};
