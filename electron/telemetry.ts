import { app } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostHog } from "posthog-node";

import { APP_VERSION } from "./app-meta.js";
import { getSetting, setSetting } from "./cli/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENABLED_KEY = "telemetry.enabled";
const INSTALLATION_ID_KEY = "telemetry.installationId";
const LAST_VERSION_KEY = "telemetry.lastVersion";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

interface TelemetryConfig {
  apiKey: string;
  host: string;
}

let client: PostHog | null = null;
let initialized = false;

function readTelemetryConfig(): TelemetryConfig {
  const environmentKey = process.env.FREEBUDDY_POSTHOG_KEY?.trim();
  const environmentHost = process.env.FREEBUDDY_POSTHOG_HOST?.trim();
  if (environmentKey) {
    return {
      apiKey: environmentKey,
      host: environmentHost || DEFAULT_POSTHOG_HOST
    };
  }

  try {
    const raw = fs.readFileSync(path.join(__dirname, "telemetry-config.json"), "utf8");
    const parsed = JSON.parse(raw) as { apiKey?: unknown; host?: unknown };
    return {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
      host:
        typeof parsed.host === "string" && parsed.host.trim()
          ? parsed.host.trim()
          : DEFAULT_POSTHOG_HOST
    };
  } catch {
    return { apiKey: "", host: DEFAULT_POSTHOG_HOST };
  }
}

export function isTelemetryEnabled(): boolean {
  return getSetting(ENABLED_KEY) !== "false";
}

function getOrCreateInstallationId(): { id: string; created: boolean } {
  const existing = getSetting(INSTALLATION_ID_KEY);
  if (existing) return { id: existing, created: false };
  const id = randomUUID();
  setSetting(INSTALLATION_ID_KEY, id);
  return { id, created: true };
}

function capture(
  installationId: string,
  event: "app_first_launch" | "app_launched" | "app_updated",
  properties: Record<string, string | boolean> = {}
): void {
  client?.capture({
    distinctId: installationId,
    event,
    disableGeoip: true,
    properties: {
      $process_person_profile: false,
      installation_id: installationId,
      app_version: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      ...properties
    }
  });
}

export function initializeTelemetry(): void {
  if (initialized || !isTelemetryEnabled()) return;
  initialized = true;

  const config = readTelemetryConfig();
  if (!config.apiKey) return;

  client = new PostHog(config.apiKey, {
    host: config.host,
    flushAt: 1,
    flushInterval: 0,
    disableGeoip: true,
    enableExceptionAutocapture: false
  });

  const installation = getOrCreateInstallationId();
  const previousVersion = getSetting(LAST_VERSION_KEY);

  if (installation.created) {
    capture(installation.id, "app_first_launch");
  }
  if (previousVersion && previousVersion !== APP_VERSION) {
    capture(installation.id, "app_updated", {
      previous_version: previousVersion
    });
  }
  capture(installation.id, "app_launched");
  setSetting(LAST_VERSION_KEY, APP_VERSION);
}

export async function shutdownTelemetry(): Promise<void> {
  const activeClient = client;
  client = null;
  initialized = false;
  if (!activeClient) return;
  await activeClient.shutdown(1500).catch(() => undefined);
}

export function setTelemetryEnabled(enabled: boolean): void {
  setSetting(ENABLED_KEY, enabled ? "true" : "false");
  if (enabled) {
    initializeTelemetry();
  } else {
    void shutdownTelemetry();
  }
}
