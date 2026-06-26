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

## Producing previewable web output
When the task involves building or changing a web page:
- Write a self-contained \`index.html\` at the project root (or under \`dist/\`).
- Use **relative paths** for CSS/JS/assets so they load inside the preview.
- Plain HTML/CSS/JS renders directly. Projects that need a dev server or a
  build step will NOT preview until built to static files.

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
