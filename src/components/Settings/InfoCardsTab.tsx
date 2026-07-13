import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from "lucide-react";

import type {
  BrowserExtractionRecipe,
  InfoCardConfig
} from "@/services/infoCards/types";
import { useInfoCardStore } from "@/store/infoCardStore";
import { FeedTab } from "./FeedTab";

const FIELD_KEYS = {
  market: ["name", "value", "change", "status"],
  sports: ["league", "home", "away", "score", "status"]
} as const;

function recipeDraft(card: InfoCardConfig): BrowserExtractionRecipe {
  const keys = card.type === "sports" ? FIELD_KEYS.sports : FIELD_KEYS.market;
  return {
    url: card.recipe?.url ?? "",
    waitForSelector: card.recipe?.waitForSelector ?? "",
    rowSelector: card.recipe?.rowSelector ?? "",
    fields: Object.fromEntries(keys.map((key) => [key, card.recipe?.fields[key] ?? ""])),
    maxItems: card.recipe?.maxItems ?? 6
  };
}

function RecipeEditor({ card }: { card: InfoCardConfig }) {
  const { t } = useTranslation();
  const updateCard = useInfoCardStore((state) => state.updateCard);
  const [recipe, setRecipe] = useState(() => recipeDraft(card));
  const [refreshMinutes, setRefreshMinutes] = useState(card.refreshMinutes);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const keys = card.type === "sports" ? FIELD_KEYS.sports : FIELD_KEYS.market;

  useEffect(() => {
    setRecipe(recipeDraft(card));
    setRefreshMinutes(card.refreshMinutes);
  }, [card]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateCard({ id: card.id, recipe, refreshMinutes });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="info-card-recipe-editor">
      <p>{t("infoCards.agentRecipeHint")}</p>
      <label>
        <span>{t("infoCards.sourceUrl")}</span>
        <input
          value={recipe.url}
          placeholder="https://example.com"
          onChange={(event) => setRecipe({ ...recipe, url: event.currentTarget.value })}
        />
      </label>
      <div className="info-card-selector-grid">
        <label>
          <span>{t("infoCards.refreshMinutes")}</span>
          <input
            type="number"
            min={1}
            max={120}
            value={refreshMinutes}
            onChange={(event) =>
              setRefreshMinutes(Math.max(1, Math.min(120, Number(event.currentTarget.value) || 1)))
            }
          />
        </label>
        <label>
          <span>{t("infoCards.maxItems")}</span>
          <input
            type="number"
            min={1}
            max={20}
            value={recipe.maxItems ?? 6}
            onChange={(event) =>
              setRecipe({
                ...recipe,
                maxItems: Math.max(1, Math.min(20, Number(event.currentTarget.value) || 1))
              })
            }
          />
        </label>
        <label>
          <span>{t("infoCards.waitForSelector")}</span>
          <input
            value={recipe.waitForSelector ?? ""}
            placeholder=".loaded"
            onChange={(event) =>
              setRecipe({ ...recipe, waitForSelector: event.currentTarget.value })
            }
          />
        </label>
        <label>
          <span>{t("infoCards.rowSelector")}</span>
          <input
            value={recipe.rowSelector}
            placeholder=".data-row"
            onChange={(event) =>
              setRecipe({ ...recipe, rowSelector: event.currentTarget.value })
            }
          />
        </label>
        {keys.map((key) => (
          <label key={key}>
            <span>{t(`infoCards.fields.${key}`)}</span>
            <input
              value={recipe.fields[key] ?? ""}
              placeholder={`.${key}`}
              onChange={(event) =>
                setRecipe({
                  ...recipe,
                  fields: { ...recipe.fields, [key]: event.currentTarget.value }
                })
              }
            />
          </label>
        ))}
      </div>
      <button type="button" className="ghost" disabled={saving} onClick={() => void save()}>
        <Save size={14} />
        {saved ? t("infoCards.saved") : saving ? t("infoCards.saving") : t("common.save")}
      </button>
    </div>
  );
}

function CardEditor({ card, index, total }: { card: InfoCardConfig; index: number; total: number }) {
  const { t } = useTranslation();
  const cards = useInfoCardStore((state) => state.cards);
  const updateCard = useInfoCardStore((state) => state.updateCard);
  const deleteCard = useInfoCardStore((state) => state.deleteCard);
  const reorderCards = useInfoCardStore((state) => state.reorderCards);
  const [title, setTitle] = useState(card.title);

  useEffect(() => setTitle(card.title), [card.title]);

  const move = async (direction: -1 | 1) => {
    const ordered = [...cards].sort((a, b) => a.order - b.order);
    const currentIndex = ordered.findIndex((entry) => entry.id === card.id);
    const neighbor = ordered[currentIndex + direction];
    if (!neighbor) return;
    [ordered[currentIndex], ordered[currentIndex + direction]] = [neighbor, card];
    await reorderCards(ordered.map((entry) => entry.id));
  };

  return (
    <section className="info-card-editor">
      <div className="info-card-editor-header">
        <div>
          <strong>{t(`infoCards.types.${card.type}`)}</strong>
          <small>{card.type === "rss" ? t("infoCards.builtinRss") : card.id.slice(0, 8)}</small>
        </div>
        <div className="info-card-editor-actions">
          <button type="button" className="icon-btn" disabled={index === 0} onClick={() => void move(-1)}>
            <ArrowUp size={14} />
          </button>
          <button type="button" className="icon-btn" disabled={index === total - 1} onClick={() => void move(1)}>
            <ArrowDown size={14} />
          </button>
          <label className="feed-switch" title={card.enabled ? t("feed.enabled") : t("feed.disabled")}>
            <input
              type="checkbox"
              checked={card.enabled}
              onChange={(event) => void updateCard({ id: card.id, enabled: event.currentTarget.checked })}
            />
            <span aria-hidden="true" />
          </label>
          {card.type !== "rss" && (
            <button
              type="button"
              className="icon-btn danger"
              title={t("common.delete")}
              onClick={() => {
                if (window.confirm(t("infoCards.deleteConfirm", { title: card.title }))) {
                  void deleteCard(card.id);
                }
              }}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      <label className="info-card-title-field">
        <span>{t("infoCards.cardTitle")}</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          onBlur={() => {
            if (title.trim() && title.trim() !== card.title) {
              void updateCard({ id: card.id, title: title.trim() });
            }
          }}
        />
      </label>
      {card.type === "rss" ? (
        <details className="info-card-rss-settings">
          <summary>{t("infoCards.manageRssSources")}</summary>
          <FeedTab />
        </details>
      ) : (
        <RecipeEditor card={card} />
      )}
    </section>
  );
}

export function InfoCardsTab() {
  const { t } = useTranslation();
  const cards = useInfoCardStore((state) => state.cards);
  const loaded = useInfoCardStore((state) => state.loaded);
  const loading = useInfoCardStore((state) => state.loading);
  const load = useInfoCardStore((state) => state.load);
  const createCard = useInfoCardStore((state) => state.createCard);
  const [type, setType] = useState<"market" | "sports">("market");
  const ordered = useMemo(() => [...cards].sort((a, b) => a.order - b.order), [cards]);

  useEffect(() => {
    if (!loaded) void load();
  }, [load, loaded]);

  useEffect(() => {
    return window.freebuddy?.infoCards.onChanged(() => void load());
  }, [load]);

  return (
    <div className="settings-tab info-cards-settings-tab">
      <div className="settings-section-heading">
        <h3 className="settings-section-title">{t("infoCards.settingsTitle")}</h3>
        <span className="settings-section-desc">{t("infoCards.settingsDescription")}</span>
      </div>
      <section className="info-card-add-row">
        <select value={type} onChange={(event) => setType(event.currentTarget.value as "market" | "sports")}>
          <option value="market">{t("infoCards.types.market")}</option>
          <option value="sports">{t("infoCards.types.sports")}</option>
        </select>
        <button type="button" className="primary-btn" disabled={loading} onClick={() => void createCard({ type })}>
          <Plus size={15} />
          {t("infoCards.addCard")}
        </button>
      </section>
      <div className="info-card-editor-list">
        {ordered.map((card, index) => (
          <CardEditor key={card.id} card={card} index={index} total={ordered.length} />
        ))}
      </div>
    </div>
  );
}
