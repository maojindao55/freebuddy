import type { MarketSymbolSearchResult } from "../shared/infoCardProtocol.js";

export const ASHARE_SOURCE_URL = "https://github.com/mpquant/Ashare";

const TENCENT_ENDPOINT = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
const SINA_ENDPOINT =
  "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData";
const SECURITY_SEARCH_ENDPOINT = "https://searchapi.eastmoney.com/api/suggest/get";
const REQUEST_TIMEOUT_MS = 10_000;

const INDEX_NAMES: Record<string, string> = {
  sh000001: "上证指数",
  sz399001: "深证成指",
  sz399006: "创业板指",
  sh000300: "沪深300",
  sh000016: "上证50",
  sh000905: "中证500"
};

type QuoteRow = Record<string, string>;
type JsonRequester = (url: string) => Promise<unknown>;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function signed(value: number, suffix = ""): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

function quoteName(symbol: string, upstreamName?: unknown): string {
  const name =
    (typeof upstreamName === "string" && upstreamName.trim()) || INDEX_NAMES[symbol] || symbol.toUpperCase();
  return `${name} · ${symbol.toUpperCase()}`;
}

function formatTencentTime(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const matched = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!matched) return raw;
  return `${matched[1]}-${matched[2]}-${matched[3]} ${matched[4]}:${matched[5]}:${matched[6]}`;
}

export function normalizeAshareSymbol(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  const jq = normalized.match(/^(\d{6})\.(xshg|xshe)$/);
  if (jq) return `${jq[2] === "xshg" ? "sh" : "sz"}${jq[1]}`;
  return /^(?:sh|sz)\d{6}$/.test(normalized) ? normalized : undefined;
}

function tencentUrl(symbol: string): string {
  return `${TENCENT_ENDPOINT}?param=${symbol},day,,,2,qfq`;
}

function sinaUrl(symbol: string): string {
  return `${SINA_ENDPOINT}?symbol=${symbol}&scale=240&ma=5&datalen=3`;
}

function securitySearchUrl(query: string): string {
  const normalized = normalizeAshareSymbol(query);
  const url = new URL(SECURITY_SEARCH_ENDPOINT);
  url.searchParams.set("input", normalized ? normalized.slice(2) : query.trim());
  url.searchParams.set("type", "14");
  url.searchParams.set("count", "30");
  return url.toString();
}

function parseSecuritySearchResults(value: unknown): MarketSymbolSearchResult[] {
  const root = objectValue(value);
  const table = objectValue(root?.QuotationCodeTable);
  const entries = Array.isArray(table?.Data) ? table.Data : [];
  const seen = new Set<string>();
  const results: MarketSymbolSearchResult[] = [];
  for (const entryValue of entries) {
    const entry = objectValue(entryValue);
    const code = typeof entry?.Code === "string" ? entry.Code.trim() : "";
    const market = String(entry?.MktNum ?? "");
    const exchange = market === "1" ? "sh" : market === "0" ? "sz" : undefined;
    if (!exchange || !/^\d{6}$/.test(code)) continue;
    const symbol = `${exchange}${code}`;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    results.push({
      symbol,
      code,
      name:
        typeof entry?.Name === "string" && entry.Name.trim() ? entry.Name.trim() : symbol.toUpperCase(),
      exchange,
      securityType:
        typeof entry?.SecurityTypeName === "string" ? entry.SecurityTypeName.trim() : ""
    });
  }
  return results.slice(0, 10);
}

function parseTencentQuote(value: unknown, requestedSymbol: string): QuoteRow {
  const symbol = normalizeAshareSymbol(requestedSymbol);
  if (!symbol) throw new Error(`Unsupported Ashare symbol: ${requestedSymbol}`);
  const root = objectValue(value);
  const data = objectValue(root?.data);
  const stock = objectValue(data?.[symbol]);
  const quotes = objectValue(stock?.qt);
  const quote = quotes?.[symbol];
  if (!Array.isArray(quote)) throw new Error(`Tencent returned no quote for ${symbol}.`);

  const current = finiteNumber(quote[3]);
  const previousClose = finiteNumber(quote[4]);
  if (current === undefined || previousClose === undefined || previousClose === 0) {
    throw new Error(`Tencent returned an invalid quote for ${symbol}.`);
  }
  const change = finiteNumber(quote[31]) ?? current - previousClose;
  const changePercent = finiteNumber(quote[32]) ?? (change / previousClose) * 100;
  return {
    name: quoteName(symbol, quote[1]),
    value: current.toFixed(2),
    change: `${signed(changePercent, "%")} (${signed(change)})`,
    status: formatTencentTime(quote[30])
  };
}

function parseSinaQuote(value: unknown, requestedSymbol: string): QuoteRow {
  const symbol = normalizeAshareSymbol(requestedSymbol);
  if (!symbol) throw new Error(`Unsupported Ashare symbol: ${requestedSymbol}`);
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`Sina returned too little history for ${symbol}.`);
  }
  const previous = objectValue(value[value.length - 2]);
  const latest = objectValue(value[value.length - 1]);
  const previousClose = finiteNumber(previous?.close);
  const current = finiteNumber(latest?.close);
  if (current === undefined || previousClose === undefined || previousClose === 0) {
    throw new Error(`Sina returned an invalid quote for ${symbol}.`);
  }
  const change = current - previousClose;
  return {
    name: quoteName(symbol),
    value: current.toFixed(2),
    change: `${signed((change / previousClose) * 100, "%")} (${signed(change)})`,
    status: typeof latest?.day === "string" ? latest.day : ""
  };
}

async function requestJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/json, text/plain, */*" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Market source returned HTTP ${response.status}.`);
  return response.json();
}

async function fetchQuoteWithFallback(
  requestedSymbol: string,
  request: JsonRequester = requestJson
): Promise<QuoteRow> {
  const symbol = normalizeAshareSymbol(requestedSymbol);
  if (!symbol) throw new Error(`Unsupported Ashare symbol: ${requestedSymbol}`);
  try {
    return parseTencentQuote(await request(tencentUrl(symbol)), symbol);
  } catch (tencentError) {
    try {
      return parseSinaQuote(await request(sinaUrl(symbol)), symbol);
    } catch (sinaError) {
      throw new Error(
        `Tencent: ${(tencentError as Error)?.message || String(tencentError)}; ` +
          `Sina: ${(sinaError as Error)?.message || String(sinaError)}`
      );
    }
  }
}

async function collectQuoteRows(
  symbols: string[],
  callQuote: (symbol: string) => Promise<QuoteRow>
): Promise<QuoteRow[]> {
  const settled = await Promise.allSettled(symbols.map((symbol) => callQuote(symbol)));
  const rows: QuoteRow[] = [];
  const errors: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") rows.push(result.value);
    else errors.push(`${symbols[index]}: ${result.reason?.message || String(result.reason)}`);
  });
  if (!rows.length) throw new Error(errors.join("; ") || "Ashare returned no quotes.");
  return rows;
}

export async function fetchAshareQuotes(symbols: string[]): Promise<QuoteRow[]> {
  return collectQuoteRows(symbols, (symbol) => fetchQuoteWithFallback(symbol));
}

export async function searchAshareSecurities(
  query: string,
  request: JsonRequester = requestJson
): Promise<MarketSymbolSearchResult[]> {
  const trimmed = query.trim().slice(0, 64);
  if (!trimmed) return [];
  return parseSecuritySearchResults(await request(securitySearchUrl(trimmed)));
}

export const ashareMarketInternals = {
  collectQuoteRows,
  fetchQuoteWithFallback,
  parseSinaQuote,
  parseSecuritySearchResults,
  parseTencentQuote,
  securitySearchUrl,
  sinaUrl,
  tencentUrl
};
