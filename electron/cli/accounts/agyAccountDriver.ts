import fs from "node:fs";
import { buildCommand } from "../adapters.js";
import { antigravityUpdateBinary } from "../antigravityUpdate.js";
import {
  parseAntigravityKeyringSecret,
  readAntigravityUsage
} from "../antigravityUsage.js";
import { runAuthenticationTerminal } from "../acpAuthTerminal.js";
import { getDb } from "../db.js";
import type { CliEvent } from "../runtimeShared.js";
import {
  deleteSystemKeyringSecret,
  readSystemKeyringSecret,
  writeSystemKeyringSecret
} from "../systemKeyring.js";
import { isAntigravityBridgeBinary } from "../../shared/antigravity.js";
import type {
  CliAccountQuotaSnapshot,
  CliAccountStorageMode
} from "../../shared/cliAccountTypes.js";

export const AGY_KEYRING_SERVICE = "gemini";
export const AGY_KEYRING_ACCOUNT = "antigravity";
export const AGY_ACCOUNT_LOGIN_SESSION_ID = "cli-accounts-agy-acp";

export interface DetectedCredential {
  rawSecret: string;
  identity?: string;
  authMethod?: string;
  expired?: boolean;
}

export interface CliAccountDriver {
  adapter: string;
  storageMode: CliAccountStorageMode;
  supportsConcurrentProfiles: boolean;
  detectCurrent(): Promise<DetectedCredential | null>;
  writeSecret?(rawSecret: string): Promise<void>;
  clearSecret?(): Promise<void>;
  readUsageForSecret?(rawSecret: string): Promise<CliAccountQuotaSnapshot>;
  runInteractiveLogin(input: {
    binary?: string;
    env?: Record<string, string>;
    emit: (event: CliEvent) => void;
  }): Promise<void>;
  resolveExecutionPatch?(account: {
    id: string;
    profileDir?: string;
  }): { env?: Record<string, string>; extraArgs?: string[] } | undefined;
}

export interface AgyAccountDriverDeps {
  keyring?: {
    read(service: string, account: string): Promise<string | null>;
    write(service: string, account: string, secret: string): Promise<void>;
    remove(service: string, account: string): Promise<void>;
  };
  readUsage?: typeof readAntigravityUsage;
  runLoginTerminal?: typeof runAuthenticationTerminal;
}

function readConfiguredAgyBinaryFromDb(): string | undefined {
  try {
    const db = getDb();
    const override = db
      .prepare(`SELECT binary FROM cli_executor_overrides WHERE id = ?`)
      .get("agy-acp") as { binary: string | null } | undefined;
    const overrideBin = override?.binary?.trim();
    if (overrideBin) return overrideBin;

    const runtime = db
      .prepare(`SELECT binary_path, installed FROM cli_runtimes WHERE adapter = ?`)
      .get("agy-acp") as { binary_path: string | null; installed: number } | undefined;
    if (
      runtime?.installed &&
      runtime.binary_path?.trim() &&
      !isAntigravityBridgeBinary(runtime.binary_path)
    ) {
      return runtime.binary_path.trim();
    }
  } catch {
    // Ignore DB lookup errors when called outside initialized DB context.
  }
  return undefined;
}

export function resolveOfficialAgyBinary(
  explicitBinary?: string,
  env?: Record<string, string>
): string {
  const configured = explicitBinary?.trim() || readConfiguredAgyBinaryFromDb();
  if (configured && isAntigravityBridgeBinary(configured)) {
    throw new Error(
      "Legacy agy-acp bridge is not supported for multi-account login. Please upgrade to the official agy CLI (v1.5.9+)."
    );
  }
  if (configured && configured !== "agy") {
    return buildCommand({
      adapter: "agy-acp",
      binary: configured,
      prompt: ""
    }).bin;
  }

  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...(env ?? {}) };
  const candidate = antigravityUpdateBinary(mergedEnv);
  if (candidate && fs.existsSync(candidate)) {
    return candidate;
  }
  return buildCommand({
    adapter: "agy-acp",
    binary: configured || "agy",
    prompt: ""
  }).bin;
}

export function createAgyAccountDriver(
  deps: AgyAccountDriverDeps = {}
): CliAccountDriver {
  const keyring = deps.keyring ?? {
    read: readSystemKeyringSecret,
    write: writeSystemKeyringSecret,
    remove: deleteSystemKeyringSecret
  };
  const readUsage = deps.readUsage ?? readAntigravityUsage;
  const runLoginTerminal = deps.runLoginTerminal ?? runAuthenticationTerminal;

  return {
    adapter: "agy-acp",
    storageMode: "global-slot",
    supportsConcurrentProfiles: false,

    async detectCurrent(): Promise<DetectedCredential | null> {
      const rawSecret = await keyring.read(
        AGY_KEYRING_SERVICE,
        AGY_KEYRING_ACCOUNT
      );
      if (!rawSecret) return null;
      const trimmed = rawSecret.trim();
      if (!trimmed) return null;
      const parsed = parseAntigravityKeyringSecret(trimmed);
      if (!parsed.ok) {
        return { rawSecret: trimmed };
      }
      return {
        rawSecret: trimmed,
        identity: parsed.email,
        authMethod: parsed.authMethod,
        expired: parsed.expired
      };
    },

    async writeSecret(rawSecret: string): Promise<void> {
      await keyring.write(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT, rawSecret);
    },

    async clearSecret(): Promise<void> {
      await keyring.remove(AGY_KEYRING_SERVICE, AGY_KEYRING_ACCOUNT);
    },

    async readUsageForSecret(rawSecret: string): Promise<CliAccountQuotaSnapshot> {
      return readUsage({
        keyringReader: async () => rawSecret
      });
    },

    async runInteractiveLogin({ binary, env, emit }): Promise<void> {
      const bin = resolveOfficialAgyBinary(binary, env);
      if (isAntigravityBridgeBinary(bin)) {
        throw new Error(
          "Legacy agy-acp bridge is not supported for multi-account login. Please upgrade to the official agy CLI (v1.5.9+)."
        );
      }
      await runLoginTerminal({
        sessionId: AGY_ACCOUNT_LOGIN_SESSION_ID,
        agentName: "Antigravity",
        method: {
          id: "google-login",
          name: "Google Login",
          type: "terminal",
          args: ["--login"]
        },
        command: {
          bin,
          args: ["acp"],
          env: { ...process.env, ...(env ?? {}) }
        },
        emit
      });
    }
  };
}
