import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  FileArchive,
  FolderInput,
  FolderOpen,
  MoreHorizontal,
  Search,
  Trash2,
  X
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useTranslation } from "react-i18next";
import remarkGfm from "remark-gfm";

import { SkillMarketPanel } from "@/components/Settings/SkillMarketPanel";
import { skillsClient } from "@/services/skills/client";
import type { SkillImportResult } from "@/services/skills/types";
import { useSkillStore } from "@/store/skillStore";

type SkillFilter = "all" | "enabled" | "disabled";
type DetailTab = "instructions" | "metadata";
type SkillsView = "installed" | "market";

function withoutFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\s*\r?\n|$)/, "").trim();
}

function sourceLabel(source: string, t: (key: string) => string): string {
  if (source === "builtin") return t("skills.builtin");
  if (source === "market") return t("skills.marketSource");
  return t("skills.importedSource");
}

export function SkillsTab() {
  const { t } = useTranslation();
  const {
    skills,
    loading,
    error,
    load,
    importSource,
    setEnabled,
    setTrusted,
    deleteSkill
  } = useSkillStore();
  const importMenuRef = useRef<HTMLDetailsElement>(null);
  const [view, setView] = useState<SkillsView>("installed");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [detailTab, setDetailTab] = useState<DetailTab>("instructions");
  const [markdown, setMarkdown] = useState("");
  const [markdownLoading, setMarkdownLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<SkillImportResult>();
  const [importFailure, setImportFailure] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return skills.filter((skill) => {
      if (filter === "enabled" && !skill.enabled) return false;
      if (filter === "disabled" && skill.enabled) return false;
      return !needle || `${skill.name} ${skill.description}`.toLowerCase().includes(needle);
    });
  }, [filter, query, skills]);

  useEffect(() => {
    if (!filtered.length) {
      setSelectedId(undefined);
      return;
    }
    if (!selectedId || !filtered.some((skill) => skill.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  const selected = skills.find((skill) => skill.id === selectedId);

  useEffect(() => {
    let active = true;
    setMarkdown("");
    if (!selected) return () => {
      active = false;
    };
    setMarkdownLoading(true);
    void skillsClient
      .read(selected.id)
      .then((value) => {
        if (active) setMarkdown(value ?? "");
      })
      .finally(() => {
        if (active) setMarkdownLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected]);

  const runImport = async (kind: "directory" | "archive") => {
    try {
      const source =
        kind === "archive"
          ? await skillsClient.selectArchive()
          : await skillsClient.selectDirectory();
      importMenuRef.current?.removeAttribute("open");
      if (!source) return;
      setImporting(true);
      setImportFailure("");
      setImportResult(undefined);
      const result = await importSource(source);
      setImportResult(result);
      if (result.imported[0]) setSelectedId(result.imported[0].id);
    } catch (caught) {
      setImportFailure(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImporting(false);
    }
  };

  const dismissImportStatus = () => {
    setImportResult(undefined);
    setImportFailure("");
  };

  const deleteSelected = async () => {
    if (!selected || !window.confirm(t("skills.deleteConfirm", { name: selected.name }))) {
      return;
    }
    await deleteSkill(selected.id);
  };

  const importHasErrors = Boolean(importFailure || importResult?.errors.length);
  const importStatusVisible = Boolean(importFailure || importResult);
  const canDelete = selected?.source === "imported" || selected?.source === "market";

  return (
    <section className="settings-tab skills-tab">
      <div className="skills-view-tabs" role="tablist" aria-label={t("skills.viewsLabel")}>
        <button
          type="button"
          role="tab"
          className={view === "installed" ? "active" : ""}
          aria-selected={view === "installed"}
          onClick={() => setView("installed")}
        >
          {t("skills.installedView")}
        </button>
        <button
          type="button"
          role="tab"
          className={view === "market" ? "active" : ""}
          aria-selected={view === "market"}
          onClick={() => setView("market")}
        >
          {t("skills.marketView")}
        </button>
      </div>

      {view === "market" ? (
        <SkillMarketPanel />
      ) : (
        <>
          <div className="skills-heading">
            <div>
              <h3>{t("skills.title")}</h3>
              <p className="muted">{t("skills.description")}</p>
            </div>
            <details
              className={`skills-import-menu${importing ? " busy" : ""}`}
              ref={importMenuRef}
            >
              <summary className="primary skills-import" role="button" aria-haspopup="menu">
                <span>{importing ? t("skills.importing") : t("skills.importSkill")}</span>
                <ChevronDown size={14} />
              </summary>
              <div className="skills-import-popover">
                <button disabled={importing} onClick={() => void runImport("directory")}>
                  <FolderInput size={17} />
                  <span>
                    <strong>{t("skills.importFolder")}</strong>
                    <small>{t("skills.importFolderHint")}</small>
                  </span>
                </button>
                <button disabled={importing} onClick={() => void runImport("archive")}>
                  <FileArchive size={17} />
                  <span>
                    <strong>{t("skills.importZip")}</strong>
                    <small>{t("skills.importZipHint")}</small>
                  </span>
                </button>
              </div>
            </details>
          </div>

          <div className="skills-toolbar">
            <label className="skills-search">
              <Search size={16} />
              <input
                aria-label={t("skills.search")}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={t("skills.search")}
              />
            </label>
            <label className="skills-filter">
              <span className="sr-only">{t("skills.filterLabel")}</span>
              <select
                value={filter}
                onChange={(event) => setFilter(event.currentTarget.value as SkillFilter)}
              >
                <option value="all">{t("skills.filterAll")}</option>
                <option value="enabled">{t("skills.enabled")}</option>
                <option value="disabled">{t("skills.disabled")}</option>
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </label>
          </div>

          {importStatusVisible && (
            <div
              className={`skills-import-status${importHasErrors ? " warning" : " success"}`}
              role="status"
            >
              <CheckCircle2 size={16} />
              <div>
                <strong>
                  {importFailure
                    ? t("skills.importFailed")
                    : t("skills.imported", { count: importResult?.imported.length ?? 0 })}
                </strong>
                {importFailure ? <span>{importFailure}</span> : null}
                {importResult?.errors.map((entry) => (
                  <span key={`${entry.path}-${entry.message}`}>
                    {entry.path}: {entry.message}
                  </span>
                ))}
              </div>
              <button
                className="icon-btn"
                aria-label={t("common.close")}
                onClick={dismissImportStatus}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {error && <p className="error-text">{error}</p>}

          <div className="skills-manager">
            <div className="skills-list-pane">
              <div className="skills-list-head">
                <span>{t("skills.nameColumn")}</span>
                <span>{t("skills.statusColumn")}</span>
              </div>
              <div className="skill-list" role="listbox" aria-label={t("skills.listLabel")}>
                {loading && !skills.length ? (
                  <p className="skills-list-note muted">{t("skills.loading")}</p>
                ) : null}
                {!loading && !filtered.length ? (
                  <p className="skills-list-note muted">{t("skills.noResults")}</p>
                ) : null}
                {filtered.map((skill) => (
                  <div
                    className={`skill-row${skill.id === selectedId ? " selected" : ""}${
                      skill.enabled ? "" : " disabled"
                    }`}
                    key={skill.id}
                    role="option"
                    aria-selected={skill.id === selectedId}
                  >
                    <button className="skill-row-select" onClick={() => setSelectedId(skill.id)}>
                      <strong>{skill.name}</strong>
                      <span>
                        v{skill.version} · {sourceLabel(skill.source, t)}
                        {!skill.trusted ? ` · ${t("skills.untrusted")}` : ""}
                      </span>
                    </button>
                    <label
                      className="skills-switch"
                      title={skill.enabled ? t("skills.enabled") : t("skills.disabled")}
                    >
                      <input
                        type="checkbox"
                        checked={skill.enabled}
                        aria-label={t("skills.toggleAria", { name: skill.name })}
                        onChange={(event) =>
                          void setEnabled(skill.id, event.currentTarget.checked)
                        }
                      />
                      <span aria-hidden="true" />
                    </label>
                  </div>
                ))}
              </div>
              <footer>{t("skills.count", { count: filtered.length })}</footer>
            </div>

            <div className="skill-detail-pane">
              {selected ? (
                <>
                  <header className="skill-detail-header">
                    <div className="skill-detail-title">
                      <div>
                        <h4>{selected.name}</h4>
                        <span className="skill-source-badge">
                          {sourceLabel(selected.source, t)}
                        </span>
                        {!selected.trusted ? (
                          <span className="skill-untrusted-badge">{t("skills.untrusted")}</span>
                        ) : null}
                        <small>v{selected.version}</small>
                      </div>
                      <code>
                        {selected.contentHash.slice(0, 12)} · {t("skills.localSource")}
                      </code>
                    </div>
                    <div className="skill-detail-actions">
                      {!selected.trusted ? (
                        <button
                          type="button"
                          className="primary-btn"
                          onClick={() => {
                            if (
                              !window.confirm(
                                t("skills.trustConfirm", { name: selected.name })
                              )
                            ) {
                              return;
                            }
                            void setTrusted(selected.id, true);
                          }}
                        >
                          {t("skills.trustAction")}
                        </button>
                      ) : null}
                      <label
                        className="skills-switch"
                        title={selected.enabled ? t("skills.enabled") : t("skills.disabled")}
                      >
                        <input
                          type="checkbox"
                          checked={selected.enabled}
                          aria-label={t("skills.toggleAria", { name: selected.name })}
                          onChange={(event) =>
                            void setEnabled(selected.id, event.currentTarget.checked)
                          }
                        />
                        <span aria-hidden="true" />
                      </label>
                      <details className="skill-actions-menu">
                        <summary
                          className="icon-btn"
                          role="button"
                          aria-haspopup="menu"
                          aria-label={t("skills.moreActions")}
                        >
                          <MoreHorizontal size={17} />
                        </summary>
                        <div>
                          <button onClick={() => void skillsClient.reveal(selected.id)}>
                            <FolderOpen size={16} /> {t("skills.reveal")}
                          </button>
                          {canDelete ? (
                            <button className="danger" onClick={() => void deleteSelected()}>
                              <Trash2 size={16} /> {t("common.delete")}
                            </button>
                          ) : null}
                        </div>
                      </details>
                    </div>
                  </header>

                  <p className="skill-detail-description">{selected.description}</p>

                  <div className="skill-detail-tabs" role="tablist">
                    <button
                      className={detailTab === "instructions" ? "active" : ""}
                      role="tab"
                      aria-selected={detailTab === "instructions"}
                      onClick={() => setDetailTab("instructions")}
                    >
                      {t("skills.instructionsTab")}
                    </button>
                    <button
                      className={detailTab === "metadata" ? "active" : ""}
                      role="tab"
                      aria-selected={detailTab === "metadata"}
                      onClick={() => setDetailTab("metadata")}
                    >
                      {t("skills.metadataTab")}
                    </button>
                  </div>

                  {detailTab === "instructions" ? (
                    <div className="skill-markdown">
                      {markdownLoading ? (
                        <p className="muted">{t("skills.loadingInstructions")}</p>
                      ) : null}
                      {!markdownLoading && markdown ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {withoutFrontmatter(markdown)}
                        </ReactMarkdown>
                      ) : null}
                      {!markdownLoading && !markdown ? (
                        <p className="muted">{t("skills.instructionsUnavailable")}</p>
                      ) : null}
                    </div>
                  ) : (
                    <dl className="skill-metadata">
                      <div>
                        <dt>{t("skills.versionLabel")}</dt>
                        <dd>v{selected.version}</dd>
                      </div>
                      <div>
                        <dt>{t("skills.sourceLabel")}</dt>
                        <dd>{sourceLabel(selected.source, t)}</dd>
                      </div>
                      {selected.marketProvider ? (
                        <div>
                          <dt>{t("skills.marketProviderLabel")}</dt>
                          <dd>{selected.marketProvider}</dd>
                        </div>
                      ) : null}
                      {selected.marketUrl ? (
                        <div>
                          <dt>{t("skills.marketUrlLabel")}</dt>
                          <dd>
                            <code>{selected.marketUrl}</code>
                          </dd>
                        </div>
                      ) : null}
                      <div>
                        <dt>{t("skills.hashLabel")}</dt>
                        <dd>
                          <code>{selected.contentHash}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>{t("skills.pathLabel")}</dt>
                        <dd>
                          <code>{selected.rootPath}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>{t("skills.updatedLabel")}</dt>
                        <dd>{new Date(selected.updatedAt).toLocaleString()}</dd>
                      </div>
                    </dl>
                  )}
                </>
              ) : (
                <div className="skill-detail-empty">
                  <Search size={20} />
                  <p>{t("skills.selectPrompt")}</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
