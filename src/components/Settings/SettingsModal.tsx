import { useEffect, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  ChartColumn,
  Cog,
  Cpu,
  Info,
  Layers,
  Newspaper,
  Puzzle,
  Share2,
} from "lucide-react";
import { AboutTab } from "./AboutTab";
import { CLIAdaptersTab } from "./CLIAdaptersTab";
import { ProvidersTab } from "./ProvidersTab";
import { SettingsTabErrorBoundary } from "./SettingsTabErrorBoundary";
import { GeneralTab } from "./GeneralTab";
import { InfoCardsTab } from "./InfoCardsTab";
import { SkillsTab } from "./SkillsTab";
import { PluginsTab } from "./PluginsTab";
import { RemoteTab } from "./RemoteTab";
import { UsageTab } from "./UsageTab";

export type SettingsTab = "general" | "cli" | "providers" | "skills" | "plugins" | "feed" | "usage" | "remote" | "about";

export const SETTINGS_TABS: { key: SettingsTab; labelKey: string }[] = [
  { key: "cli", labelKey: "settings.tabs.cli" },
  { key: "providers", labelKey: "settings.tabs.providers" },
  { key: "skills", labelKey: "settings.tabs.skills" },
  { key: "plugins", labelKey: "settings.tabs.plugins" },
  { key: "feed", labelKey: "settings.tabs.feed" },
  { key: "usage", labelKey: "settings.tabs.usage" },
  { key: "general", labelKey: "settings.tabs.general" },
  { key: "remote", labelKey: "settings.tabs.remote" },
  { key: "about", labelKey: "settings.tabs.about" }
];

/** Per-tab icon so the sidebar is scannable at a glance. */
const TAB_ICONS: Record<SettingsTab, ComponentType<{ size?: number | string }>> = {
  general: Cog,
  cli: Bot,
  providers: Cpu,
  skills: Layers,
  plugins: Puzzle,
  feed: Newspaper,
  usage: ChartColumn,
  remote: Share2,
  about: Info,
};

/** Grouped sidebar sections; every tab key above appears exactly once. */
const TAB_GROUPS: { groupKey: string; items: SettingsTab[] }[] = [
  { groupKey: "settings.navGroup.ai", items: ["cli", "providers", "skills", "plugins"] },
  { groupKey: "settings.navGroup.data", items: ["feed", "usage"] },
  { groupKey: "settings.navGroup.system", items: ["general", "remote", "about"] },
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
  const labelByKey = new Map(SETTINGS_TABS.map((tab) => [tab.key, tab.labelKey]));
  return (
    <nav className={`settings-nav${className ? ` ${className}` : ""}`}>
      {TAB_GROUPS.map((group) => (
        <div key={group.groupKey} className="settings-nav-group">
          <div className="settings-nav-group-title">{t(group.groupKey)}</div>
          {group.items.map((key) => {
            const Icon = TAB_ICONS[key];
            return (
              <button
                key={key}
                type="button"
                className={`settings-nav-item${activeTab === key ? " active" : ""}`}
                onClick={() => onTabChange(key)}
              >
                <Icon size={14} />
                <span className="settings-nav-label">{t(labelByKey.get(key)!)}</span>
              </button>
            );
          })}
        </div>
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
      {activeTab === "providers" && (
        <SettingsTabErrorBoundary>
          <ProvidersTab />
        </SettingsTabErrorBoundary>
      )}
      {activeTab === "skills" && <SkillsTab />}
      {activeTab === "plugins" && <PluginsTab />}
      {activeTab === "feed" && <InfoCardsTab />}
      {activeTab === "usage" && (
        <SettingsTabErrorBoundary>
          <UsageTab />
        </SettingsTabErrorBoundary>
      )}
      {activeTab === "remote" && <RemoteTab />}
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
