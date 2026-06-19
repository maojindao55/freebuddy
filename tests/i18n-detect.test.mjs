import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(
  new URL("../src/utils/detectLocale.ts", import.meta.url),
  "utf8"
);

test("detectLocale exports supported locales and maps zh-prefix to zh-CN", () => {
  assert.match(src, /export type AppLocale = "en" \| "zh-CN"/);
  assert.match(src, /export const SUPPORTED_LOCALES/);
  assert.match(src, /export function detectLocale\(tag: string \| undefined\)/);
  assert.match(src, /\.toLowerCase\(\)/);
  assert.match(src, /startsWith\("zh"\)/);
  assert.match(src, /return "zh-CN"/);
  assert.match(src, /return "en"/);
});
