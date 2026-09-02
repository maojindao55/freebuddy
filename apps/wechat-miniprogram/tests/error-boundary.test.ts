import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createErrorBoundary } from "../miniprogram/utils/errorBoundary";
import { redactText, safeMessage } from "../miniprogram/utils/redact";

describe("redact", () => {
  test("masks credentials in key/value, header and query form", () => {
    const text = 'failed code=CODE_1234567890 token: "sk-9f8e7d6c5b" Authorization: Bearer abcdef123456 https://r/?token=zzz';
    const redacted = redactText(text);
    assert.doesNotMatch(redacted, /CODE_1234567890|sk-9f8e7d6c5b|abcdef123456|token=zzz/);
    assert.equal((redacted.match(/\[redacted\]/g) ?? []).length, 4);
  });

  test("leaves ordinary text untouched", () => {
    assert.equal(redactText("host_offline: desktop is not connected"), "host_offline: desktop is not connected");
  });
});

describe("safeMessage", () => {
  test("drops stack traces and file paths", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at /Users/someone/secret/project/app.ts:12:1";
    assert.equal(safeMessage(error), "boom");
  });

  test("truncates long messages", () => {
    const message = safeMessage("a".repeat(1000));
    assert.equal(message.length, 501);
    assert.ok(message.endsWith("…"));
  });

  test("handles non-error values", () => {
    assert.equal(safeMessage("plain"), "plain");
    assert.equal(safeMessage({ errMsg: "wx:fail" }), "wx:fail");
    assert.equal(safeMessage({ message: "domain error" }), "domain error");
    assert.equal(safeMessage({ weird: true }), "unknown error");
    assert.equal(safeMessage(undefined), "unknown error");
  });

  test("redacts secrets inside thrown values", () => {
    assert.equal(safeMessage(new Error("auth failed token=abcdef123456")), "auth failed token=[redacted]");
  });
});

describe("error boundary", () => {
  test("records a redacted entry and never rethrows", () => {
    const entries: string[] = [];
    const boundary = createErrorBoundary({ report: (entry) => entries.push(entry.message) });

    const entry = boundary.handleError("app.onError", new Error("crash token=abcdef123456"));
    assert.equal(entry.scope, "app.onError");
    assert.equal(entry.message, "crash token=[redacted]");
    assert.ok(!Number.isNaN(Date.parse(entry.at)));
    assert.deepEqual(entries, ["crash token=[redacted]"]);
  });

  test("handles cyclic objects without throwing", () => {
    const cyclic: Record<string, unknown> = { message: "loop" };
    cyclic.self = cyclic;
    const entry = createErrorBoundary().handleError("scope", cyclic);
    assert.equal(typeof entry.message, "string");
  });

  test("a failing report sink cannot break the caller", () => {
    const boundary = createErrorBoundary({
      report: () => {
        throw new Error("sink down");
      }
    });
    assert.doesNotThrow(() => boundary.handleError("scope", "boom"));
  });

  test("unhandled rejections are tagged separately", () => {
    const entry = createErrorBoundary().handleUnhandledRejection("promise blew up");
    assert.equal(entry.scope, "unhandledRejection");
    assert.equal(entry.message, "promise blew up");
  });

  test("run returns the value, or the fallback after recording", () => {
    const entries: string[] = [];
    const boundary = createErrorBoundary({ report: (entry) => entries.push(entry.scope) });

    assert.equal(boundary.run("ok", () => 42, 0), 42);
    assert.equal(boundary.run("bad", () => { throw new Error("nope"); }, 0), 0);
    assert.deepEqual(entries, ["bad"]);
  });

  test("debug output is opt-in only", () => {
    const entries: string[] = [];
    const report = (entry: { message: string }): void => {
      entries.push(entry.message);
    };
    createErrorBoundary({ report, debug: false }).handleError("scope", "quiet");
    createErrorBoundary({ report, debug: true }).handleError("scope", "loud");
    assert.deepEqual(entries, ["quiet", "loud"]);
  });
});
