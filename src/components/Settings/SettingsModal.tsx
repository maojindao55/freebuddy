import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AboutTab } from "./AboutTab";
import { CLIAdaptersTab } from "./CLIAdaptersTab";
import { SettingsTabErrorBoundary } from "./SettingsTabErrorBoundary";
import { GeneralTab } from "./GeneralTab";
import { InfoCardsTab } from "./InfoCardsTab";
import { SkillsTab } from "./SkillsTab";

export type SettingsTab = "general" | "cli" | "skills" | "feed" | "about";

export const SETTINGS_TABS: { key: SettingsTab; labelKey: string }[] = [
  { key: "cli", labelKey: "settings.tabs.cli" },
  { key: "skills", labelKey: "settings.tabs.skills" },
  { key: "feed", labelKey: "settings.tabs.feed" },
  { key: "general", labelKey: "settings.tabs.general" },
  { key: "about", labelKey: "settings.tabs.about" }
];

interface SettingsSurfaceProps {
  onClose: () => void;
  initialTab?: SettingsTab;
}

interface ControlledSettingsSurfaceProps extends SettingsSurfaceProps {
  activeTab?: SettingsTab;
  onTabChange?: (tab: SettingsTab) => void;
}

export function SettingsNav({
  activeTab,
  onTabChange,
  className = ""
}: {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <nav className={`settings-nav${className ? ` ${className}` : ""}`}>
      {SETTINGS_TABS.map((tab) => (
        <button
          key={tab.key}
          className={`settings-nav-item${activeTab === tab.key ? " active" : ""}`}
          onClick={() => onTabChange(tab.key)}
        >
          {t(tab.labelKey)}
        </button>
      ))}
    </nav>
  );
}

function SettingsContent({
  onClose,
  initialTab = "cli",
  activeTab: controlledActiveTab,
  onTabChange,
  surface = "modal",
  showHeader = true,
  showNav = true
}: ControlledSettingsSurfaceProps & {
  surface?: "modal" | "page";
  showHeader?: boolean;
  showNav?: boolean;
}) {
  const { t } = useTranslation();
  const [internalActiveTab, setInternalActiveTab] = useState<SettingsTab>(initialTab);
  const activeTab = controlledActiveTab ?? internalActiveTab;

  useEffect(() => {
    if (!controlledActiveTab) setInternalActiveTab(initialTab);
  }, [controlledActiveTab, initialTab]);

  const handleTabChange = (tab: SettingsTab) => {
    onTabChange?.(tab);
    if (!controlledActiveTab) setInternalActiveTab(tab);
  };

  const activeContent = (
    <>
      {activeTab === "general" && <GeneralTab />}
      {activeTab === "cli" && (
        <SettingsTabErrorBoundary>
          <CLIAdaptersTab />
        </SettingsTabErrorBoundary>
      )}
      {activeTab === "skills" && <SkillsTab />}
      {activeTab === "feed" && <InfoCardsTab />}
      {activeTab === "about" && <AboutTab />}
    </>
  );

  return (
    <div className={`settings-surface settings-surface-${surface}`}>
      {showHeader && (
        <header className="settings-surface-header">
          <div>
            <h2>{t("common.settings")}</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </header>
      )}
      <div className={`settings-layout${showNav ? "" : " settings-layout-content-only"}`}>
        {showNav && (
          <SettingsNav activeTab={activeTab} onTabChange={handleTabChange} />
        )}
        <div className={`settings-panel${showNav ? "" : " settings-panel-full"}`}>
          {activeContent}
        </div>
      </div>
    </div>
  );
}

export function SettingsPage(props: ControlledSettingsSurfaceProps) {
  return (
    <section className="settings-page-shell" aria-label="Settings">
      <SettingsContent {...props} surface="page" showHeader={false} showNav={false} />
    </section>
  );
}

export function SettingsModal(props: SettingsSurfaceProps) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <SettingsContent {...props} surface="modal" />
      </div>
    </div>
  );
}
