import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  Download,
  LoaderCircle,
  RefreshCw,
  Search,
  Star
} from "lucide-react";
import { useTranslation } from "react-i18next";

import type { MarketSkill } from "@/services/skills/types";
import { useSkillMarketStore } from "@/store/skillMarketStore";
import { useSkillStore } from "@/store/skillStore";

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s-_]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase() || "SK";
}

function rowKey(skill: MarketSkill): string {
  return `${skill.provider}:${skill.marketSkillId}`;
}

function isNewerVersion(remote: string, local?: string | null): boolean {
  if (!local) return false;
  if (!remote || remote === "latest") return false;
  if (remote === local) return false;
  const parse = (value: string) =>
    value.replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(remote);
  const b = parse(local);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

export function SkillMarketPanel() {
  const { t } = useTranslation();
  const skills = useSkillStore((state) => state.skills);
  const {
    provider,
    providers,
    query,
    items,
    nextCursor,
    loading,
    loadingMore,
    error,
    rowStatus,
    rowErrors,
    init,
    setProvider,
    search,
    loadMore,
    install,
    openHomepage
  } = useSkillMarketStore();
  const [draftQuery, setDraftQuery] = useState(query);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    setDraftQuery(query);
  }, [query]);

  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      if (draftQuery === query) return;
      void search({ query: draftQuery });
    }, 350);
    return () => window.clearTimeout(debounceRef.current);
  }, [draftQuery, query, search]);

  const installedByMarketId = useMemo(() => {
    const map = new Map<string, (typeof skills)[number]>();
    for (const skill of skills) {
      if (skill.source !== "market" || !skill.marketProvider || !skill.marketSkillId) continue;
      map.set(`${skill.marketProvider}:${skill.marketSkillId}`, skill);
    }
    return map;
  }, [skills]);

  const onInstall = async (skill: MarketSkill) => {
    // Confirm only when the install pipeline reports MARKET_CONFIRMATION_REQUIRED.
    // Suspicious/unsigned and local-drift prompts may both appear in sequence.
    let allowSuspicious = false;
    let allowLocalOverwrite = false;
    for (;;) {
      const result = await install(skill, { allowSuspicious, allowLocalOverwrite });
      if (!result) return;
      if (!("needsConfirmation" in result)) return;
      const confirmed = window.confirm(
        result.reason === "unsigned"
          ? t("skills.market.unsignedConfirm", { name: skill.name })
          : result.reason === "local-drift"
            ? t("skills.market.localDriftConfirm", { name: skill.name })
            : t("skills.market.suspiciousConfirm", { name: skill.name })
      );
      if (!confirmed) return;
      if (result.reason === "local-drift") allowLocalOverwrite = true;
      else allowSuspicious = true;
    }
  };

  return (
    <div className="skill-market-panel">
      <div className="skills-heading">
        <div>
          <h3>{t("skills.market.title")}</h3>
          <p className="muted">{t("skills.market.description")}</p>
        </div>
      </div>

      <div className="skills-toolbar skill-market-toolbar">
        <label className="skills-filter skill-market-provider">
          <span className="sr-only">{t("skills.market.providerLabel")}</span>
          <select
            value={provider}
            onChange={(event) =>
              void setProvider(event.currentTarget.value as typeof provider)
            }
          >
            {(providers.length ? providers : [{ id: provider, label: provider }]).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </label>
        <label className="skills-search">
          <Search size={16} />
          <input
            aria-label={t("skills.market.search")}
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.currentTarget.value)}
            placeholder={t("skills.market.search")}
          />
        </label>
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="skill-market-list" role="list" aria-label={t("skills.market.listLabel")}>
        {loading && !items.length ? (
          <p className="skills-list-note muted">{t("skills.market.loading")}</p>
        ) : null}
        {!loading && !items.length ? (
          <p className="skills-list-note muted">{t("skills.market.noResults")}</p>
        ) : null}
        {items.map((skill) => {
          const key = rowKey(skill);
          const ownerQualifiedId =
            skill.ownerHandle && skill.slug
              ? `${skill.provider}:${skill.ownerHandle}/${skill.slug}`
              : "";
          // Exact provider + owner + slug only. Owner-less list cards match after
          // the clicked row is backfilled with the resolved marketSkillId.
          const installed =
            installedByMarketId.get(key) ||
            (ownerQualifiedId ? installedByMarketId.get(ownerQualifiedId) : undefined);
          const sameMarket =
            installed?.source === "market" &&
            installed.marketProvider === skill.provider &&
            (installed.marketSkillId === skill.marketSkillId ||
              (Boolean(skill.ownerHandle) &&
                installed.marketSkillId === `${skill.ownerHandle}/${skill.slug}`));
          const updateAvailable =
            sameMarket &&
            (isNewerVersion(skill.version, installed?.marketVersion || installed?.version) ||
              !skill.version ||
              skill.version === "latest");
          const status = rowStatus[key] ?? "idle";
          const busy = status === "installing";
          // Keep a refresh action for installed market skills so null/"latest"
          // remote versions cannot hide the reinstall/update entry from the mock.
          const showRefresh = sameMarket;
          const canOpenHomepage =
            Boolean(skill.homepageUrl) ||
            skill.provider === "skillhub.cn" ||
            skill.provider === "clawhub.ai";

          return (
            <article className="skill-market-card" key={key} role="listitem">
              <div className="skill-market-icon" aria-hidden="true">
                {initials(skill.name)}
              </div>
              <div className="skill-market-body">
                <div className="skill-market-title-row">
                  <strong>{skill.name}</strong>
                  {sameMarket ? (
                    <span className="skill-market-installed">{t("skills.market.installed")}</span>
                  ) : null}
                  {sameMarket && installed && !installed.trusted ? (
                    <span className="skill-untrusted-badge">{t("skills.untrusted")}</span>
                  ) : null}
                </div>
                <p>{skill.description || t("skills.market.noDescription")}</p>
                <div className="skill-market-meta">
                  <span>{t("skills.market.installs", { count: formatCount(skill.downloads) })}</span>
                  <span><Star size={12} /> {formatCount(skill.stars)}</span>
                  <span>{skill.author}</span>
                  {canOpenHomepage ? (
                    <button
                      type="button"
                      className="skill-market-link"
                      aria-label={t("skills.market.openHomepage")}
                      onClick={() => void openHomepage(skill)}
                    >
                      <ArrowUpRight size={14} />
                    </button>
                  ) : null}
                </div>
                {rowErrors[key] ? <p className="error-text">{rowErrors[key]}</p> : null}
              </div>
              <div className="skill-market-actions">
                <button
                  type="button"
                  className="icon-btn"
                  disabled={busy}
                  aria-label={
                    showRefresh
                      ? t("skills.market.updateAria", { name: skill.name })
                      : t("skills.market.installAria", { name: skill.name })
                  }
                  title={
                    showRefresh && !updateAvailable
                      ? t("skills.market.reinstallHint")
                      : undefined
                  }
                  onClick={() => void onInstall(skill)}
                >
                  {busy ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : showRefresh ? (
                    <RefreshCw size={16} />
                  ) : (
                    <Download size={16} />
                  )}
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {nextCursor ? (
        <div className="skill-market-footer">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? t("skills.market.loadingMore") : t("skills.market.loadMore")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
