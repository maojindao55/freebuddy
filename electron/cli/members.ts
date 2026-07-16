import { getAdapterDefinition } from "./adapters.js";
import { builtinCliMembers, type CLIMember } from "./cliMemberBuiltins.js";
import { listOverrides } from "./store.js";

export { builtinCliMembers, type CLIMember };

export function listCliMembers(): CLIMember[] {
  const overrides = listOverrides();
  const overrideById = new Map(overrides.map((override) => [override.id, override]));
  const builtinMembers = builtinCliMembers.map((member) => ({
    ...member,
    cli: {
      ...member.cli,
      skillIds: overrideById.get(member.cli.adapter)?.skillIds
    }
  }));
  const customMembers = overrides
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
          showStderr: true,
          skillIds: override.skillIds
        }
      };
    })
    .filter((member): member is CLIMember => Boolean(member));
  return [...builtinMembers, ...customMembers];
}
