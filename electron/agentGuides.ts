import fs from "node:fs/promises";
import path from "node:path";

import { BRIDGE_PORT, buildBridgeSection } from "./agentBridge.js";

const GUIDE_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules"];
const FB_SIGNATURE = "auto-created by FreeBuddy";

function buildGuideContent(): string {
  const bridge = buildBridgeSection(BRIDGE_PORT);
  return `# FreeBuddy Workspace Guide

You are working inside **FreeBuddy**, a local-first desktop app that runs you
as a coding agent and streams your work to the user in real time.

## Environment
- This directory is the user's project root.
- File edits and creates you make are tracked and shown live to the user.
- The user can preview web output (HTML/CSS/JS) in a side panel.

## Producing previewable output
When the task involves building or changing anything visual or document-like:
- After creating or updating previewable output, proactively call the FreeBuddy bridge to open Draft. Do not ask the user to open files manually.
- If the project has a dev script (Vite/Next/React/Vue/etc.), start it with a localhost host, e.g. \`npm run dev -- --host 127.0.0.1\`, then point Draft at the dev-server URL with the FreeBuddy bridge.
- Do not point Draft at \`index.html\` for bundled apps that require \`npm run dev\`; that often misses CSS/assets/routes.
- For plain static pages, write a self-contained \`index.html\` at the project root (or under \`dist/\`) and use relative paths for CSS/JS/assets.
- For documentation output, write or update a Markdown file such as \`README.md\`, then immediately call \`/freebuddy/navigate?to=README.md\`.
- For generated visual assets, write an image such as \`assets/mockup.png\`, then immediately call \`/freebuddy/navigate?to=assets%2Fmockup.png\`.
- Report build/dev-server/status or errors through the bridge so the user can see what happened.

${bridge}

> This file was ${FB_SIGNATURE} and is safe to edit or delete.
`;
}

export async function ensureAgentGuides(
  cwd: string
): Promise<string[]> {
  const written: string[] = [];
  if (!cwd || !path.isAbsolute(cwd)) return written;

  const content = buildGuideContent();
  for (const name of GUIDE_FILES) {
    const full = path.join(cwd, name);
    let exists = false;
    try {
      await fs.access(full);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      // Update only files FreeBuddy previously generated; leave user edits alone.
      try {
        const current = await fs.readFile(full, "utf8");
        if (current.includes(FB_SIGNATURE)) {
          await fs.writeFile(full, content, "utf8");
        }
      } catch {
        // ignore read/write errors
      }
    } else {
      try {
        await fs.writeFile(full, content, "utf8");
        written.push(name);
      } catch {
        // ignore write errors (permissions, read-only, etc.)
      }
    }
  }

  return written;
}
