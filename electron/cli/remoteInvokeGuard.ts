import path from "node:path";

import { getAdapterDefinition } from "./adapters.js";
import { listOverrides, type CLIExecutorOverride } from "./store.js";
import { remoteRootsForUser } from "./remoteRoots.js";
import { isPathWithinRoots } from "../shared/workspaceRoots.js";
import {
  REMOTE_READABLE_SETTING_KEYS,
  REMOTE_WRITABLE_SETTING_KEYS
} from "../shared/remoteChannelPolicy.js";

/**
 * Channel arguments arriving from the network are attacker controlled. The
 * renderer normally derives `binary` / `extraArgs` / `env` from the host's own
 * adapter overrides, so the guard recomputes those values server side and
 * discards whatever the client sent. Without this, a member could pass
 * `binary: "/bin/sh"` and run anything as the desktop user.
 *
 * Paths are validated rather than replaced, because only the caller knows
 * which of their workspaces they meant.
 */

interface ExecutorConfig {
  binary?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
}

function overridesById(): Map<string, CLIExecutorOverride> {
  return new Map(listOverrides().map((override) => [override.id, override]));
}

function resolveAdapterDefaults(
  adapterId: string,
  overrides: Map<string, CLIExecutorOverride>
): ExecutorConfig {
  const override = overrides.get(adapterId);
  const definition = getAdapterDefinition(override?.baseAdapter ?? adapterId);
  return {
    binary: override?.binary?.trim() || definition?.defaultBinary || adapterId,
    extraArgs: override?.extraArgs?.filter(Boolean) ?? [],
    env: override?.env
  };
}

/**
 * Mirrors the renderer's resolution in conversationStore: a member inherits
 * the base adapter's override and layers its own clone override on top.
 */
function resolveMemberExecutor(agentId: unknown, adapter: unknown): ExecutorConfig {
  const overrides = overridesById();
  const base = typeof adapter === "string" ? adapter : "";
  const defaults = resolveAdapterDefaults(base, overrides);
  const cloneId =
    typeof agentId === "string" && agentId.startsWith("cli-")
      ? agentId.slice(4)
      : null;
  const clone = cloneId ? overrides.get(cloneId) : undefined;
  return {
    binary: clone?.binary?.trim() || defaults.binary,
    extraArgs: [...(defaults.extraArgs ?? []), ...(clone?.extraArgs?.filter(Boolean) ?? [])],
    env: { ...(defaults.env ?? {}), ...(clone?.env ?? {}) }
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertPathAllowed(target: unknown, roots: string[], label: string): void {
  if (typeof target !== "string" || !target.trim()) return;
  if (!isPathWithinRoots(target, roots)) {
    throw new Error(`forbidden_path: ${label}`);
  }
}

const EXECUTOR_CHANNELS = new Set([
  "cli:run",
  "cli:inspectSessionConfigOptions",
  "cli:getCachedSessionConfigOptions"
]);

const CWD_CHANNELS = new Set([
  "cli:run",
  "cli:inspectSessionConfigOptions",
  "cli:getCachedSessionConfigOptions",
  "cli:createConversation",
  "cli:searchWorkspaceFiles"
]);

/**
 * Rewrites the argument list for a remote call, or throws when the request
 * reaches outside what the caller is allowed to touch.
 */
export function guardRemoteInvokeArgs(
  channel: string,
  args: unknown[],
  userId: string | null
): unknown[] {
  const first = args[0];

  if (channel === "settings:get") {
    const key = typeof first === "string" ? first : "";
    if (!REMOTE_READABLE_SETTING_KEYS.includes(key)) {
      throw new Error(`forbidden_setting: ${key}`);
    }
    return args;
  }

  if (channel === "settings:set") {
    const payload = asRecord(first);
    const key = typeof payload?.key === "string" ? payload.key : "";
    if (!REMOTE_WRITABLE_SETTING_KEYS.includes(key)) {
      throw new Error(`forbidden_setting: ${key}`);
    }
    return args;
  }

  if (channel === "cli:check") {
    const payload = asRecord(first);
    if (!payload) return args;
    const adapter = typeof payload.adapter === "string" ? payload.adapter : "";
    const runtimeAdapter =
      typeof payload.runtimeAdapter === "string" && payload.runtimeAdapter.trim()
        ? payload.runtimeAdapter.trim()
        : adapter;
    const resolved = resolveAdapterDefaults(runtimeAdapter, overridesById());
    return [
      { ...payload, binary: resolved.binary, env: resolved.env },
      ...args.slice(1)
    ];
  }

  const roots = remoteRootsForUser(userId);
  const payload = asRecord(first);

  if (EXECUTOR_CHANNELS.has(channel) && payload) {
    const resolved = resolveMemberExecutor(payload.agentId, payload.adapter);
    const next: Record<string, unknown> = {
      ...payload,
      binary: resolved.binary,
      extraArgs: resolved.extraArgs,
      env: resolved.env
    };
    if (CWD_CHANNELS.has(channel)) {
      assertPathAllowed(next.cwd, roots, "cwd");
    }
    return [next, ...args.slice(1)];
  }

  if (CWD_CHANNELS.has(channel) && payload) {
    assertPathAllowed(payload.cwd, roots, "cwd");
    return args;
  }

  if (channel === "cli:resolveDraftEntry") {
    assertPathAllowed(first, roots, "cwd");
    return args;
  }

  if (channel === "cli:readDraftMarkdown" && payload) {
    const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
    const rel = typeof payload.rel === "string" ? payload.rel : "";
    assertPathAllowed(cwd, roots, "cwd");
    if (cwd && rel) assertPathAllowed(path.resolve(cwd, rel), roots, "rel");
    return args;
  }

  if (channel === "cli:ensureAgentGuides") {
    if (typeof first === "string") {
      assertPathAllowed(first, roots, "cwd");
    } else if (payload) {
      assertPathAllowed(payload.cwd, roots, "cwd");
    }
    return args;
  }

  if (channel === "scheduledTasks:create" && payload) {
    assertPathAllowed(payload.cwd, roots, "cwd");
    return args;
  }

  if (channel === "scheduledTasks:update" && payload) {
    const input = asRecord(payload.input);
    if (input) assertPathAllowed(input.cwd, roots, "cwd");
    return args;
  }

  return args;
}

/**
 * Overrides carry the host's BYOK keys in `env`. Remote clients no longer need
 * those values (the guard injects them at call time), so they never leave the
 * desktop.
 */
export function filterRemoteInvokeResult(channel: string, result: unknown): unknown {
  if (channel !== "cli:listOverrides" || !Array.isArray(result)) return result;
  return result.map((entry) => {
    const override = asRecord(entry);
    if (!override?.env || typeof override.env !== "object") return entry;
    const redacted = Object.fromEntries(
      Object.keys(override.env as Record<string, string>).map((key) => [key, ""])
    );
    return { ...override, env: redacted };
  });
}
