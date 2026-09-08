import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

const utilsJavascript = ts.transpileModule(read("../src/utils/scheduledSend.ts"), {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const utils = await import(
  `data:text/javascript;base64,${Buffer.from(utilsJavascript).toString("base64")}`
);

const chatViewSource = read("../src/components/CLI/ChatView.tsx");
const controlSource = read("../src/components/CLI/ScheduledSendControl.tsx");
const storeSource = read("../src/store/scheduledSendStore.ts");
const runnerSource = read("../src/services/scheduledSend/runner.ts");
const appSource = read("../src/App.tsx");
const stylesSource = read("../styles.css");
const en = JSON.parse(read("../src/locales/en.json"));
const zhCN = JSON.parse(read("../src/locales/zh-CN.json"));

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

test("pickCodexUsageResetAt prefers the earliest exhausted window", () => {
  const resetAt = utils.pickCodexUsageResetAt(
    [
      { leftPercent: 40, resetAt: (NOW + 60_000) / 1000 },
      { leftPercent: 0, resetAt: (NOW + 3 * 3_600_000) / 1000 },
      { leftPercent: 0, resetAt: (NOW + 5 * 3_600_000) / 1000 }
    ],
    NOW
  );
  assert.equal(resetAt, NOW + 3 * 3_600_000);
});

test("pickCodexUsageResetAt falls back to the earliest future reset when nothing is exhausted", () => {
  const resetAt = utils.pickCodexUsageResetAt(
    [
      { leftPercent: 80, resetAt: NOW + 7 * 3_600_000 },
      { leftPercent: 55, resetAt: NOW + 2 * 3_600_000 },
      { leftPercent: 10, resetAt: NOW - 1_000 }
    ],
    NOW
  );
  assert.equal(resetAt, NOW + 2 * 3_600_000);
});

test("pickCodexUsageResetAt handles seconds and milliseconds and returns undefined when empty", () => {
  assert.equal(utils.normalizeCodexResetAtMs(1_800_000_000), 1_800_000_000_000);
  assert.equal(utils.normalizeCodexResetAtMs(1_800_000_000_000), 1_800_000_000_000);
  assert.equal(utils.normalizeCodexResetAtMs(0), undefined);
  assert.equal(utils.pickCodexUsageResetAt([], NOW), undefined);
  assert.equal(
    utils.pickCodexUsageResetAt([{ leftPercent: 0, resetAt: (NOW - 10_000) / 1000 }], NOW),
    undefined
  );
});

test("only Codex adapters expose the quota reset preset", () => {
  assert.equal(utils.supportsCodexUsageReset("codex"), true);
  assert.equal(utils.supportsCodexUsageReset("codex-acp"), true);
  assert.equal(utils.supportsCodexUsageReset("claude"), false);
  assert.equal(utils.supportsCodexUsageReset(undefined), false);
});

test("datetime-local values round-trip and future validation works", () => {
  const value = utils.toDateTimeLocalInputValue(NOW);
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(utils.parseDateTimeLocalInputValue(value), NOW);
  assert.equal(utils.parseDateTimeLocalInputValue("garbage"), undefined);
  assert.equal(utils.isValidScheduledFireAt(NOW + 1, NOW), true);
  assert.equal(utils.isValidScheduledFireAt(NOW, NOW), false);
  assert.equal(utils.isValidScheduledFireAt(undefined, NOW), false);
  assert.equal(utils.presetFireAt(15, NOW), NOW + 15 * 60_000);
});

test("countdown and preview formatting are compact", () => {
  assert.equal(utils.formatCountdown(5 * 3_600_000 + 4 * 60_000 + 9_000), "5:04:09");
  assert.equal(utils.formatCountdown(4 * 60_000 + 9_000), "04:09");
  assert.equal(utils.formatCountdown(-5_000), "00:00");
  assert.equal(utils.truncatePromptPreview("  hello\n\nworld  "), "hello world");
  assert.equal(utils.truncatePromptPreview("a".repeat(100), 10).length, 10);
  assert.ok(utils.truncatePromptPreview("a".repeat(100), 10).endsWith("\u2026"));
});

test("presets cover the common 5h rate-limit window", () => {
  assert.deepEqual([...utils.SCHEDULED_SEND_PRESET_MINUTES], [15, 30, 60, 120, 300]);
  assert.equal(utils.SCHEDULED_SEND_RESET_BUFFER_MS, 60_000);
});

test("composer wires the scheduled send control, banner, and store", () => {
  assert.match(chatViewSource, /<ScheduledSendControl/);
  assert.match(chatViewSource, /<ScheduledSendBanner/);
  assert.match(chatViewSource, /useScheduledSendStore/);
  assert.match(chatViewSource, /const onScheduleSend = \(fireAt: number\)/);
  assert.match(chatViewSource, /protectManagedAttachments\(attachmentsToSend\);\s+if \(previous\) unprotectManagedAttachments/);
  assert.match(chatViewSource, /onEdit=\{onEditScheduledSend\}/);
  assert.match(chatViewSource, /onCancel=\{onCancelScheduledSend\}/);
  assert.match(chatViewSource, /onSendNow=\{\(\) => fireScheduledSendNow\(conv\.id\)\}/);
});

test("scheduled send trigger stays clickable with an empty draft; the panel hosts the message field", () => {
  assert.match(controlSource, /className=\{`scheduled-send-trigger\$\{open \? " open" : ""\}`\}\s+title=\{t\("scheduledSend\.trigger"\)\}\s+aria-label=\{t\("scheduledSend\.trigger"\)\}\s+disabled=\{disabled\}/);
  assert.doesNotMatch(controlSource, /disabled=\{disabled \|\| !canSchedule\}/);
  assert.match(controlSource, /className="scheduled-send-message"/);
  assert.match(controlSource, /onChange=\{\(event\) => onDraftChange\(event\.target\.value\)\}/);
  assert.match(controlSource, /if \(!canSchedule\) return;\s+onSchedule\(fireAt\)/);
  assert.equal((controlSource.match(/disabled=\{!canSchedule\}/g) ?? []).length, 3);
  assert.match(chatViewSource, /draft=\{draft\}\s+onDraftChange=\{setDraft\}/);
});

test("scheduled send control offers presets, quota reset, and a custom time", () => {
  assert.match(controlSource, /SCHEDULED_SEND_PRESET_MINUTES\.map/);
  assert.match(controlSource, /cliClient\s*\.codexUsage\(\)/);
  assert.match(controlSource, /pickCodexUsageResetAt\(result\.windows\)/);
  assert.match(controlSource, /type="datetime-local"/);
  assert.match(controlSource, /document\.addEventListener\("mousedown", onPointerDown\)/);
  assert.match(controlSource, /event\.key === "Escape"/);
  assert.match(controlSource, /createPortal\(/);
});

test("runner waits for running conversations and routes delegation follow-ups", () => {
  assert.match(runnerSource, /isRunning\(conv\.id\)/);
  assert.match(runnerSource, /setStatus\(conv\.id, "waiting"\)/);
  assert.match(runnerSource, /delegationClient\.hasRunForConversation\(conv\.id\)/);
  assert.match(runnerSource, /delegationClient\.followUp\(/);
  assert.match(runnerSource, /approvalModeOverride: conv\.approvalMode/);
  assert.match(runnerSource, /setStatus\(conv\.id, "failed", message\)/);
  assert.match(runnerSource, /setInterval\(\(\) => runScheduledSendTick\(\), TICK_MS\)/);
  assert.match(storeSource, /export function dueScheduledSends/);
  assert.match(appSource, /useEffect\(\(\) => startScheduledSendRunner\(\), \[\]\)/);
});

test("scheduled send styles and translations exist in both locales", () => {
  for (const cls of [
    ".scheduled-send-trigger",
    ".scheduled-send-panel",
    ".scheduled-send-preset",
    ".scheduled-send-banner",
    ".scheduled-send-banner-failed"
  ]) {
    assert.ok(stylesSource.includes(`${cls} {`), `missing style ${cls}`);
  }
  const keys = Object.keys(en.scheduledSend);
  assert.ok(keys.length > 10);
  assert.deepEqual(Object.keys(zhCN.scheduledSend).sort(), keys.sort());
  const used = [...controlSource.matchAll(/t\("scheduledSend\.([a-zA-Z]+)"/g)].map(
    (match) => match[1]
  );
  for (const key of used) {
    const found =
      key in en.scheduledSend ||
      `${key}_one` in en.scheduledSend;
    assert.ok(found, `missing en translation for scheduledSend.${key}`);
  }
});
