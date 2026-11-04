const INTERACTION_ENV = new Set(["GCM_INTERACTIVE", "GIT_TERMINAL_PROMPT"]);

function withoutInteractionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !INTERACTION_ENV.has(key.toUpperCase())));
}

/** Background tools must fail on missing credentials instead of opening a hidden login. */
export function backgroundExecutionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...withoutInteractionEnv(env), GCM_INTERACTIVE: "0", GIT_TERMINAL_PROMPT: "0" };
}

/** Keep explicit ACP login terminals independent from the background command guards. */
export function authenticationExecutionEnv(
  guarded: NodeJS.ProcessEnv,
  original: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const restored = withoutInteractionEnv(guarded);
  for (const [key, value] of Object.entries(original)) {
    if (INTERACTION_ENV.has(key.toUpperCase())) restored[key] = value;
  }
  return restored;
}

export function backgroundExecutionArgs(command: string, args: string[]): string[] {
  const executable = command.split(/[\\/]/).pop() ?? "";
  if (!/^(?:powershell|pwsh)(?:\.exe)?$/i.test(executable)) return args;
  // Inspect startup flags only: a script may itself contain '-NonInteractive'.
  const payload = args.findIndex(arg => /^-(?:command|c|encodedcommand|enc|ec|e|file|f|commandwithargs|cwa)$/i.test(arg));
  const flags = payload < 0 ? args : args.slice(0, payload);
  return flags.some(arg => /^-noninteractive$/i.test(arg)) ? args : ["-NonInteractive", ...args];
}

/** Native adapter tools cannot all be intercepted by the client's terminal manager. */
export function backgroundExecutionPrompt(prompt: string, platform: string): string {
  if (platform !== "win32") return prompt;
  return [
    "<freebuddy-execution-context>",
    "Commands run in the background without an interactive console. Start PowerShell/pwsh with -NonInteractive. Missing inputs must return an error rather than wait for keyboard input.",
    "Avoid nesting a double-quoted powershell -Command script inside another PowerShell command: the outer shell expands $variables. Prefer a script file, -EncodedCommand, or the current shell directly. Use distinct variable names rather than overwriting automatic variables such as $HOME.",
    "Git commands must use existing credentials and fail promptly if login is required. Report the authentication error so the user can complete an explicit login, then retry. Do not open a background credential prompt or automatically switch repository remotes.",
    "</freebuddy-execution-context>",
    prompt
  ].join("\n");
}
