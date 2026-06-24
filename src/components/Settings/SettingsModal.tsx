import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AboutTab } from "./AboutTab";
import { CLIAdaptersTab } from "./CLIAdaptersTab";
import { SettingsTabErrorBoundary } from "./SettingsTabErrorBoundary";
import { GeneralTab } from "./GeneralTab";
import { WorkflowTeamsTab } from "./WorkflowTeamsTab";

type SettingsTab = "general" | "cli" | "workflowTeams" | "about";

const TABS: { key: SettingsTab; labelKey: string }[] = [
  { key: "general", labelKey: "settings.tabs.general" },
  { key: "cli", labelKey: "settings.tabs.cli" },
  { key: "workflowTeams", labelKey: "settings.tabs.workflowTeams" },
  { key: "about", labelKey: "settings.tabs.about" }
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>{t("common.settings")}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                className={`settings-nav-item${activeTab === tab.key ? " active" : ""}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </nav>
          <div className="settings-panel">
            {activeTab === "general" && <GeneralTab />}
            {activeTab === "cli" && (
              <SettingsTabErrorBoundary>
                <CLIAdaptersTab />
              </SettingsTabErrorBoundary>
            )}
            {activeTab === "workflowTeams" && <WorkflowTeamsTab />}
            {activeTab === "about" && <AboutTab />}
          </div>
        </div>
      </div>
    </div>
  );
}