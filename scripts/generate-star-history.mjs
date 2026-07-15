#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = "maojindao55/freebuddy";
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputPath = path.join(rootDir, "assets", "star-history.svg");

function ghApi(args) {
  const result = spawnSync("gh", ["api", ...args], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "GitHub API 请求失败");
  }
  return JSON.parse(result.stdout);
}

export function niceMaximum(value) {
  if (value <= 10) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 2 ? 0.2 : normalized <= 5 ? 0.5 : 1;
  return Math.ceil(normalized / step) * step * magnitude;
}

export function buildStepPath(timestamps, startMs, endMs, yMaximum, bounds) {
  const { left, top, width, height } = bounds;
  const x = (time) => left + ((time - startMs) / (endMs - startMs || 1)) * width;
  const y = (count) => top + height - (count / yMaximum) * height;
  let line = `M ${left.toFixed(2)} ${y(0).toFixed(2)}`;
  timestamps.forEach((time, index) => {
    line += ` H ${x(time).toFixed(2)} V ${y(index + 1).toFixed(2)}`;
  });
  line += ` H ${(left + width).toFixed(2)}`;
  return { line, area: `${line} L ${(left + width).toFixed(2)} ${y(0).toFixed(2)} Z` };
}

function formatDate(time) {
  return new Date(time).toISOString().slice(0, 10);
}

export function renderSvg({ createdAt, generatedAt, timestamps }) {
  const width = 960;
  const height = 480;
  const bounds = { left: 72, top: 88, width: 850, height: 322 };
  const startMs = new Date(createdAt).getTime();
  const lastStarMs = timestamps.at(-1) ?? startMs;
  const endMs = Math.max(new Date(generatedAt).getTime(), lastStarMs, startMs + 86_400_000);
  const yMaximum = niceMaximum(timestamps.length);
  const paths = buildStepPath(timestamps, startMs, endMs, yMaximum, bounds);

  const yTicks = Array.from({ length: 6 }, (_, index) => {
    const value = (yMaximum * index) / 5;
    const y = bounds.top + bounds.height - (bounds.height * index) / 5;
    return `<g><line x1="${bounds.left}" y1="${y.toFixed(2)}" x2="${bounds.left + bounds.width}" y2="${y.toFixed(2)}" class="grid"/><text x="${bounds.left - 14}" y="${(y + 4).toFixed(2)}" text-anchor="end" class="axis">${Math.round(value)}</text></g>`;
  }).join("");

  const xTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const time = startMs + (endMs - startMs) * ratio;
    const x = bounds.left + bounds.width * ratio;
    return `<g><line x1="${x.toFixed(2)}" y1="${bounds.top}" x2="${x.toFixed(2)}" y2="${bounds.top + bounds.height}" class="grid"/><text x="${x.toFixed(2)}" y="${bounds.top + bounds.height + 28}" text-anchor="middle" class="axis">${formatDate(time)}</text></g>`;
  }).join("");

  const updatedDate = formatDate(generatedAt);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">FreeBuddy Star History</title>
  <desc id="description">FreeBuddy has ${timestamps.length} GitHub stars as of ${updatedDate}.</desc>
  <defs>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2f81f7" stop-opacity="0.38"/>
      <stop offset="1" stop-color="#2f81f7" stop-opacity="0.04"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="2" stdDeviation="5" flood-color="#1f2328" flood-opacity="0.12"/>
    </filter>
  </defs>
  <style>
    .axis { fill: #57606a; font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .grid { stroke: #d0d7de; stroke-width: 1; opacity: 0.65; }
  </style>
  <rect x="8" y="8" width="944" height="464" rx="16" fill="#ffffff" stroke="#d0d7de" filter="url(#shadow)"/>
  <text x="${bounds.left}" y="42" fill="#1f2328" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="24" font-weight="700">FreeBuddy Star History</text>
  <text x="${bounds.left}" y="67" fill="#57606a" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="14">${timestamps.length} stars · Updated ${updatedDate}</text>
  ${yTicks}
  ${xTicks}
  <path d="${paths.area}" fill="url(#area)"/>
  <path class="star-line" d="${paths.line}" fill="none" stroke="#2f81f7" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="${bounds.left + bounds.width}" cy="${(bounds.top + bounds.height - (timestamps.length / yMaximum) * bounds.height).toFixed(2)}" r="5" fill="#2f81f7" stroke="#ffffff" stroke-width="2"/>
</svg>
`;
}

function main() {
  const metadata = ghApi([`repos/${repository}`]);
  const pages = ghApi([
    "-H",
    "Accept: application/vnd.github.star+json",
    `repos/${repository}/stargazers?per_page=100`,
    "--paginate",
    "--slurp"
  ]);
  const timestamps = pages
    .flat()
    .map((entry) => new Date(entry.starred_at).getTime())
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  if (timestamps.length !== metadata.stargazers_count) {
    throw new Error(`星标数据不完整：API 显示 ${metadata.stargazers_count}，只读取到 ${timestamps.length}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, renderSvg({
    createdAt: metadata.created_at,
    generatedAt: new Date().toISOString(),
    timestamps
  }));
  console.log(`已生成 ${path.relative(rootDir, outputPath)}（${timestamps.length} stars）`);
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
