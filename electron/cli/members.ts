import { getAdapterDefinition, cliAdapterDefinitions } from "./adapters.js";
import { builtinCliMembers, type CLIMember } from "./cliMemberBuiltins.js";
import { listOverrides } from "./store.js";
import { mergeRequiredSkillIds } from "./agentProfiles.js";
import { getSetting } from "./settings.js";
import { listRuntimes } from "./check.js";

const MEMBER_RUNTIME_OVERRIDES_KEY = "member.runtimeOverrides";

function loadMemberOverrideMap(key: string): Record<string, string> {
  const raw = getSetting(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const result: Record<string, string> = {};
      for (const [mapKey, value] of Object.entries(
        parsed as Record<string, unknown>
      )) {
        if (typeof value === "string") result[mapKey] = value;
      }
      return result;
    }
  } catch {
    // ignore malformed override payload
  }
  return {};
}

export { builtinCliMembers, type CLIMember };

export function listCliMembers(): CLIMember[] {
  const overrides = listOverrides();
  const overrideById = new Map(overrides.map((override) => [override.id, override]));
  const runtimeOverrides = loadMemberOverrideMap(MEMBER_RUNTIME_OVERRIDES_KEY);
  const runtimesById = new Map(listRuntimes().map((rt) => [rt.adapter, rt]));
  const dynamicDefaultAdapter = cliAdapterDefinitions.find(
    (def) => def.protocol === "acp" && runtimesById.get(def.id)?.installed
  )?.id;
  const builtinMembers = builtinCliMembers.map((member) => {
    const overrideAdapter = member.runtimeKey
      ? runtimeOverrides[member.id]
      : undefined;
    const defaultAdapter =
      member.profile === "butler"
        ? (dynamicDefaultAdapter ?? member.cli.adapter)
        : member.cli.adapter;
    const adapter = overrideAdapter ?? defaultAdapter;
    const adapterOverride = overrideById.get(adapter);
    const extraArgs = [
      ...(adapterOverride?.extraArgs ?? []),
      ...(member.cli.extraArgs ?? [])
    ];
    const env = {
      ...(adapterOverride?.env ?? {}),
      ...(member.cli.env ?? {})
    };
    return {
      ...member,
      runtimeKey: adapter,
      enabled: adapterOverride?.enabled ?? member.enabled,
      cli: {
        ...member.cli,
        adapter,
        binary: member.cli.binary ?? adapterOverride?.binary,
        ...(extraArgs.length > 0 ? { extraArgs } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        skillIds: mergeRequiredSkillIds(
          member.id,
          adapterOverride?.skillIds ?? member.cli.skillIds
        )
      }
    };
  });
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
