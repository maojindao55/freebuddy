# Local standalone ACP integration

FreeBuddy detects `deepseek-harness-acp` packages that depend on `@deepseek-ai/dsh-base`.
These runtimes own their default composition. FreeBuddy starts their `lib/bin.js`
with Node, without injecting the legacy Cordis config, koffi guard, or persistence
overlays. Explicit `--config` arguments remain supported and must contain a complete
configuration compatible with that Harness version. Older runtimes keep their
existing composition and overlays.

For local development, build the standalone repository (`npm run build`) and set
the DeepSeek adapter's command override to the absolute entry path, for example:

```text
C:\Users\Morefine\www\deepseek-harness-acp\lib\bin.js
```

Use Node.js 24 or later on PATH. Start FreeBuddy with `npm run dev`. A BYOK provider
configured for `chat` passes `DEEPSEEK_PROTOCOL=chat-completions`; the legacy
`DEEPSEEK_WIRE_API` variable is retained for older runtimes.

For the modern standalone, model arguments (`--model`, `--model=`, `-m`) become
`DEEPSEEK_MODEL`. BYOK sends its full catalog through `DEEPSEEK_MODELS_JSON`,
including display names, context windows, and image support. The standalone
uses that catalog for ACP model options and switching.

Run the opt-in process integration test from the FreeBuddy repository:

```powershell
npm run build:electron
$env:FREEBUDDY_DSH_LOCAL_ENTRY = 'C:\Users\Morefine\www\deepseek-harness-acp\lib\bin.js'
node --test tests/dsh-standalone.test.mjs tests/dsh-local-integration.test.mjs
```

The integration test uses FreeBuddy's command builder and ACP request builders,
a temporary workspace, and a local mock API. It checks initialization, session
creation, text/thought streaming without duplication, token usage, the chat
completion endpoint, session close, and exit code zero. It does not use a real
API key or exercise the Electron UI.

Desktop acceptance still requires checking real-provider replies, permission
dialogs, file and shell tools, client MCP tools, model/effort selection,
cancellation, and restoring a conversation after restarting FreeBuddy.
