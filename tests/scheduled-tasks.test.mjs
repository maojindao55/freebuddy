import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const utils = await import("../dist-electron/cli/scheduledTaskUtils.js");

test("daily schedules use the requested local wall-clock time", () => {
  const next = utils.nextScheduledOccurrence(
    { scheduleType: "daily", timeLocal: "08:00" },
    "Asia/Shanghai",
    new Date("2026-07-14T00:01:00.000Z")
  );
  assert.equal(next.toISOString(), "2026-07-15T00:00:00.000Z");
});

test("hourly schedules run at the next full hour", () => {
  const next = utils.nextScheduledOccurrence(
    { scheduleType: "hourly", timeLocal: "08:00" },
    "Asia/Shanghai",
    new Date("2026-07-14T00:01:00.000Z")
  );
  assert.equal(next.toISOString(), "2026-07-14T01:00:00.000Z");
});

test("manual schedules have no automatic occurrence", () => {
  assert.equal(
    utils.nextScheduledOccurrence(
      { scheduleType: "manual", timeLocal: "08:00" },
      "Asia/Shanghai",
      new Date("2026-07-14T00:01:00.000Z")
    ),
    undefined
  );
});

test("weekday schedules skip weekends", () => {
  const next = utils.nextScheduledOccurrence(
    { scheduleType: "weekdays", timeLocal: "08:00" },
    "Asia/Shanghai",
    new Date("2026-07-17T00:01:00.000Z")
  );
  assert.equal(next.toISOString(), "2026-07-20T00:00:00.000Z");
});

test("weekly schedules run only on selected weekdays", () => {
  const next = utils.nextScheduledOccurrence(
    { scheduleType: "weekly", timeLocal: "08:00", weekdays: [5] },
    "Asia/Shanghai",
    new Date("2026-07-14T00:01:00.000Z")
  );
  assert.equal(next.toISOString(), "2026-07-17T00:00:00.000Z");
});

test("monthly schedules skip to the next matching day", () => {
  const next = utils.nextScheduledOccurrence(
    { scheduleType: "monthly", timeLocal: "08:00", monthDay: 1 },
    "Asia/Shanghai",
    new Date("2026-07-14T00:01:00.000Z")
  );
  assert.equal(next.toISOString(), "2026-08-01T00:00:00.000Z");
});

test("one-time schedules return only their future occurrence", () => {
  const schedule = {
    scheduleType: "once",
    scheduleDate: "2026-07-20",
    timeLocal: "09:00"
  };
  const next = utils.nextScheduledOccurrence(
    schedule,
    "Asia/Shanghai",
    new Date("2026-07-14T00:01:00.000Z")
  );
  assert.equal(next.toISOString(), "2026-07-20T01:00:00.000Z");
  assert.equal(
    utils.nextScheduledOccurrence(
      schedule,
      "Asia/Shanghai",
      new Date("2026-07-20T01:01:00.000Z")
    ),
    undefined
  );
});

test("daily schedules skip a nonexistent daylight-saving wall time", () => {
  const next = utils.nextScheduledOccurrence(
    { scheduleType: "daily", timeLocal: "02:30" },
    "America/New_York",
    new Date("2026-03-08T05:00:00.000Z")
  );
  assert.equal(next.toISOString(), "2026-03-09T06:30:00.000Z");
});

test("scheduled task prompt executes the user's general instructions", () => {
  const prompt = utils.buildScheduledTaskPrompt({
    title: "Morning task",
    prompt: "Review my pending work and create a prioritized checklist.",
    startedAt: "2026-07-14T00:00:00.000Z"
  });
  assert.match(prompt, /automated task configured by the user/i);
  assert.match(prompt, /Review my pending work/);
  assert.doesNotMatch(prompt, /Source URL|fetched page|scheduled report/i);
});

test("scheduled tasks are general, recurring, persisted, bridged, and mounted", () => {
  const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
  const db = read("electron/cli/db.ts");
  const service = read("electron/cli/scheduledTasks.ts");
  const component = read("src/components/Settings/ScheduledTasksTab.tsx");
  const preload = read("electron/preload.ts");
  const main = read("electron/main.ts");
  const settings = read("src/components/Settings/SettingsModal.tsx");
  const app = read("src/App.tsx");
  const types = read("src/types/freebuddy.d.ts");
  const serviceTypes = read("src/services/scheduledTasks/types.ts");
  const en = JSON.parse(read("src/locales/en.json"));
  const zh = JSON.parse(read("src/locales/zh-CN.json"));

  assert.match(db, /CREATE TABLE IF NOT EXISTS scheduled_tasks/);
  assert.match(db, /schedule_type TEXT NOT NULL DEFAULT 'daily'/);
  assert.match(db, /cwd TEXT/);
  assert.match(db, /config_option_overrides TEXT/);
  assert.match(db, /ALTER TABLE scheduled_tasks ADD COLUMN config_option_overrides TEXT/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS scheduled_task_runs/);
  assert.match(service, /scheduledTasks:list/);
  assert.match(service, /scheduledTasks:listRuns/);
  assert.match(service, /scheduledTasks:run/);
  assert.match(service, /buildScheduledTaskPrompt/);
  assert.match(service, /cwd: task\.cwd/);
  assert.match(service, /serializedConfigOptionOverrides\(input\.configOptionOverrides\)/);
  assert.match(service, /configOptionOverrides: task\.configOptionOverrides/);
  assert.match(service, /scheduledTasks\.errors\.titleRequired/);
  assert.doesNotMatch(service, /errors\.push\("task title is required"\)/);
  assert.doesNotMatch(service, /fetchPage|buildScheduledReportPrompt/);
  assert.doesNotMatch(component, /sourceUrl|type="url"|timeZone/);
  assert.match(component, /value="once"/);
  assert.match(component, /value="manual"/);
  assert.match(component, /value="hourly"/);
  assert.match(component, /value="weekdays"/);
  assert.match(component, /value="weekly"/);
  assert.match(component, /value="monthly"/);
  assert.match(component, /value="continuous"/);
  assert.match(component, /cliClient\.selectDirectory/);
  assert.match(component, /getCachedSessionConfigOptions\(probeInput\)/);
  assert.match(component, /inspectSessionConfigOptions\(probeInput\)/);
  assert.match(component, /scheduledTasks\.model/);
  assert.match(component, /configOptionOverrides/);
  assert.match(preload, /scheduledTasks:\/\/changed/);
  assert.match(main, /initializeScheduledTaskScheduler/);
  assert.match(app, /<ScheduledTasksTab/);
  assert.match(app, /workspaceView === "scheduledTasks"/);
  assert.doesNotMatch(settings, /ScheduledTasksTab/);
  assert.match(types, /scheduledTasks: FreebuddyScheduledTasks/);
  assert.match(serviceTypes, /configOptionOverrides\?: Record<string, string>/);
  assert.equal(en.scheduledTasks.errors.titleRequired, "Task name is required.");
  assert.equal(zh.scheduledTasks.errors.titleRequired, "\u8bf7\u586b\u5199\u4efb\u52a1\u540d\u79f0\u3002");
  assert.equal(zh.scheduledTasks.model, "\u6a21\u578b");
});
