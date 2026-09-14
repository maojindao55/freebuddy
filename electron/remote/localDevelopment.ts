import { safeStorage } from "electron";
import { getSetting, setSetting } from "../cli/settings.js";
import { createHostCredentials, type HostCredentialRecord, type HostCredentialStore } from "./credentials.js";
import { ReadOnlyRemoteService } from "./readOnlyService.js";

const CREDENTIAL_SETTING = "remote.hostCredential.v1";

class SettingsCredentialStore implements HostCredentialStore {
  load(): HostCredentialRecord | undefined {
    const stored = getSetting(CREDENTIAL_SETTING);
    if (!stored) return undefined;
    try {
      const value: unknown = JSON.parse(stored);
      if (!value || typeof value !== "object") return undefined;
      const record = value as HostCredentialRecord;
      return typeof record.hostId === "string" && typeof record.keyId === "string" && typeof record.publicKey === "string" && typeof record.encryptedPrivateKey === "string" ? record : undefined;
    } catch { return undefined; }
  }
  save(record: HostCredentialRecord): void { setSetting(CREDENTIAL_SETTING, JSON.stringify(record)); }
}

/**
 * Explicit local-only D4 entry point. It is intentionally enabled only by
 * FB_REMOTE_READONLY_DEV=1, with a literal-loopback endpoint and an ephemeral
 * token supplied by the developer's process environment. D7 owns persistent
 * settings, pairing, and production enablement.
 */
export function startReadOnlyRemoteDevelopment(): ReadOnlyRemoteService | undefined {
  if (process.env.FB_REMOTE_READONLY_DEV !== "1") return undefined;
  const endpoint = process.env.FB_REMOTE_DEV_ENDPOINT;
  const token = process.env.FB_REMOTE_DEV_HOST_TOKEN;
  const configuredHostId = process.env.FB_REMOTE_DEV_HOST_ID;
  if (!endpoint || !token || !configuredHostId) return undefined;

  const credentials = createHostCredentials(safeStorage, new SettingsCredentialStore(), { hostId: configuredHostId });
  // The dev Relay binds host identity from this explicit local value. Do not
  // reuse production credentials across a mismatched dev relay identity.
  if (credentials.hostId !== configuredHostId) return undefined;

  let relayState = false;
  const service = new ReadOnlyRemoteService({
    hostId: credentials.hostId,
    status: () => ({
      hostId: credentials.hostId, online: relayState, appVersion: process.env.FB_APP_VERSION || "0.9.10",
      protocolVersion: 1, remoteEnabled: true, activeRunCount: 0, pendingDecisionCount: 0, activeTerminalCount: 0
    })
  });
  service.enable({
    endpoint,
    development: { enabled: true, hostToken: token, hostId: credentials.hostId },
    onStatus: status => { relayState = status.state === "online"; }
  });
  return service;
}
