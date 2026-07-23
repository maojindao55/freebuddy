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

export type TelemetryEvent =
  | "app_first_launch"
  | "app_launched"
  | "app_updated"
  | "conversation_created"
  | "agent_run_started"
  | "agent_run_finished"
  | "workflow_run_started"
  | "workflow_run_finished"
  | "agent_setup_completed";

export type TelemetryProperties = Record<string, string | number | boolean>;

interface ProductTelemetryEventProperties {
  conversation_created: {
    adapter: string;
    has_workspace: boolean;
    approval_mode: string;
  };
  agent_run_started: {
    adapter: string;
    run_context: "conversation" | "workflow";
    resumed_session: boolean;
    has_attachments: boolean;
    attachment_count: number;
    approval_mode: string;
    has_workspace: boolean;
  };
  agent_run_finished: {
    adapter: string;
    status: string;
    duration_ms: number;
    exit_code?: number;
    error_category?: string;
  };
  workflow_run_started: {
    team_source: string;
    template: string;
    phase_count: number;
    step_count: number;
    agent_count: number;
    has_workspace: boolean;
    max_loops: number;
  };
  workflow_run_finished: {
    status: string;
    duration_ms: number;
    team_source: string;
    template: string;
    step_count: number;
    agent_count: number;
    failed_step_count: number;
    loop_count: number;
    max_loops: number;
    has_workspace: boolean;
  };
  agent_setup_completed: {
    adapter: string;
    setup_action: "check" | "install";
    result: string;
    error_category?: string;
  };
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
  event: TelemetryEvent,
  properties: TelemetryProperties = {}
): void {
  client?.capture({
    distinctId: installationId,
    event,
    disableGeoip: false,
    properties: {
      $process_person_profile: false,
      installation_id: installationId,
      app_version: APP_VERSION,
      event_schema_version: 1,
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      ...properties
    }
  });
}

export function trackTelemetryEvent<E extends keyof ProductTelemetryEventProperties>(
  event: E,
  properties: ProductTelemetryEventProperties[E]
): void {
  if (!client || !isTelemetryEnabled()) return;
  capture(getOrCreateInstallationId().id, event, properties as TelemetryProperties);
}

export function initializeTelemetry(): void {
  if (initialized || !isTelemetryEnabled()) return;
  initialized = true;

  const config = readTelemetryConfig();
  if (!config.apiKey) return;

  client = new PostHog(config.apiKey, {
    host: config.host,
    flushAt: 20,
    flushInterval: 1000,
    disableGeoip: false,
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
