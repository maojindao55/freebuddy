#!/usr/bin/env node
// Merges two per-arch electron-updater metadata files (latest-mac-arm64.yml
// and latest-mac-x64.yml) into a single latest-mac.yml whose `files` list
// covers both architectures. electron-updater on macOS reads latest-mac.yml
// and picks the matching arch entry automatically.

import fs from "node:fs";
import path from "node:path";

function parseYml(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const top = {};
  const files = [];
  let cur = null;
  let inFiles = false;

  for (const line of lines) {
    if (line.startsWith("files:")) {
      inFiles = true;
      continue;
    }
    if (inFiles) {
      const mItem = line.match(/^\s*-\s*url:\s*(.+)$/);
      const mKv = line.match(/^\s{4,}([a-zA-Z0-9_-]+):\s*(.+)$/);
      if (mItem) {
        if (cur) files.push(cur);
        cur = { url: mItem[1].trim() };
        continue;
      }
      if (mKv && cur) {
        cur[mKv[1]] = mKv[2].trim();
        continue;
      }
      if (/^[a-zA-Z]/.test(line)) {
        if (cur) {
          files.push(cur);
          cur = null;
        }
        inFiles = false;
      }
    }
    if (!inFiles) {
      const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (m) top[m[1]] = m[2];
    }
  }
  if (cur) files.push(cur);
  return { top, files };
}

function dumpYml(doc) {
  const order = ["version", "files", "path", "sha512", "releaseDate"];
  const lines = [];
  for (const key of order) {
    if (key === "files") {
      lines.push("files:");
      for (const f of doc.files) {
        lines.push(`  - url: ${f.url}`);
        for (const k of Object.keys(f)) {
          if (k === "url") continue;
          lines.push(`    ${k}: ${f[k]}`);
        }
      }
      continue;
    }
    const v = doc.top[key];
    if (v !== undefined && v !== "") lines.push(`${key}: ${v}`);
  }
  return lines.join("\n") + "\n";
}

const [armPath, x64Path, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("usage: merge-mac-latest-yml.mjs <arm64.yml> <x64.yml> <out.yml>");
  process.exit(2);
}

const arm = parseYml(armPath);
const x64 = parseYml(x64Path);

if (!arm && !x64) {
  console.error("Neither arm64 nor x64 yml found; nothing to merge.");
  process.exit(1);
}

const base = arm ?? x64;
const merged = { top: { ...base.top }, files: [...base.files] };
const other = arm ? x64 : null;
if (other) {
  for (const f of other.files) {
    if (!merged.files.some((x) => x.url === f.url)) merged.files.push(f);
  }
}

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, dumpYml(merged));
process.stdout.write(fs.readFileSync(outPath, "utf8"));
