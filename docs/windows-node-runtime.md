# Windows bundled Node runtime

Windows x64 builds include the official Node 24.21.0 distribution with npm and
npx. Other platform builds keep their existing runtime behavior.

`scripts/managed-node-package.mjs` pins the official archive's SHA256 from
Node's release checksums. electron-builder's existing `beforePack` hook prepares
the archive for the target architecture. The Windows `afterPack` guard verifies
that the runtime was actually copied into `resources/node-runtime`.

The app prepares the local archive in the background. Agent checks, installation,
authentication and execution wait for preparation before starting tools. First
preparation uses Electron and needs neither a system Node nor a network connection.
Subsequent launches reuse the verified cache. Missing or modified essential files
trigger extraction again. A filesystem lock coordinates multiple app processes;
dead-process locks recover automatically.

Inside the existing FreeBuddy data directory:

- `node-runtime/<version>-win-x64-<checksum>` contains the versioned runtime.
- `node-cli` holds application-managed global npm CLI installations.
- `npm-cache` holds their writable download cache.

Ordinary FreeBuddy upgrades (including changes to the installation path) reuse
the same runtime directory across app processes. The cache key includes only
Node's version, architecture and archive checksum, never FreeBuddy's version.
A healthy runtime is verified and activated without opening or extracting
`node.zip`, and its ready marker is not rewritten. Clearing `npm-cache` only
recreates that directory. Existing CLI installations are not reinstalled.

Only the first launch, a changed Node release/checksum, or damaged essential
runtime files triggers offline extraction. A Node release change selects a new
versioned directory while retaining the shared CLI prefix and npm cache. Older
runtime directories remain available to app processes still using them.
The Windows installer replaces the application directory and preserves user
data on updates, so these caches survive installation of a newer app.

Every full Windows installer still includes the pinned archive so new installs
and cache repair work offline. The archive stays byte-identical between app
releases using the same Node version. The existing Windows release workflow
publishes installer blockmaps for electron-updater's differential downloads;
when differential download is unavailable it can fall back to the full installer.

The Node selection order is an explicit `FREEBUDDY_NODE_BIN`, then the bundled
runtime, then existing system discovery for development/older packages. Tool
environments prepend the selected Node directory and managed CLI prefix to PATH,
normalize Windows environment-variable casing and remove inherited Electron
flags. Built-in MCP processes still opt into Electron-as-Node explicitly.
Application-managed npm installs use the private prefix; explicit `--prefix`
arguments for upgrading existing installations retain npm's normal precedence.
Project-local npm installation still uses the project's working directory.

The app does not write system/user PATH or shell profiles. npm-based Agent/MCP
downloads still require network access. Updates of Node are shipped with the app;
update `NODE_VERSION` and `NODE_ARCHIVE_SHA256` together after compatibility tests.

Validation:

```powershell
npm run build:electron
npm run test:managed-node
npm run typecheck
npm run dist:win
```

The runtime tests cover cross-process app upgrades without archive access,
Node release changes without CLI/cache loss, cache reuse/repair, checksum rejection, concurrent app
processes, interrupted locks, explicit overrides and Windows PATH refreshes.
The Windows smoke test uses the real archive with system Node removed from PATH,
installs a local CLI through both backend installers, invokes node:sqlite,
connects an external MCP server and checks ACP terminal/Pi launcher execution
under paths containing Chinese characters and spaces. The Electron test runner
preserves the desktop backend's native SQLite ABI while its tool processes use
standalone Node. Release CI runs this smoke test before producing Windows assets.
