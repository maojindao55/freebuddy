import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  ALPHA_VANTAGE_MCP_ENDPOINT,
  alphaVantageInternals
} from "../dist-electron/cli/alphaVantage.js";

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("Alpha Vantage market provider uses the official MCP endpoint without embedding a key", () => {
  const source = read("../electron/cli/alphaVantage.ts");
  assert.equal(ALPHA_VANTAGE_MCP_ENDPOINT, "https://mcp.alphavantage.co/mcp");
  assert.match(source, /headers: \{ apikey: apiKey \}/);
  assert.doesNotMatch(source, /mcp\?apikey=/);
});

test("Alpha Vantage CSV GLOBAL_QUOTE responses map to market-card rows", () => {
  const row = alphaVantageInternals.quoteFromToolResult(
    {
      content: [
        {
          type: "text",
          text:
            "symbol,open,high,low,price,volume,latestDay,previousClose,change,changePercent\r\n" +
            "SPY,752.4700,753.9105,748.0000,749.1700,43121578,2026-07-13,754.9500,-5.7800,-0.7656%\r\n"
        }
      ]
    },
    "SPY"
  );
  assert.deepEqual(row, {
    name: "S&P 500 · SPY",
    value: "749.1700",
    change: "-0.7656% (-5.7800)",
    status: "2026-07-13"
  });
});

test("Alpha Vantage JSON GLOBAL_QUOTE responses remain supported", () => {
  const row = alphaVantageInternals.quoteFromToolResult(
    {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            "Global Quote": {
              "01. symbol": "QQQ",
              "05. price": "680.1200",
              "09. change": "1.2000",
              "10. change percent": "0.1767%",
              "07. latest trading day": "2026-07-13"
            }
          })
        }
      ]
    },
    "QQQ"
  );
  assert.equal(row.name, "Nasdaq-100 · QQQ");
  assert.equal(row.value, "680.1200");
  assert.equal(row.change, "0.1767% (1.2000)");
});

test("one unavailable symbol does not discard successful index quotes", async () => {
  const result = await alphaVantageInternals.collectQuoteRows(
    ["SPY", "QQQ"],
    async (symbol) => {
      if (symbol === "QQQ") throw new Error("temporary upstream failure");
      return {
        content: [
          {
            type: "text",
            text:
              "symbol,open,high,low,price,volume,latestDay,previousClose,change,changePercent\n" +
              "SPY,752,753,748,749.1700,100,2026-07-13,754,-5.7800,-0.7656%\n"
          }
        ]
      };
    }
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "S&P 500 · SPY");
});

test("all unavailable symbols still surface a useful error", async () => {
  await assert.rejects(
    () =>
      alphaVantageInternals.collectQuoteRows(["SPY", "QQQ"], async () => {
        throw new Error("temporary upstream failure");
      }),
    /SPY: temporary upstream failure; QQQ: temporary upstream failure/
  );
});

test("market cards use Alpha Vantage while sports cards retain browser recipes", () => {
  const service = read("../electron/cli/infoCards.ts");
  const settings = read("../src/components/Settings/InfoCardsTab.tsx");
  assert.match(service, /fetchAlphaVantageQuotes/);
  assert.match(service, /card\.type === "market"/);
  assert.match(service, /current\.type === "sports"/);
  assert.match(settings, /MarketProviderEditor/);
  assert.match(settings, /MarketCardEditor/);
});
