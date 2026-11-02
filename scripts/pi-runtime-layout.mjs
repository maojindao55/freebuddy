/**
 * Shared layout constants for the bundled pi runtime.
 *
 * The local dependency tree is staged under `runtime/`. Packaged apps ship an
 * archive instead of this tree. The nested layout remains compatible with
 * local runtime resolution and avoids the old extraResources filter trap if
 * a loose resource is ever needed again (v0.10.5 lost root-level node_modules).
 *
 * Keep in sync with electron/cli/piRuntime.ts (PI_RUNTIME_STAGING_SUBDIR and
 * piRuntimeRoots) — tests/pi-runtime.test.mjs asserts the two stay aligned.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/** Local runtime staging dir; the archive below is the extraResource. */
export const PI_RUNTIME_ROOT_DIR = path.join(
  repoRoot,
  ".build",
  "pi-runtime"
);

/** The packaged resource contains one archive rather than a node_modules tree. */
export const PI_RUNTIME_PACKAGE_DIR = path.join(repoRoot, ".build", "pi-runtime-package");
export const PI_RUNTIME_ARCHIVE_FILE = "runtime.zip";
export const PI_RUNTIME_PACKAGE_MANIFEST_FILE = "package-manifest.json";

/** Subdir of PI_RUNTIME_ROOT_DIR that holds node_modules and its manifest. */
export const PI_RUNTIME_STAGING_SUBDIR = "runtime";

/** Version manifest written next to the staged node_modules. */
export const PI_RUNTIME_MANIFEST_FILE = "pi-runtime.json";

/** A staging root: contains node_modules and (usually) the manifest. */
export function piRuntimeStagingDir(rootDir = PI_RUNTIME_ROOT_DIR) {
  return path.join(rootDir, PI_RUNTIME_STAGING_SUBDIR);
}

export const PI_ACP_PACKAGE = "pi-acp";
export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

/** Relative to a staging root. */
export const PI_ACP_ENTRY_REL = path.join(
  "node_modules",
  PI_ACP_PACKAGE,
  "dist",
  "index.js"
);

/** Relative to a staging root. */
export const PI_CLI_ENTRY_REL = path.join(
  "node_modules",
  PI_CODING_AGENT_PACKAGE,
  "dist",
  "bundle",
  "cli.js"
);
