export type NativePluginAgent = "codex" | "claude";
export type NativePluginScope = "user" | "project" | "local" | "managed";

export interface NativePluginRecord {
  id: string;
  name: string;
  displayName?: string;
  marketplace?: string;
  version?: string;
  description?: string;
  installed: boolean;
  enabled: boolean;
  scope?: NativePluginScope;
  source?: string;
  updateAvailable?: boolean;
  iconPath?: string;
  iconPathDark?: string;
  brandColor?: string;
  managedBy?: "cli" | "desktop";
  mentionUri?: string;
}

export interface NativePluginMarketplace {
  name: string;
  source?: string;
  root?: string;
  sourceType?: string;
}

export interface NativePluginSnapshot {
  agent: NativePluginAgent;
  label: string;
  available: boolean;
  version?: string;
  error?: string;
  plugins: NativePluginRecord[];
  marketplaces: NativePluginMarketplace[];
  capabilities: {
    list: boolean;
    install: boolean;
    update: boolean;
    uninstall: boolean;
    marketplaces: boolean;
    scopes: NativePluginScope[];
  };
}

export interface NativePluginCommandResult {
  ok: true;
  agent: NativePluginAgent;
  output?: unknown;
  message?: string;
}

export interface NativePluginMutationInput {
  agent: NativePluginAgent;
  pluginId: string;
  marketplace?: string;
  scope?: NativePluginScope;
}

export interface NativePluginMarketplaceInput {
  agent: NativePluginAgent;
  marketplace?: string;
  source?: string;
  ref?: string;
  scope?: NativePluginScope;
}
