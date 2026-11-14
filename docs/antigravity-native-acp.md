# Antigravity native ACP

FreeBuddy keeps the internal adapter ID `agy-acp`, but defaults to the official
Antigravity CLI, version 1.5.9 or newer:

```sh
agy acp --process-per-session
```

The isolated worker flag enables client-provided HTTP MCP servers and keeps
session workspaces separate. FreeBuddy handles the server's ACP permission
requests according to the conversation's existing approval setting.

Install the CLI using Settings → CLI Agent → Antigravity → Install, or follow
the [official installation guide](https://antigravity.google/docs/cli/tutorial/).
Sign in with `agy` or `agy acp --login`. Upgrade uses `agy update`, followed by
version and ACP handshake verification. Release checks use the official
`google-antigravity/antigravity-cli` GitHub repository.

## Existing conversations

On a local conversation's next run, FreeBuddy reads the bridge's
`~/.agy-acp/sessions/*.json` records, or the older `~/.agy-acp-state.json`, to
translate a bridge session ID into its native `conversationId`. After a
successful connection, FreeBuddy saves the native ID through its normal
session lifecycle. The original bridge state is preserved. Records without a
native conversation start a new session; invalid state is reported rather
than silently losing history. Remote isolated callers do not read desktop
bridge state.

Persisted `effort` selections become `thought_level`; the bridge's
`gpt-oss-120b` model ID becomes `gpt-oss-120b-medium`. Explicit native selections
take precedence. Native ACP connections are kept warm within the same
conversation under the existing process-pool limits and configuration checks.

## Temporary bridge fallback

To opt back into the bridge, set the Antigravity executor's binary explicitly
to `agy-acp` or its absolute executable path. FreeBuddy retains bridge command
construction, package upgrades, and local diff extensions during migration.
The npm dependency remains available for this transition. Reset the binary
override to return to the official CLI. Cached runtime paths alone do not pin
an executor to the old bridge.

Native conversation IDs are not bridge session IDs. Reopening a pre-migration
conversation with the bridge may require its original bridge session ID;
switching back does not convert a newly created native conversation into a
bridge record.

## Live verification

After `npm run build:electron`, run:

```sh
FREEBUDDY_TEST_AGY_NATIVE=1 node --test tests/antigravity-native-live.test.mjs
```

This opt-in test uses an already signed-in CLI and Claude Sonnet by default
(`FREEBUDDY_TEST_AGY_MODEL` can select another available model). It makes two
model turns, checks an injected MCP echo tool and real file diffs, reloads the
session, and reconnects from a new process. Temporary files are removed on
success and retained with a diagnostic path on failure.
