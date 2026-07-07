import { useState, type CSSProperties, type ReactNode } from "react";

import { getAgentIconId } from "@/config/agentIcon";
import { lobehubAvatarUrl } from "@/utils/lobehubAvatar";
import { useCliExecutorStore } from "@/store/cliExecutorStore";

interface AgentAvatarProps {
  adapter?: string;
  /** Member/agent id (e.g. "cli-<executor-id>"). Used to resolve custom icons
   *  for cloned agents whose override is keyed by the clone id, not the base
   *  adapter. */
  agentId?: string;
  /** Explicit icon id (e.g. for picker preview). Overrides the stored value. */
  iconKey?: string;
  className?: string;
  fallback?: ReactNode;
  style?: CSSProperties;
}

export function AgentAvatar({
  adapter,
  agentId,
  iconKey,
  className,
  fallback,
  style
}: AgentAvatarProps) {
  const [errored, setErrored] = useState(false);
  const overrideId = agentId?.startsWith("cli-") ? agentId.slice(4) : undefined;
  const storedIcon = useCliExecutorStore((s) => {
    if (overrideId && s.overrides[overrideId]?.icon) {
      return s.overrides[overrideId]!.icon;
    }
    return adapter ? s.overrides[adapter]?.icon : undefined;
  });
  const iconId = getAgentIconId(adapter, iconKey ?? storedIcon);
  const url = iconId && !errored ? lobehubAvatarUrl(iconId) : undefined;

  if (!url) {
    return (
      <div className={className} style={style}>
        {fallback}
      </div>
    );
  }

  return (
    <div
      className={`${className ? `${className} ` : ""}agent-brand-avatar`}
      style={style}
    >
      <img
        src={url}
        alt=""
        className="agent-brand-img"
        onError={() => setErrored(true)}
      />
    </div>
  );
}
