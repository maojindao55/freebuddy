export const SPORTS_EVENTS_SOURCE_URL = "https://www.espn.com/nba/scoreboard/";
const SPORTS_SCOREBOARD_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball";
const NBA_LEAGUES = ["nba", "nba-summer"] as const;
const MAX_NBA_GAMES = 10;
type SportsDateOffset = -1 | 0 | 1;

type JsonRecord = Record<string, unknown>;

interface ParsedNbaGame {
  id: string;
  state: string;
  timestamp: number;
  sourceOrder: number;
  row: Record<string, string>;
}

function objectValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function normalizeTimeZone(timeZone: unknown): string {
  if (typeof timeZone !== "string" || !timeZone.trim()) return systemTimeZone();
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return systemTimeZone();
  }
}

function dateKeyForTimeZone(
  date: Date,
  timeZone: string = systemTimeZone(),
  offset = 0
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const shiftedDate = new Date(
    Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day) + offset)
  );
  return [
    shiftedDate.getUTCFullYear(),
    String(shiftedDate.getUTCMonth() + 1).padStart(2, "0"),
    String(shiftedDate.getUTCDate()).padStart(2, "0")
  ].join("");
}

function shiftDateKey(dateKey: string, offset: number): string {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(4, 6));
  const day = Number(dateKey.slice(6, 8));
  const shiftedDate = new Date(Date.UTC(year, month - 1, day + offset));
  return [
    shiftedDate.getUTCFullYear(),
    String(shiftedDate.getUTCMonth() + 1).padStart(2, "0"),
    String(shiftedDate.getUTCDate()).padStart(2, "0")
  ].join("");
}

function scoreboardUrl(
  date: Date,
  league: (typeof NBA_LEAGUES)[number] = NBA_LEAGUES[0],
  timeZone: string = systemTimeZone(),
  dateOffset: SportsDateOffset = 0
): string {
  const dateKey = dateKeyForTimeZone(date, timeZone, dateOffset);
  return `${SPORTS_SCOREBOARD_BASE}/${league}/scoreboard?dates=${dateKey}&limit=100`;
}

function teamName(competitor: JsonRecord | undefined): string {
  const team = objectValue(competitor?.team);
  return stringValue(team?.shortDisplayName) || stringValue(team?.displayName);
}

function teamLogo(competitor: JsonRecord | undefined): string {
  const value = stringValue(objectValue(competitor?.team)?.logo);
  if (!value) return "";
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      (url.hostname === "a.espncdn.com" || url.hostname.endsWith(".espncdn.com"))
    ) {
      return url.toString();
    }
  } catch {
    return "";
  }
  return "";
}

function gameLink(event: JsonRecord, competition: JsonRecord): string {
  for (const links of [competition.links, event.links]) {
    if (!Array.isArray(links)) continue;
    for (const entry of links) {
      const href = stringValue(objectValue(entry)?.href);
      if (href.startsWith("https://")) return href;
    }
  }
  return "";
}

export function parseNbaScoreboard(payload: unknown): ParsedNbaGame[] {
  const root = objectValue(payload);
  const events = Array.isArray(root?.events) ? root.events : [];
  const rootLeague = objectValue(Array.isArray(root?.leagues) ? root.leagues[0] : undefined);
  const fallbackLeague =
    stringValue(rootLeague?.abbreviation) || stringValue(rootLeague?.name) || "NBA";
  return events.flatMap((entry, sourceOrder) => {
    const event = objectValue(entry);
    const competition = objectValue(
      Array.isArray(event?.competitions) ? event.competitions[0] : undefined
    );
    const competitors = Array.isArray(competition?.competitors)
      ? competition.competitors
          .map(objectValue)
          .filter((value): value is JsonRecord => Boolean(value))
      : [];
    const home = competitors.find((competitor) => competitor.homeAway === "home");
    const away = competitors.find((competitor) => competitor.homeAway === "away");
    const homeName = teamName(home);
    const awayName = teamName(away);
    const homeLogo = teamLogo(home);
    const awayLogo = teamLogo(away);
    if (!event || !competition || !homeName || !awayName) return [];

    const status = objectValue(competition.status) ?? objectValue(event.status);
    const statusType = objectValue(status?.type);
    const state = stringValue(statusType?.state) || "pre";
    const startTime = stringValue(event.date);
    const timestamp = new Date(startTime).getTime();
    const homeScore = stringValue(home?.score);
    const awayScore = stringValue(away?.score);
    const league =
      stringValue(competition.altGameNote) ||
      stringValue(
        objectValue(Array.isArray(competition.notes) ? competition.notes[0] : undefined)?.headline
      ) ||
      fallbackLeague;
    const sourceStatus =
      stringValue(statusType?.shortDetail) ||
      stringValue(statusType?.description) ||
      stringValue(statusType?.detail);
    const id = stringValue(event.id) || `${startTime}-${homeName}-${awayName}`;
    const url = gameLink(event, competition);

    return [{
      id,
      state,
      timestamp: Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER,
      sourceOrder,
      row: {
        sport: "basketball",
        competition: "nba",
        league,
        home: homeName,
        away: awayName,
        homeScore: state === "pre" ? "" : homeScore || "0",
        awayScore: state === "pre" ? "" : awayScore || "0",
        score:
          state === "pre" ? "— : —" : `${homeScore || "0"} : ${awayScore || "0"}`,
        ...(homeLogo ? { homeLogo } : {}),
        ...(awayLogo ? { awayLogo } : {}),
        state,
        status: sourceStatus,
        startTime,
        ...(url ? { url } : {})
      }
    }];
  });
}

function statePriority(state: string): number {
  if (state === "in") return 0;
  if (state === "pre") return 1;
  if (state === "post") return 2;
  return 3;
}

export function sortNbaGames(games: ParsedNbaGame[]): ParsedNbaGame[] {
  return [...games].sort((left, right) => {
    const priority = statePriority(left.state) - statePriority(right.state);
    if (priority) return priority;
    if (left.state === "post" && right.state === "post") {
      return right.timestamp - left.timestamp || left.sourceOrder - right.sourceOrder;
    }
    return left.timestamp - right.timestamp || left.sourceOrder - right.sourceOrder;
  });
}

export async function fetchNbaScores(
  options: {
    fetchImpl?: typeof fetch;
    now?: Date;
    dateOffset?: SportsDateOffset;
    timeZone?: string;
  } = {}
): Promise<Array<Record<string, string>>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const date = options.now ?? new Date();
  const timeZone = normalizeTimeZone(options.timeZone);
  const dateOffset = options.dateOffset ?? 0;
  const targetDateKey = dateKeyForTimeZone(date, timeZone, dateOffset);
  const queryDateKeys = [-1, 0, 1].map((offset) => shiftDateKey(targetDateKey, offset));
  const requests = NBA_LEAGUES.flatMap((league) =>
    queryDateKeys.map((dateKey) => ({ league, dateKey }))
  );
  const results = await Promise.allSettled(
    requests.map(async ({ league, dateKey }) => {
      const response = await fetchImpl(
        `${SPORTS_SCOREBOARD_BASE}/${league}/scoreboard?dates=${dateKey}&limit=100`,
        {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000)
        }
      );
      if (!response.ok) throw new Error(`${league} returned HTTP ${response.status}`);
      return parseNbaScoreboard(await response.json());
    })
  );
  if (results.every((result) => result.status === "rejected")) {
    throw new Error(
      NBA_LEAGUES.map((league) => {
        const reasons = results
          .filter((_result, index) => requests[index].league === league)
          .map((result) =>
            result.status === "rejected"
              ? (result.reason as Error)?.message || String(result.reason)
              : "unavailable"
          );
        return `${league}: ${[...new Set(reasons)].join(" | ")}`;
      })
        .join("; ")
    );
  }
  const unique = new Map<string, ParsedNbaGame>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const game of result.value) {
      if (
        game.timestamp !== Number.MAX_SAFE_INTEGER &&
        dateKeyForTimeZone(new Date(game.timestamp), timeZone) === targetDateKey &&
        !unique.has(game.id)
      ) {
        unique.set(game.id, game);
      }
    }
  }
  return sortNbaGames([...unique.values()])
    .slice(0, MAX_NBA_GAMES)
    .map((game) => game.row);
}

export const nbaScoreboardInternals = {
  dateKeyForTimeZone,
  shiftDateKey,
  normalizeTimeZone,
  scoreboardUrl,
  teamLogo,
  statePriority,
  NBA_LEAGUES,
  MAX_NBA_GAMES
};
