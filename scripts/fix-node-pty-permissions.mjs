import fs from "node:fs";
import path from "node:path";

const candidates = [
  path.join(
    process.cwd(),
    "node_modules",
    "node-pty",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper"
  ),
  path.join(
    process.cwd(),
    "node_modules",
    "node-pty",
    "build",
    "Release",
    "spawn-helper"
  )
];

for (const candidate of candidates) {
  if (!fs.existsSync(candidate)) continue;
  const mode = fs.statSync(candidate).mode & 0o777;
  if ((mode & 0o111) === 0) {
    fs.chmodSync(candidate, mode | 0o755);
    console.log(`Marked node-pty spawn-helper executable: ${candidate}`);
  }
}
