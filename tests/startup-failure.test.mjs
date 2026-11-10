import test from "node:test";
import assert from "node:assert/strict";

async function load() {
  return import("../dist-electron/shared/startupFailure.js");
}

function errorWithCause() {
  const cause = new Error(
    "Could not locate the bindings file. Tried:\n\t/Users/me/app/node_modules/better-sqlite3/build/better_sqlite3.node"
  );
  cause.name = "Error";
  const wrapper = new Error("Failed to open the FreeBuddy database", { cause });
  return wrapper;
}

test("reports the failing stage and the underlying error message", async () => {
  const { formatStartupFailure } = await load();
  const report = formatStartupFailure({
    stage: "database",
    error: new Error("The module was compiled against a different Node.js version"),
    appName: "FreeBuddy",
    locale: "en-US"
  });

  assert.equal(report.title, "FreeBuddy failed to start");
  assert.match(report.message, /main window never opened/);
  assert.match(report.detail, /Stage: database/);
  assert.match(report.detail, /compiled against a different Node\.js version/);
  assert.match(report.summary, /^database: /);
});

test("collapses multi-line binding errors into a single summary line", async () => {
  const { formatStartupFailure } = await load();
  const report = formatStartupFailure({ stage: "whenReady", error: errorWithCause() });

  assert.ok(!report.summary.includes("\n"), "summary must stay on one line");
  assert.match(report.summary, /Failed to open the FreeBuddy database/);
});

test("localizes the dialog for Chinese locales", async () => {
  const { formatStartupFailure } = await load();
  for (const locale of ["zh-CN", "zh-Hans", "ZH-tw"]) {
    const report = formatStartupFailure({
      stage: "whenReady",
      error: new Error("boom"),
      appName: "FreeBuddy",
      locale
    });
    assert.equal(report.title, "FreeBuddy 启动失败", `locale ${locale}`);
    assert.match(report.detail, /启动阶段: whenReady/);
  }
});

test("defaults to English when the locale is missing or non-Chinese", async () => {
  const { formatStartupFailure } = await load();
  for (const locale of [undefined, "en-US", "ja-JP"]) {
    const report = formatStartupFailure({ stage: "whenReady", error: new Error("boom"), locale });
    assert.equal(report.title, "FreeBuddy failed to start", `locale ${locale}`);
  }
});

test("never throws on hostile error shapes", async () => {
  const { formatStartupFailure } = await load();
  const circular = { tries: [] };
  circular.self = circular;

  const cases = [undefined, null, "", 0, false, Symbol("sym"), circular, { a: [1, 2] }];
  for (const error of cases) {
    const report = formatStartupFailure({ stage: "whenReady", error });
    assert.equal(typeof report.title, "string");
    assert.equal(typeof report.message, "string");
    assert.equal(typeof report.detail, "string");
    assert.ok(report.summary.length > 0, "summary must never be empty");
    assert.ok(report.summary.length <= 400, "summary must stay bounded");
  }
});

test("truncates oversized messages so the dialog stays readable", async () => {
  const { formatStartupFailure } = await load();
  const report = formatStartupFailure({
    stage: "whenReady",
    error: new Error("x".repeat(5000))
  });

  assert.ok(report.summary.length <= 400, `summary length ${report.summary.length}`);
  assert.match(report.summary, /truncated/);
});

test("includes the stack frames below the message line", async () => {
  const { formatStartupFailure } = await load();
  const report = formatStartupFailure({
    stage: "database",
    error: new Error("native module missing")
  });

  assert.match(report.detail, /at /, "stack frames should be present");
  assert.ok(
    report.detail.indexOf("native module missing") < report.detail.indexOf("    at "),
    "the human-readable error must come before the stack"
  );
});
