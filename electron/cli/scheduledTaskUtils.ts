const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ScheduledTaskScheduleType = "once" | "daily" | "weekly" | "monthly";

export interface ScheduledTaskSchedule {
  scheduleType: ScheduledTaskScheduleType;
  timeLocal: string;
  scheduleDate?: string;
  weekdays?: number[];
  monthDay?: number;
}

export function isValidLocalTime(value: string): boolean {
  return LOCAL_TIME.test(value);
}

export function isValidLocalDate(value: string): boolean {
  if (!LOCAL_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!, 12));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute")
  };
}

function candidateForLocalTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date | undefined {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = localAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(new Date(candidate), timeZone);
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
      0
    );
    candidate += localAsUtc - represented;
  }
  const parts = zonedParts(new Date(candidate), timeZone);
  if (
    parts.year !== year ||
    parts.month !== month ||
    parts.day !== day ||
    parts.hour !== hour ||
    parts.minute !== minute
  ) {
    return undefined;
  }
  return new Date(candidate);
}

function calendarDateKey(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

export function nextScheduledOccurrence(
  schedule: ScheduledTaskSchedule,
  timeZone: string,
  after = new Date()
): Date | undefined {
  if (!isValidLocalTime(schedule.timeLocal)) throw new Error("invalid local time");
  const [hour, minute] = schedule.timeLocal.split(":").map(Number);

  if (schedule.scheduleType === "once") {
    if (!schedule.scheduleDate || !isValidLocalDate(schedule.scheduleDate)) {
      throw new Error("invalid schedule date");
    }
    const [year, month, day] = schedule.scheduleDate.split("-").map(Number);
    const candidate = candidateForLocalTime(
      year!,
      month!,
      day!,
      hour!,
      minute!,
      timeZone
    );
    return candidate && candidate.getTime() > after.getTime() ? candidate : undefined;
  }

  const today = zonedParts(after, timeZone);
  for (let dayOffset = 0; dayOffset < 400; dayOffset += 1) {
    const calendarDay = new Date(
      Date.UTC(today.year, today.month - 1, today.day + dayOffset, 12)
    );
    const matches =
      schedule.scheduleType === "daily" ||
      (schedule.scheduleType === "weekly" &&
        (schedule.weekdays ?? []).includes(calendarDay.getUTCDay())) ||
      (schedule.scheduleType === "monthly" &&
        calendarDay.getUTCDate() === schedule.monthDay);
    if (!matches) continue;
    const candidate = candidateForLocalTime(
      calendarDay.getUTCFullYear(),
      calendarDay.getUTCMonth() + 1,
      calendarDay.getUTCDate(),
      hour!,
      minute!,
      timeZone
    );
    if (candidate && candidate.getTime() > after.getTime()) return candidate;
  }
  return undefined;
}

export function nextDailyOccurrence(
  timeLocal: string,
  timeZone: string,
  after = new Date()
): Date {
  const next = nextScheduledOccurrence(
    { scheduleType: "daily", timeLocal },
    timeZone,
    after
  );
  if (!next) throw new Error("could not calculate the next run time");
  return next;
}

export function buildScheduledTaskPrompt(input: {
  title: string;
  prompt: string;
  startedAt: string;
}): string {
  return [
    "You are running an automated task configured by the user.",
    "Complete it autonomously using the tools available to you.",
    "If a required resource is unavailable, explain the blocker clearly in the final response.",
    "",
    `Task: ${input.title}`,
    `Started at: ${input.startedAt}`,
    "",
    "User instructions:",
    input.prompt.trim()
  ].join("\n");
}
