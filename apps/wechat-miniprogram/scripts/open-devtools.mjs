#!/usr/bin/env node
// Opens this project in the WeChat devtools via its documented CLI, so importing the project is a
// reproducible command instead of a sequence of GUI clicks.
//
// Requirements, all reported honestly rather than worked around:
//   - the devtools must be installed (this script only locates the CLI, it never installs one);
//   - the devtools service port must be enabled (Settings -> Security), otherwise the CLI exits
//     with its own error and that error is shown verbatim;
//   - a real AppID is needed for preview/upload (see README). `cli open` works with the current
//     `touristappid` placeholder, which is enough to prove the project imports and compiles.
//
// Override the CLI location with WECHAT_DEVTOOLS_CLI=/path/to/cli.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CANDIDATES = [
  process.env.WECHAT_DEVTOOLS_CLI,
  "/Applications/wechatwebdevtools.app/Contents/MacOS/cli",
  "/Applications/wechatwebdevtools.app/Contents/MacOS/cli.js",
  "C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat",
  "C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat"
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);

const cli = CANDIDATES.find((candidate) => existsSync(candidate));

if (cli === undefined) {
  console.error("[devtools] WeChat devtools CLI not found. Nothing was launched.");
  console.error("[devtools] Install the devtools, then either open the project manually:");
  console.error(`[devtools]   ${appRoot}`);
  console.error("[devtools] or point this script at the CLI: WECHAT_DEVTOOLS_CLI=/path/to/cli npm run devtools");
  process.exit(1);
}

console.log(`[devtools] using ${cli}`);
console.log(`[devtools] opening ${appRoot}`);

const result = spawnSync(cli, ["open", "--project", appRoot], { stdio: "inherit" });

if (result.error) {
  console.error(`[devtools] failed to start the CLI: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
