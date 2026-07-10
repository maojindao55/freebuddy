import fs from "node:fs/promises";
import path from "node:path";

import { getActiveBridgePort, buildBridgeSection } from "./agentBridge.js";
import {
  startWatchingFileBridge,
  stopWatchingFileBridge
} from "./fileBridge.js";

const ROOT_GUIDE_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules"];
const FB_SIGNATURE = "auto-created by FreeBuddy";

function buildDetailedGuideContent(port: number): string {
  const bridge = buildBridgeSection(port);
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
- For generated visual assets, navigate to the workspace-relative image path such as \`assets%2Fmockup.png\`; if the image is outside the workspace, pass its absolute path directly or use \`freebuddy-file://open?path=<absolute path>\`.
- Report build/dev-server/status or errors through the bridge so the user can see what happened.

## Communication Channels (Zero-Network File Bridge & Local HTTP Bridge)

To trigger preview/navigate/status/notify actions in FreeBuddy, you can use either of the following two channels:

### 1. Preferred Channel (Zero-Network File-based Bridge)
If you are running in a restricted sandbox/container environment, or on a system where network curl commands are restricted or flaky (like Windows), write a simple JSON file to \`.freebuddy/bridge.json\`.
FreeBuddy watches this directory, executes your action, and will automatically delete the file for you.

To use it, write a file at \`.freebuddy/bridge.json\` with this exact format:
\`\`\`json
{
  "action": "navigate",
  "params": {
    "to": "http://127.0.0.1:5173/"
  }
}
\`\`\`

You can also trigger action "preview" (without parameters) like this:
\`\`\`json
{
  "action": "preview"
}
\`\`\`

Supported actions for the file-based bridge are: "preview", "navigate", "entry", "status", "error", "notify".

### 2. Alternative Channel (Local HTTP Bridge)
${bridge}

> This file was ${FB_SIGNATURE} and is safe to edit or delete.
`;
}

export interface AgentGuideStatus {
  path: string;
  action: "created" | "updated";
}

export interface AgentGuideOptions {
  /** ACP sessions receive Draft as a native MCP tool and do not need repo files. */
  nativeDraftTools?: boolean;
}

async function ensureGitignore(cwd: string): Promise<void> {
  const gitignorePath = path.join(cwd, ".gitignore");
  let content = "";
  let exists = false;
  try {
    content = await fs.readFile(gitignorePath, "utf8");
    exists = true;
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.warn(`[FreeBuddy] Failed to read .gitignore at ${gitignorePath}:`, err);
    }
    exists = false;
  }

  const rule = ".freebuddy/";
  if (exists) {
    const lines = content.split(/\r?\n/);
    const hasRule = lines.some((line) => {
      const cleaned = line.replace(/#.*$/, "").trim();
      return cleaned === rule || cleaned === ".freebuddy" || cleaned === rule.slice(0, -1);
    });
    if (!hasRule) {
      const separator = content.endsWith("\n") ? "" : "\n";
      try {
        await fs.writeFile(gitignorePath, content + separator + rule + "\n", "utf8");
      } catch (err: any) {
        console.warn(`[FreeBuddy] Failed to append rule to .gitignore at ${gitignorePath}:`, err);
      }
    }
  } else {
    try {
      await fs.writeFile(gitignorePath, rule + "\n", "utf8");
    } catch (err: any) {
      console.warn(`[FreeBuddy] Failed to create .gitignore with rule at ${gitignorePath}:`, err);
    }
  }
}

export async function ensureAgentGuides(
  cwd: string,
  options: AgentGuideOptions = {}
): Promise<AgentGuideStatus[]> {
  const written: AgentGuideStatus[] = [];
  if (!cwd || !path.isAbsolute(cwd)) return written;

  if (options.nativeDraftTools) {
    stopWatchingFileBridge();
    return written;
  }

  // Start watching the file bridge for this cwd
  void startWatchingFileBridge(cwd).catch((err: any) => {
    console.warn(`[FreeBuddy] Failed to start file bridge watcher for ${cwd}:`, err);
  });

  const activePort = getActiveBridgePort();
  const detailedContent = buildDetailedGuideContent(activePort);

  // 1. Ensure .gitignore excludes .freebuddy/
  try {
    await ensureGitignore(cwd);
  } catch (err: any) {
    console.warn(`[FreeBuddy] ensureGitignore encountered unexpected error:`, err);
  }

  // 2. Ensure .freebuddy/ folder exists
  const freebuddyDir = path.join(cwd, ".freebuddy");
  try {
    await fs.mkdir(freebuddyDir, { recursive: true });
  } catch (err: any) {
    console.warn(`[FreeBuddy] Failed to create .freebuddy directory at ${freebuddyDir}:`, err);
  }

  // 3. Write guides to root files (AGENTS.md, CLAUDE.md, .cursorrules)
  for (const name of ROOT_GUIDE_FILES) {
    const full = path.join(cwd, name);
    let exists = false;
    try {
      await fs.access(full);
      exists = true;
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.warn(`[FreeBuddy] Failed to check access for ${full}:`, err);
      }
      exists = false;
    }
    if (exists) {
      // Update only files FreeBuddy previously generated; leave user edits alone.
      try {
        const current = await fs.readFile(full, "utf8");
        if (current.includes(FB_SIGNATURE)) {
          if (current !== detailedContent) {
            await fs.writeFile(full, detailedContent, "utf8");
            written.push({ path: name, action: "updated" });
          }
        }
      } catch (err: any) {
        console.warn(`[FreeBuddy] Failed to update guide file at ${full}:`, err);
      }
    } else {
      try {
        await fs.writeFile(full, detailedContent, "utf8");
        written.push({ path: name, action: "created" });
      } catch (err: any) {
        console.warn(`[FreeBuddy] Failed to create guide file at ${full}:`, err);
      }
    }
  }

  // 4. Write to .cursor/rules/freebuddy.md if .cursor/ directory exists or we can write to it
  const cursorRulesDir = path.join(cwd, ".cursor", "rules");
  const cursorRuleFile = path.join(cursorRulesDir, "freebuddy.md");
  try {
    await fs.mkdir(cursorRulesDir, { recursive: true });
    let exists = false;
    try {
      await fs.access(cursorRuleFile);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      try {
        const current = await fs.readFile(cursorRuleFile, "utf8");
        if (current !== detailedContent) {
          await fs.writeFile(cursorRuleFile, detailedContent, "utf8");
          written.push({
            path: path.join(".cursor", "rules", "freebuddy.md"),
            action: "updated"
          });
        }
      } catch (err: any) {
        console.warn(`[FreeBuddy] Failed to read/update Cursor rule file at ${cursorRuleFile}:`, err);
      }
    } else {
      await fs.writeFile(cursorRuleFile, detailedContent, "utf8");
      written.push({
        path: path.join(".cursor", "rules", "freebuddy.md"),
        action: "created"
      });
    }
  } catch (err: any) {
    console.warn(`[FreeBuddy] Failed to write Cursor rule file at ${cursorRuleFile}:`, err);
  }

  return written;
}
