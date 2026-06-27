import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useBusinessWorkspaceStore } from "@/store/businessWorkspaceStore";
import type { BusinessWorkspace } from "@/services/businessWorkspaces/types";
import { BusinessWorkspaceList } from "./BusinessWorkspaceList";
import { BusinessWorkspaceEditor } from "./BusinessWorkspaceEditor";

export function BusinessWorkspacesTab() {
  const { t } = useTranslation();
  const loaded = useBusinessWorkspaceStore((s) => s.loaded);
  const load = useBusinessWorkspaceStore((s) => s.load);
  const workspaces = useBusinessWorkspaceStore((s) => s.workspaces);
  const [editing, setEditing] = useState<BusinessWorkspace | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  return (
    <div className="settings-tab">
      <div className="settings-section-heading">
        <h3 className="settings-section-title">{t("business.workspaceList")}</h3>
        <span className="settings-section-desc">{t("business.workspaceHint")}</span>
      </div>

      {editing || creating ? (
        <BusinessWorkspaceEditor
          workspace={editing ?? undefined}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
          }}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
          }}
        />
      ) : (
        <BusinessWorkspaceList
          workspaces={workspaces}
          onNew={() => setCreating(true)}
          onEdit={(w) => setEditing(w)}
        />
      )}
    </div>
  );
}
