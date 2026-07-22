import type {
  NativePluginAgent,
  NativePluginCommandResult,
  NativePluginMarketplaceInput,
  NativePluginMutationInput,
  NativePluginSnapshot
} from "./types";

function api() {
  const plugins = window.freebuddy?.plugins;
  if (!plugins) throw new Error("Plugin API is unavailable");
  return plugins;
}

export const pluginsClient = {
  list: (agent: NativePluginAgent): Promise<NativePluginSnapshot> => api().list(agent),
  install: (input: NativePluginMutationInput): Promise<NativePluginCommandResult> =>
    api().install(input),
  update: (input: NativePluginMutationInput): Promise<NativePluginCommandResult> =>
    api().update(input),
  uninstall: (input: NativePluginMutationInput): Promise<NativePluginCommandResult> =>
    api().uninstall(input),
  addMarketplace: (input: NativePluginMarketplaceInput): Promise<NativePluginCommandResult> =>
    api().addMarketplace(input),
  updateMarketplace: (
    input: NativePluginMarketplaceInput
  ): Promise<NativePluginCommandResult> => api().updateMarketplace(input),
  removeMarketplace: (
    input: NativePluginMarketplaceInput
  ): Promise<NativePluginCommandResult> => api().removeMarketplace(input)
};
