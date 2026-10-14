const ELECTRON_CHILD_ENV_BLOCKLIST = [
  "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR", "ELECTRON_NO_ATTACH_CONSOLE",
  "CHROME_CRASHPAD_PIPE_NAME", "ELECTRON_CRASHPAD_PIPE_NAME"
] as const;
const NODE_OPTIONS_PATH_FLAGS = new Set(["--require", "-r", "--import", "--loader", "--experimental-loader"]);

/** Electron's inherited environment can crash standalone Node native addons on Windows. */
export function sanitizeCliAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of ELECTRON_CHILD_ENV_BLOCKLIST) delete next[key];
  if (typeof next.NODE_OPTIONS === "string") {
    const tokens = next.NODE_OPTIONS.split(/\s+/).filter(Boolean);
    const kept: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (/electron|asar/i.test(token)) continue;
      const eq = token.indexOf("=");
      const flag = eq === -1 ? token : token.slice(0, eq);
      const inline = eq === -1 ? "" : token.slice(eq + 1);
      if (NODE_OPTIONS_PATH_FLAGS.has(flag)) {
        const arg = inline || tokens[i + 1];
        if (arg && /electron|asar/i.test(arg)) { if (inline === "") i++; continue; }
      }
      kept.push(token);
    }
    if (kept.length) next.NODE_OPTIONS = kept.join(" ");
    else delete next.NODE_OPTIONS;
  }
  return next;
}
