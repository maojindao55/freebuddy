import { useTranslation } from "react-i18next";

import { useAgentBridgeStore } from "@/store/agentBridgeStore";

export function AgentBridgeToasts() {
  const { t } = useTranslation();
  const toasts = useAgentBridgeStore((s) => s.toasts);
  const dismiss = useAgentBridgeStore((s) => s.dismiss);
  if (!toasts.length) return null;
  return (
    <div className="agent-bridge-toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="agent-bridge-toast" role="status">
          <span>{toast.text}</span>
          <button
            type="button"
            className="agent-bridge-toast-close"
            aria-label={t("common.close")}
            onClick={() => dismiss(toast.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
