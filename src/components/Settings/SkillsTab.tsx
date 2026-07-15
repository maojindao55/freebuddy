import { useEffect, useMemo, useState } from "react";
import { BookOpen, FolderInput, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { skillsClient } from "@/services/skills/client";
import { useSkillStore } from "@/store/skillStore";

export function SkillsTab() {
  const { t } = useTranslation();
  const { skills, loading, error, load, importDirectory, setEnabled, deleteSkill } =
    useSkillStore();
  const [query, setQuery] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [preview, setPreview] = useState<{ name: string; markdown: string }>();

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? skills.filter((skill) =>
          `${skill.name} ${skill.description}`.toLowerCase().includes(needle)
        )
      : skills;
  }, [query, skills]);

  const importFolder = async () => {
    try {
      const source = await skillsClient.selectDirectory();
      if (!source) return;
      setImportMessage("");
      const result = await importDirectory(source);
      setImportMessage(
        result.errors.length
          ? result.errors.map((entry) => `${entry.path}: ${entry.message}`).join("\n")
          : t("skills.imported", { count: result.imported.length })
      );
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="settings-tab skills-tab">
      <div className="skills-heading">
        <div>
          <h3>{t("skills.title")}</h3>
          <p className="muted">{t("skills.description")}</p>
        </div>
        <button className="primary skills-import" onClick={() => void importFolder()}>
          <FolderInput size={15} /> {t("skills.importFolder")}
        </button>
      </div>
      <label className="skills-search">
        <Search size={15} />
        <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={t("skills.search")} />
      </label>
      {importMessage && <pre className="skills-message">{importMessage}</pre>}
      {error && <p className="error-text">{error}</p>}
      <div className="skill-list">
        {loading && !skills.length ? <p className="muted">{t("skills.loading")}</p> : null}
        {filtered.map((skill) => (
          <article className={`skill-card${skill.enabled ? "" : " disabled"}`} key={skill.id}>
            <div className="skill-card-main">
              <div className="skill-card-title">
                <strong>{skill.name}</strong>
                <span>{skill.source === "builtin" ? t("skills.builtin") : t("skills.importedSource")}</span>
                <small>v{skill.version}</small>
              </div>
              <p>{skill.description}</p>
              <code>{skill.contentHash.slice(0, 12)}</code>
            </div>
            <div className="skill-card-actions">
              <button className="icon-btn" title={t("skills.view")} onClick={async () => {
                const markdown = await skillsClient.read(skill.id);
                if (markdown) setPreview({ name: skill.name, markdown });
              }}><BookOpen size={16} /></button>
              <label className="skill-toggle">
                <input type="checkbox" checked={skill.enabled} onChange={(event) => void setEnabled(skill.id, event.currentTarget.checked)} />
                <span>{skill.enabled ? t("skills.enabled") : t("skills.disabled")}</span>
              </label>
              {skill.source === "imported" && (
                <button className="icon-btn danger" title={t("common.delete")} onClick={() => {
                  if (window.confirm(t("skills.deleteConfirm", { name: skill.name }))) void deleteSkill(skill.id);
                }}><Trash2 size={16} /></button>
              )}
            </div>
          </article>
        ))}
      </div>
      {preview && (
        <div className="modal-backdrop" onClick={() => setPreview(undefined)}>
          <div className="modal skill-preview" onClick={(event) => event.stopPropagation()}>
            <header><h3>{preview.name}</h3><button className="icon-btn" onClick={() => setPreview(undefined)}>✕</button></header>
            <pre>{preview.markdown}</pre>
          </div>
        </div>
      )}
    </section>
  );
}
