import { getAdapterDefinition } from "./adapters.js";
import { builtinCliMembers, type CLIMember } from "./cliMemberBuiltins.js";
import { listOverrides } from "./store.js";

export { builtinCliMembers, type CLIMember };

export function listCliMembers(): CLIMember[] {
  const customMembers = listOverrides()
    .filter((override) => override.baseAdapter)
    .map((override): CLIMember | undefined => {
      const baseAdapter = override.baseAdapter!;
      const definition = getAdapterDefinition(baseAdapter);
      if (!definition) return undefined;
      return {
        id: `cli-${override.id}`,
        name: override.label?.trim() || definition.label,
        enabled: override.enabled !== false,
        cli: {
          adapter: baseAdapter,
          binary: override.binary,
          extraArgs: override.extraArgs,
          env: override.env,
          approvalMode: "auto",
          showStderr: true
        }
      };
    })
    .filter((member): member is CLIMember => Boolean(member));
  return [...builtinCliMembers, ...customMembers];
}
