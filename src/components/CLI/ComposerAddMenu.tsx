import { ChevronRight, Package, Plus, Search, Sparkles, UploadCloud } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { pluginsClient } from "@/services/plugins/client";
import type {
  NativePluginAgent,
  NativePluginRecord,
  NativePluginSnapshot
} from "@/services/plugins/types";
import type { SkillRecord } from "@/services/skills/types";
import { attachmentPreviewUrl } from "@/utils/chatAttachments";

type ComposerAddPanel = "skills" | "plugins";

function PluginMenuIcon({ plugin }: { plugin: NativePluginRecord }) {
  const iconUrl = plugin.iconPath ? attachmentPreviewUrl(plugin.iconPath) : "";
  const style = plugin.brandColor
    ? ({ "--plugin-brand-color": plugin.brandColor } as CSSProperties)
    : undefined;

  return (
    <span className="composer-add-plugin-icon" style={style}>
      <Package className="composer-add-plugin-icon-fallback" aria-hidden="true" />
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      ) : null}
    </span>
  );
}

export function ComposerAddMenu({
  skills,
  selectedIds,
  pluginAgent,
  onSkillsChange,
  onSelectPlugin,
  onSelectAttachments,
  attachmentDisabled = false,
  skillsDisabled = false,
  pluginsDisabled = false
}: {
  skills: SkillRecord[];
  selectedIds: string[];
  pluginAgent?: NativePluginAgent;
  onSkillsChange: (ids: string[]) => void;
  onSelectPlugin: (plugin: NativePluginRecord) => void;
  onSelectAttachments: () => void;
  attachmentDisabled?: boolean;
  skillsDisabled?: boolean;
  pluginsDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<ComposerAddPanel>();
  const [skillQuery, setSkillQuery] = useState("");
  const [pluginQuery, setPluginQuery] = useState("");
  const [pluginSnapshot, setPluginSnapshot] = useState<NativePluginSnapshot>();
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginsError, setPluginsError] = useState("");
  const available = useMemo(
    () => skills.filter((skill) => skill.enabled && skill.trusted),
    [skills]
  );
  const filteredAvailable = useMemo(() => {
    const needle = skillQuery.trim().toLocaleLowerCase();
    return available.filter((skill) =>
      !needle || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle)
    );
  }, [available, skillQuery]);
  const installedPlugins = useMemo(
    () => (pluginSnapshot?.plugins ?? []).filter((plugin) => plugin.installed && plugin.enabled),
    [pluginSnapshot?.plugins]
  );
  const filteredPlugins = useMemo(() => {
    const needle = pluginQuery.trim().toLocaleLowerCase();
    return installedPlugins.filter((plugin) =>
      !needle || `${plugin.displayName ?? ""} ${plugin.name} ${plugin.description ?? ""}`
        .toLocaleLowerCase()
        .includes(needle)
    );
  }, [installedPlugins, pluginQuery]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedAvailableCount = available.reduce(
    (count, skill) => count + (selected.has(skill.id) ? 1 : 0),
    0
  );
  const disabled =
    attachmentDisabled && skillsDisabled && (!pluginAgent || pluginsDisabled);

  useEffect(() => {
    let cancelled = false;
    setPluginSnapshot(undefined);
    setPluginsError("");
    setPluginQuery("");
    if (!pluginAgent) {
      setPluginsLoading(false);
      return;
    }

    setPluginsLoading(true);
    void pluginsClient.list(pluginAgent)
      .then((snapshot) => {
        if (!cancelled) setPluginSnapshot(snapshot);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPluginsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setPluginsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginAgent]);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setActivePanel(undefined);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setActivePanel(undefined);
      rootRef.current?.querySelector<HTMLButtonElement>(".composer-add-trigger")?.focus();
    };

    document.addEventListener("mousedown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setActivePanel(undefined);
  }, [disabled]);

  useEffect(() => {
    if (activePanel !== "skills") setSkillQuery("");
    if (activePanel !== "plugins") setPluginQuery("");
  }, [activePanel]);

  const toggleSkill = (skillId: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(skillId);
    else next.delete(skillId);
    onSkillsChange([...next]);
  };

  return (
    <div className="composer-add-menu-root" ref={rootRef}>
      <button
        className={`composer-add-trigger${open ? " active" : ""}`}
        type="button"
        aria-label={t("chat.addTools")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("chat.addTools")}
        disabled={disabled}
        onClick={() => {
          setOpen((current) => {
            if (current) setActivePanel(undefined);
            return !current;
          });
        }}
      >
        <Plus aria-hidden="true" />
      </button>

      {open ? (
        <div className="composer-add-popover">
          <div className="composer-add-primary" role="menu" aria-label={t("chat.addMenuAria")}>
            <button
              className="composer-add-menu-item"
              type="button"
              role="menuitem"
              disabled={attachmentDisabled}
              onClick={() => {
                setOpen(false);
                setActivePanel(undefined);
                onSelectAttachments();
              }}
            >
              <UploadCloud className="composer-add-menu-icon" aria-hidden="true" />
              <span>{t("chat.addFile")}</span>
            </button>
            <button
              className={`composer-add-menu-item composer-add-skills-item${activePanel === "skills" ? " active" : ""}`}
              type="button"
              role="menuitem"
              aria-haspopup="true"
              aria-expanded={activePanel === "skills"}
              disabled={skillsDisabled}
              onMouseEnter={() => setActivePanel("skills")}
              onFocus={() => setActivePanel("skills")}
              onClick={() => setActivePanel("skills")}
            >
              <Sparkles className="composer-add-menu-icon" aria-hidden="true" />
              <span>
                {t("skills.menuSummary", {
                  selected: selectedAvailableCount,
                  total: available.length
                })}
              </span>
              <ChevronRight className="composer-add-menu-chevron" aria-hidden="true" />
            </button>
            {pluginAgent ? (
              <button
                className={`composer-add-menu-item composer-add-plugins-item${activePanel === "plugins" ? " active" : ""}`}
                type="button"
                role="menuitem"
                aria-haspopup="true"
                aria-expanded={activePanel === "plugins"}
                disabled={pluginsDisabled}
                onMouseEnter={() => setActivePanel("plugins")}
                onFocus={() => setActivePanel("plugins")}
                onClick={() => setActivePanel("plugins")}
              >
                <Package className="composer-add-menu-icon" aria-hidden="true" />
                <span>
                  {pluginsLoading
                    ? t("plugins.menuLoading")
                    : t("plugins.menuSummary", { count: installedPlugins.length })}
                </span>
                <ChevronRight className="composer-add-menu-chevron" aria-hidden="true" />
              </button>
            ) : null}
          </div>

          {activePanel === "skills" ? (
            <div
              className="composer-add-skills-panel"
              role="group"
              aria-label={t("skills.selectionAria")}
            >
              <div className="composer-add-skills-heading">
                <strong>{t("skills.activeForTask")}</strong>
                <span>{selectedAvailableCount}/{available.length}</span>
              </div>
              <label className="composer-add-skills-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  value={skillQuery}
                  onChange={(event) => setSkillQuery(event.currentTarget.value)}
                  placeholder={t("skills.search")}
                  aria-label={t("skills.search")}
                />
              </label>
              <div className="composer-add-skills-list">
                {!available.length ? <p>{t("skills.none")}</p> : null}
                {available.length && !filteredAvailable.length ? (
                  <p>{t("skills.noResults")}</p>
                ) : null}
                {filteredAvailable.map((skill) => (
                  <label key={skill.id} title={skill.description}>
                    <input
                      type="checkbox"
                      checked={selected.has(skill.id)}
                      onChange={(event) => toggleSkill(skill.id, event.currentTarget.checked)}
                    />
                    <span>{skill.name}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          {activePanel === "plugins" ? (
            <div
              className="composer-add-skills-panel composer-add-plugins-panel"
              role="group"
              aria-label={t("plugins.selectionAria")}
            >
              <div className="composer-add-skills-heading">
                <strong>{t("plugins.chooseForPrompt")}</strong>
                <span>{installedPlugins.length}</span>
              </div>
              <label className="composer-add-skills-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  value={pluginQuery}
                  onChange={(event) => setPluginQuery(event.currentTarget.value)}
                  placeholder={t("plugins.search")}
                  aria-label={t("plugins.search")}
                />
              </label>
              <div className="composer-add-skills-list composer-add-plugins-list">
                {pluginsLoading ? <p>{t("plugins.loading")}</p> : null}
                {!pluginsLoading && pluginsError ? <p>{pluginsError}</p> : null}
                {!pluginsLoading && !pluginsError && !installedPlugins.length ? (
                  <p>{t("plugins.noneInstalled")}</p>
                ) : null}
                {installedPlugins.length && !filteredPlugins.length ? (
                  <p>{t("plugins.noResults")}</p>
                ) : null}
                {filteredPlugins.map((plugin) => (
                  <button
                    className="composer-add-plugin-option"
                    key={plugin.id}
                    type="button"
                    title={plugin.description}
                    onClick={() => {
                      onSelectPlugin(plugin);
                      setOpen(false);
                      setActivePanel(undefined);
                    }}
                  >
                    <PluginMenuIcon plugin={plugin} />
                    <span className="composer-add-plugin-copy">
                      <strong>{plugin.displayName ?? plugin.name}</strong>
                      {plugin.description ? <small>{plugin.description}</small> : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
