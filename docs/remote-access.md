# Shared Access (Web UI)

Configure agents once on a host desktop, then let a small team use FreeBuddy
from browsers on the same local network. The desktop app hosts a WebUI server;
shared clients reuse the full UI and business logic with zero renderer changes.

## Quick start (LAN)

1. Desktop → **Settings → Shared** → toggle **Shared Access** on.
2. The first time you enable it, an **owner** account (`username: buddy`) is
   created and its password is revealed once — copy it.
3. Copy the access URL (e.g. `http://192.168.1.10:18080`) and open it from a
   browser on the same network.
4. Sign in with `buddy` + the password. Other users are added from the same
   **Settings → Shared → Users** section (admin-managed).

Each user has their own conversations, messages, scheduled tasks, workflow
runs, and workspace roots. The desktop owner (admin) can see everyone's data
for oversight; shared users only see their own.

## Workspace isolation

Directories assigned under **Settings → Shared → Users** are source locations
that a user is allowed to open. They may be Git repositories, ordinary folders,
or empty folders. When a browser user starts a task, FreeBuddy creates (or
reuses) a private workspace under its application data directory:

- A Git project is cloned. Only committed Git state is copied, and the clone's
  push URL starts disabled to prevent accidental publication.
- An ordinary folder is copied into a private snapshot and given a clean local
  Git baseline commit. Dependency and generated-cache directories such as
  `node_modules`, `.cache`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.vite`,
  `coverage`, and `target` are omitted.
- An empty folder becomes an empty private workspace with a local Git baseline.
- Absolute, dangling, or source-escaping symbolic links are not copied.

The agent runs in the private workspace, not in the host's original directory.
Two users assigned the same source therefore edit independent working trees.
Git push protection is a safe default, not an immutable policy: an agent that
can edit its workspace can also change its local Git configuration.

Each managed workspace has repository-local Git identity configured from the
WebUI account, for example `test2 <test2@freebuddy.local>`. This configuration
does not read or change the host's global Git identity. The automated snapshot
baseline remains authored by `FreeBuddy <workspace@freebuddy.local>`; later
commits use the WebUI user's local identity. Renaming a WebUI account refreshes
the workspace configuration the next time it is opened, without rewriting
existing commit history.

Managed workspaces are stable and reused for later tasks. They are not
automatically refreshed when the assigned source directory changes in this
first version.

Every remote non-owner WebUI user always gets product-level isolation: a managed
workspace clone, owner-scoped tool sessions, and no desktop-only Draft/Browser
MCP bridges. Separately, each shared user has a **Strict isolation** toggle
(default off) that enables the OS process sandbox for that account on every host
platform:

- macOS: Seatbelt
- Linux: bubblewrap
- Windows: bundled `srt-win`, a dedicated local account, and Windows Filtering
  Platform network rules

When strict isolation is on, the process sandbox grants read/write access to the
user's managed clone and required agent configuration, denies the rest of the
host user directories, and proxies outbound network access. Private, loopback, and
local network destinations are denied; normal public package registries, source
hosts, and agent APIs remain available. When strict isolation is off, agents
still run against the managed workspace but as the host user process (better
compatibility with third-party CLIs such as OpenCode, Qoder, and Grok).
Desktop-started agents and the owner account keep the existing unrestricted
local behavior.

Windows hosts require one administrator-approved setup before the first
strict-isolation WebUI agent run:

```powershell
npx @anthropic-ai/sandbox-runtime windows-install
```

Approve the UAC prompt and keep the Windows **Secondary Logon** (`seclogon`)
service available. Agent commands themselves continue to run as the dedicated
non-administrator sandbox account. FreeBuddy grants and revokes only the helper,
managed workspace, and selected Agent configuration ACLs for each active
session. Node-based Agents installed under the host profile are launched through
a verified, read-only junction (or staged native binary) under
`%ProgramData%\FreeBuddy\agent-links`; this lets Node resolve the entry point
without granting the sandbox access to the AppData parent directories. Managed
WebUI workspaces and per-user `sandbox-home` directories also live under
`%ProgramData%\FreeBuddy` on Windows so Bun-based Agents never `lstat` the host
`AppData` directory during startup. The junction is removed when the sandbox
session ends. Long-lived ACP input uses a per-command bridge file inside that
WebUI user's isolated `sandbox-home`, because the Windows helper does not
forward streaming stdin. The bridge is removed with the rest of the sandbox
session state.
Grok also receives an isolated writable `GROK_HOME` seeded from the desktop
login, so its authentication lock and token refresh never require write access
to the host profile.

## Environment variables

- `FB_REMOTE=1` — enable shared access on startup.
- `FB_REMOTE_PASSWORD=...` — seed/reset the owner password (≥ 8 chars).

## Server settings

**Settings → Shared → Server** controls where the WebUI listens:

- **Port** — defaults to `18080`. If the port is taken the server walks up to
  the next free one and the settings page reports which port it actually got.
- **Network exposure** — *Local network* binds `0.0.0.0`; *This machine only*
  binds `127.0.0.1`, which is what you want when a reverse proxy terminates TLS
  in front of FreeBuddy.

## Security notes

- The agent bridge stays bound to `127.0.0.1:17878` regardless of WebUI settings.
- Passwords are stored as scrypt hashes; sessions are HttpOnly + `SameSite=Strict`
  cookies so authenticated `<img>` / download requests work without exposing the
  token to JavaScript.
- Shared-access calls go through an explicit channel allow-list
  (`electron/shared/remoteChannelPolicy.ts`). Channels are `allow`, `adminOnly`
  or `deny`, and anything unclassified is refused — a contract test fails when a
  newly registered handler has not been categorised.
- The executable, arguments and environment used to spawn a CLI are resolved on
  the host from the stored adapter overrides. Values sent by a shared client are
  discarded, and the requested `cwd` must fall inside that user's assigned
  source directories before it is mapped to a managed clone.
- `settings:get` / `settings:set` are limited to a small key allow-list over the
  bridge, so the stored password hash is not readable from a browser.
- WebSocket session events (`cli://<sessionId>`) are delivered only to the owning
  user; desktop-only event channels are never forwarded to shared clients.
- Browsable workspace directories are assigned per user. **A member with no
  assigned directory can browse nothing**; only the owner falls back to the host
  home folder.
- Task records, reusable tool sessions, terminal decisions, and process-control
  requests are scoped to the owning user. A browser user cannot stop, approve,
  or resume another user's agent process.
- Failed sign-ins are counted per IP + username. After five attempts the pair is
  locked out with an exponential backoff, capped at fifteen minutes.
- Deleting a user also deletes their conversations and scheduled tasks, and
  disabling or deleting an account (or changing its password) immediately
  invalidates its sessions and closes its WebSockets.

## Sessions and auditing

- **Settings → Shared** lists every signed-in device with its IP, browser and
  last-seen time. Sessions can be revoked individually, per user, or all at once.
- The **Activity log** records sign-ins, lockouts, account changes, directory
  changes and session revocations. The last 2000 entries are kept.

## Public / HTTPS deployment

The built-in server is plain HTTP, which is fine for a trusted LAN. **For
internet or any untrusted network, terminate TLS in a reverse proxy** in front
of the WebUI. The server itself intentionally does not manage certificates.

Set **Network exposure** to *This machine only* when you do this, so the plain
HTTP port is not reachable directly. The proxy should forward `X-Forwarded-For`
so session records and the activity log show the real client address.

Example with Caddy (automatic HTTPS):

```caddy
freebuddy.example.com {
    reverse_proxy 127.0.0.1:18080
}
```

Example with nginx + certbot:

```nginx
server {
    listen 443 ssl http2;
    server_name freebuddy.example.com;

    ssl_certificate     /etc/letsencrypt/live/freebuddy.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/freebuddy.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # WebSocket (events + agent output stream)
    location /ws {
        proxy_pass http://127.0.0.1:18080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

To keep the WebUI reachable only via the proxy, leave shared access on but do
not expose `:18080` directly to the internet (firewall it, bind to localhost
behind the proxy, or run the proxy on the same host).

## Dev mode

When the desktop runs against the Vite dev server, the WebUI proxies HTTP and
Vite's HMR WebSocket to the dev server, so shared clients hot-reload during
development without manual refresh.
