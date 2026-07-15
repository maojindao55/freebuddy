import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  configuredTokenEnvNames,
  isSshRemote,
  parseGitHost
} from "../scripts/github-preflight.mjs";

const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

test("package exposes the GitHub preflight command", () => {
  assert.equal(
    packageJson.scripts?.["github:preflight"],
    "node scripts/github-preflight.mjs"
  );
});

test("parseGitHost supports SSH and HTTPS remotes", () => {
  assert.equal(parseGitHost("git@github.com:maojindao55/freebuddy.git"), "github.com");
  assert.equal(parseGitHost("ssh://git@github.example.com/team/repo.git"), "github.example.com");
  assert.equal(parseGitHost("https://github.com/maojindao55/freebuddy.git"), "github.com");
  assert.equal(parseGitHost("not-a-remote"), "");
});

test("isSshRemote distinguishes SSH from HTTPS remotes", () => {
  assert.equal(isSshRemote("git@github.com:owner/repo.git"), true);
  assert.equal(isSshRemote("ssh://git@github.com/owner/repo.git"), true);
  assert.equal(isSshRemote("https://github.com/owner/repo.git"), false);
});

test("configuredTokenEnvNames reports names without exposing values", () => {
  assert.deepEqual(
    configuredTokenEnvNames({ GH_TOKEN: "secret", GITHUB_TOKEN: "", OTHER: "value" }),
    ["GH_TOKEN"]
  );
});

test("agent instructions require preflight and sandbox verification before login", () => {
  const instructions = fs.readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  assert.match(instructions, /npm run github:preflight/);
  assert.match(instructions, /rerun it with system permissions/);
  assert.match(instructions, /before starting a new browser login/);
});
