import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  ASHARE_SOURCE_URL,
  ashareMarketInternals,
  normalizeAshareSymbol,
  searchAshareSecurities
} from "../dist-electron/cli/ashareMarket.js";

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function tencentFixture(symbol = "sh000001") {
  const quote = Array(33).fill("");
  quote[1] = "上证指数";
  quote[3] = "3918.82";
  quote[4] = "3913.79";
  quote[30] = "20260714102124";
  quote[31] = "5.03";
  quote[32] = "0.13";
  return { data: { [symbol]: { qt: { [symbol]: quote } } } };
}

const sinaFixture = [
  { day: "2026-07-10", close: "3996.162" },
  { day: "2026-07-13", close: "3913.794" }
];

test("Ashare provider points to the upstream project and accepts common code formats", () => {
  assert.equal(ASHARE_SOURCE_URL, "https://github.com/mpquant/Ashare");
  assert.equal(normalizeAshareSymbol("sh000001"), "sh000001");
  assert.equal(normalizeAshareSymbol("000001.XSHG"), "sh000001");
  assert.equal(normalizeAshareSymbol("399006.XSHE"), "sz399006");
  assert.equal(normalizeAshareSymbol("SPY"), undefined);
});

test("security search keeps supported Shanghai and Shenzhen results", () => {
  const rows = ashareMarketInternals.parseSecuritySearchResults({
    QuotationCodeTable: {
      Data: [
        {
          Code: "159941",
          Name: "纳指ETF广发",
          MktNum: "0",
          SecurityTypeName: "基金"
        },
        {
          Code: "513100",
          Name: "纳指ETF国泰",
          MktNum: "1",
          SecurityTypeName: "基金"
        },
        { Code: "QQQ", Name: "Nasdaq 100 ETF", MktNum: "105", SecurityTypeName: "美股" }
      ]
    }
  });
  assert.deepEqual(rows, [
    {
      symbol: "sz159941",
      code: "159941",
      name: "纳指ETF广发",
      exchange: "sz",
      securityType: "基金"
    },
    {
      symbol: "sh513100",
      code: "513100",
      name: "纳指ETF国泰",
      exchange: "sh",
      securityType: "基金"
    }
  ]);
});

test("security search accepts a normalized symbol without exposing its exchange prefix", async () => {
  let requestedUrl = "";
  await searchAshareSecurities("sz159941", async (url) => {
    requestedUrl = url;
    return { QuotationCodeTable: { Data: [] } };
  });
  assert.equal(new URL(requestedUrl).searchParams.get("input"), "159941");
  assert.equal(new URL(requestedUrl).protocol, "https:");
});

test("Tencent real-time quotes map to the existing market-card row shape", () => {
  const row = ashareMarketInternals.parseTencentQuote(tencentFixture(), "sh000001");
  assert.deepEqual(row, {
    name: "上证指数 · SH000001",
    value: "3918.82",
    change: "+0.13% (+5.03)",
    status: "2026-07-14 10:21:24"
  });
});

test("Sina daily history remains a usable fallback", () => {
  const row = ashareMarketInternals.parseSinaQuote(sinaFixture, "000001.XSHG");
  assert.deepEqual(row, {
    name: "上证指数 · SH000001",
    value: "3913.79",
    change: "-2.06% (-82.37)",
    status: "2026-07-13"
  });
});

test("Tencent failures fall back to Sina over HTTPS", async () => {
  const urls = [];
  const row = await ashareMarketInternals.fetchQuoteWithFallback("sh000001", async (url) => {
    urls.push(url);
    if (urls.length === 1) throw new Error("temporary Tencent failure");
    return sinaFixture;
  });
  assert.equal(row.value, "3913.79");
  assert.equal(urls.length, 2);
  assert.match(urls[0], /^https:\/\/web\.ifzq\.gtimg\.cn\//);
  assert.match(urls[1], /^https:\/\/money\.finance\.sina\.com\.cn\//);
});

test("one unavailable symbol does not discard successful index quotes", async () => {
  const rows = await ashareMarketInternals.collectQuoteRows(
    ["sh000001", "sz399001"],
    async (symbol) => {
      if (symbol === "sz399001") throw new Error("temporary upstream failure");
      return ashareMarketInternals.parseTencentQuote(tencentFixture(), symbol);
    }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "上证指数 · SH000001");
});

test("all unavailable symbols surface each useful error", async () => {
  await assert.rejects(
    () =>
      ashareMarketInternals.collectQuoteRows(["sh000001", "sz399001"], async () => {
        throw new Error("temporary upstream failure");
      }),
    /sh000001: temporary upstream failure; sz399001: temporary upstream failure/
  );
});

test("market and sports cards use built-in providers", () => {
  const service = read("../electron/cli/infoCards.ts");
  const settings = read("../src/components/Settings/InfoCardsTab.tsx");
  const dataCard = read("../src/components/InfoCards/InfoDataCard.tsx");
  const preload = read("../electron/preload.ts");
  const ipc = read("../electron/cli/ipc.ts");
  const types = read("../src/types/freebuddy.d.ts");
  const client = read("../src/services/infoCards/client.ts");
  assert.match(service, /fetchAshareQuotes/);
  assert.match(service, /\["sh000001", "sz399001", "sz399006", "sh000300"\]/);
  assert.match(service, /LEGACY_ALPHA_VANTAGE_DEFAULTS/);
  assert.match(service, /MAX_MARKET_SYMBOLS = 10/);
  assert.match(service, /symbols\.slice\(0, MAX_MARKET_SYMBOLS\)/);
  assert.match(service, /cards\.some\(\(card\) => card\.type === input\.type\)/);
  assert.match(service, /fetchNbaScores/);
  assert.match(service, /fetchNbaScores/);
  assert.doesNotMatch(settings, /MarketProviderEditor|market-provider-editor/);
  assert.match(settings, /MarketCardEditor/);
  assert.match(settings, /SportsCardEditor/);
  assert.doesNotMatch(settings, /RecipeEditor|rowSelector|waitForSelector/);
  assert.match(settings, /selectedTypeExists/);
  assert.match(settings, /disabled=\{!loaded \|\| loading \|\| selectedTypeExists\}/);
  assert.match(settings, /searchMarketSymbols/);
  assert.match(settings, /market-symbol-results/);
  assert.match(settings, /market-symbol-chip/);
  assert.doesNotMatch(settings, /symbols\.split/);
  assert.match(dataCard, /function marketIdentity/);
  assert.match(dataCard, /identity\.symbol && <small>\{identity\.symbol\}<\/small>/);
  assert.doesNotMatch(dataCard, /row\.status && <small>\{row\.status\}<\/small>/);
  for (const source of [preload, ipc, types, client]) {
    assert.match(source, /searchMarketSymbols/);
  }
  assert.doesNotMatch(settings, /apiKey|Alpha Vantage/);
  assert.doesNotMatch(preload, /updateMarketProvider/);
});
