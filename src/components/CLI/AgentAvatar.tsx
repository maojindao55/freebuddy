import { useState, type CSSProperties, type ReactNode } from "react";

import { getAgentIconId } from "@/config/agentIcon";
import { lobehubAvatarUrl } from "@/utils/lobehubAvatar";
import { useCliExecutorStore } from "@/store/cliExecutorStore";

interface AgentAvatarProps {
  adapter?: string;
  /** Explicit icon id (e.g. for picker preview). Overrides the stored value. */
  iconKey?: string;
  className?: string;
  fallback?: ReactNode;
  style?: CSSProperties;
}

export function AgentAvatar({
  adapter,
  iconKey,
  className,
  fallback,
  style
}: AgentAvatarProps) {
  const [errored, setErrored] = useState(false);
  const storedIcon = useCliExecutorStore((s) =>
    adapter ? s.overrides[adapter]?.icon : undefined
  );
  const iconId = iconKey ?? getAgentIconId(adapter, storedIcon);
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
