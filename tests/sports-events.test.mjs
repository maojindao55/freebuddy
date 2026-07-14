import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  fetchNbaScores,
  nbaScoreboardInternals,
  parseNbaScoreboard,
  SPORTS_EVENTS_SOURCE_URL
} from "../dist-electron/cli/sportsEvents.js";

function event({
  id,
  date,
  state = "pre",
  home = "Home",
  away = "Away",
  homeScore = "0",
  awayScore = "0",
  homeLogo = "",
  awayLogo = "",
  note = "NBA",
  status = "Scheduled"
}) {
  return {
    id,
    date,
    status: { type: { state, shortDetail: status } },
    competitions: [
      {
        altGameNote: note,
        status: { type: { state, shortDetail: status } },
        competitors: [
          {
            homeAway: "away",
            score: awayScore,
            team: { shortDisplayName: away, ...(awayLogo ? { logo: awayLogo } : {}) }
          },
          {
            homeAway: "home",
            score: homeScore,
            team: { shortDisplayName: home, ...(homeLogo ? { logo: homeLogo } : {}) }
          }
        ],
        links: [{ href: `https://www.espn.com/nba/game/${id}` }]
      }
    ]
  };
}

test("NBA provider uses regular and Summer League scoreboards only", () => {
  assert.equal(SPORTS_EVENTS_SOURCE_URL, "https://www.espn.com/nba/scoreboard/");
  assert.deepEqual(nbaScoreboardInternals.NBA_LEAGUES, ["nba", "nba-summer"]);
  const regular = new URL(
    nbaScoreboardInternals.scoreboardUrl(new Date("2026-07-14T02:00:00Z"), "nba")
  );
  const summer = new URL(
    nbaScoreboardInternals.scoreboardUrl(new Date("2026-07-14T02:00:00Z"), "nba-summer")
  );
  assert.equal(regular.pathname, "/apis/site/v2/sports/basketball/nba/scoreboard");
  assert.equal(summer.pathname, "/apis/site/v2/sports/basketball/nba-summer/scoreboard");
  assert.equal(regular.searchParams.get("dates"), "20260714");
});

test("NBA live score keeps teams, points, quarter, and remaining clock", () => {
  const [parsed] = parseNbaScoreboard({
    events: [
      event({
        id: "nba-live",
        date: "2026-07-14T20:00:00Z",
        state: "in",
        home: "Suns",
        away: "Bucks",
        homeScore: "81",
        awayScore: "78",
        homeLogo: "https://a.espncdn.com/i/teamlogos/nba/500/phx.png",
        awayLogo: "https://a.espncdn.com/i/teamlogos/nba/500/mil.png",
        note: "NBA Summer League - Las Vegas",
        status: "4:10 - 4th"
      })
    ]
  });
  assert.deepEqual(parsed.row, {
    sport: "basketball",
    competition: "nba",
    league: "NBA Summer League - Las Vegas",
    home: "Suns",
    away: "Bucks",
    homeScore: "81",
    awayScore: "78",
    score: "81 : 78",
    homeLogo: "https://a.espncdn.com/i/teamlogos/nba/500/phx.png",
    awayLogo: "https://a.espncdn.com/i/teamlogos/nba/500/mil.png",
    state: "in",
    status: "4:10 - 4th",
    startTime: "2026-07-14T20:00:00Z",
    url: "https://www.espn.com/nba/game/nba-live"
  });
});

test("team avatars only accept HTTPS ESPN CDN URLs", () => {
  const [parsed] = parseNbaScoreboard({
    events: [
      event({
        id: "logos",
        date: "2026-07-14T20:00:00Z",
        homeLogo: "http://example.com/home.png",
        awayLogo: "https://a.espncdn.com/i/teamlogos/nba/500/scoreboard/phi.png"
      })
    ]
  });
  assert.equal(parsed.row.homeLogo, undefined);
  assert.equal(
    parsed.row.awayLogo,
    "https://a.espncdn.com/i/teamlogos/nba/500/scoreboard/phi.png"
  );
});

test("live games sort before upcoming and completed games", async () => {
  const payload = {
    events: [
      event({ id: "post", date: "2026-07-14T08:00:00Z", state: "post", homeScore: "90", awayScore: "82", status: "Final" }),
      event({ id: "pre", date: "2026-07-14T14:00:00Z", state: "pre" }),
      event({ id: "live", date: "2026-07-14T10:00:00Z", state: "in", homeScore: "72", awayScore: "68", status: "2:31 - 3rd" })
    ]
  };
  const rows = await fetchNbaScores({
    now: new Date("2026-07-14T03:00:00Z"),
    fetchImpl: async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
  });
  assert.deepEqual(rows.map((row) => row.state), ["in", "pre", "post"]);
  assert.equal(rows[0].score, "72 : 68");
  assert.equal(rows[1].score, "— : —");
});

test("one unavailable NBA route does not discard the other scoreboard", async () => {
  const rows = await fetchNbaScores({
    now: new Date("2026-07-14T03:00:00Z"),
    fetchImpl: async (url) => {
      if (String(url).includes("/nba/scoreboard")) {
        throw new Error("regular season unavailable");
      }
      return new Response(
        JSON.stringify({
          events: [
            event({ id: "summer", date: "2026-07-14T12:00:00Z", note: "NBA Summer League" })
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  });
  assert.equal(rows.length, 1);
  assert.match(rows[0].league, /NBA Summer League/);
});

test("NBA scoreboards follow yesterday, today, and tomorrow in China time", async () => {
  for (const [dateOffset, expectedDate] of [
    [-1, "20260713"],
    [0, "20260714"],
    [1, "20260715"]
  ]) {
    const urls = [];
    await fetchNbaScores({
      now: new Date("2026-07-14T02:00:00Z"),
      dateOffset,
      fetchImpl: async (url) => {
        urls.push(new URL(String(url)));
        return new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });
    assert.equal(urls.length, 2);
    assert.ok(urls.every((url) => url.searchParams.get("dates") === expectedDate));
  }
});

test("all unavailable NBA routes surface useful errors", async () => {
  await assert.rejects(
    () =>
      fetchNbaScores({
        fetchImpl: async () => {
          throw new Error("temporary upstream failure");
        }
      }),
    /nba: temporary upstream failure; nba-summer: temporary upstream failure/
  );
});

test("sports card is fixed to NBA and supports a persisted three-day selector", () => {
  const provider = fs.readFileSync(
    new URL("../electron/cli/sportsEvents.ts", import.meta.url),
    "utf8"
  );
  const service = fs.readFileSync(new URL("../electron/cli/infoCards.ts", import.meta.url), "utf8");
  const settings = fs.readFileSync(
    new URL("../src/components/Settings/InfoCardsTab.tsx", import.meta.url),
    "utf8"
  );
  const dataCard = fs.readFileSync(
    new URL("../src/components/InfoCards/InfoDataCard.tsx", import.meta.url),
    "utf8"
  );
  assert.match(service, /sportsDateOffset/);
  assert.match(service, /fetchNbaScores\(\{/);
  assert.doesNotMatch(service, /sportsKinds|sportsCompetitions|collectBrowserRecipe|card\.recipe/);
  assert.doesNotMatch(settings, /sportsKinds|sportsCompetitions|rowSelector|RecipeEditor/);
  assert.doesNotMatch(provider, /wnba|ncaam|mens-college|soccer/);
  assert.match(dataCard, /row\.homeLogo/);
  assert.match(dataCard, /row\.awayLogo/);
  assert.match(dataCard, /sports-score-team/);
  assert.match(dataCard, /sports-date-filter/);
  assert.match(dataCard, /handleSportsDateChange/);
});
