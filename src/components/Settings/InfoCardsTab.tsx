import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { 
  ArrowDown, 
  ArrowUp, 
  Plus, 
  Save, 
  Search, 
  Trash2, 
  X, 
  Rss, 
  TrendingUp, 
  Trophy, 
  Check, 
  Info, 
  RefreshCw, 
  Settings2,
  ChevronRight
} from "lucide-react";

import { infoCardClient } from "@/services/infoCards/client";
import type {
  InfoCardConfig,
  MarketSymbolSearchResult
} from "@/services/infoCards/types";
import { useInfoCardStore } from "@/store/infoCardStore";
import { FeedTab } from "./FeedTab";

function MarketCardEditor({ card }: { card: InfoCardConfig }) {
  const { t } = useTranslation();
  const updateCard = useInfoCardStore((state) => state.updateCard);
  const snapshot = useInfoCardStore((state) => state.snapshots[card.id]);
  const [symbols, setSymbols] = useState<string[]>(card.marketSymbols ?? []);
  const [symbolNames, setSymbolNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MarketSymbolSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [refreshMinutes, setRefreshMinutes] = useState(card.refreshMinutes);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const selectedNames = useMemo(() => {
    const names = { ...symbolNames };
    for (const row of snapshot?.items ?? []) {
      const matched = row.name?.match(/^(.*?)\s*·\s*((?:SH|SZ)\d{6})$/i);
      if (matched) names[matched[2].toLowerCase()] = matched[1].trim();
    }
    return names;
  }, [snapshot?.items, symbolNames]);

  useEffect(() => {
    setSymbols(card.marketSymbols ?? []);
    setSymbolNames({});
    setRefreshMinutes(card.refreshMinutes);
  }, [card]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setSearching(false);
      setSearchError(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError(false);
    const timer = window.setTimeout(() => {
      void infoCardClient
        .searchMarketSymbols(trimmed)
        .then((next) => {
          if (!cancelled) setResults(next);
        })
        .catch(() => {
          if (!cancelled) {
            setResults([]);
            setSearchError(true);
          }
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const addSymbol = (result: MarketSymbolSearchResult) => {
    if (symbols.length >= 10 || symbols.includes(result.symbol)) return;
    setSymbols([...symbols, result.symbol]);
    setSymbolNames((current) => ({ ...current, [result.symbol]: result.name }));
    setQuery("");
    setResults([]);
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateCard({
        id: card.id,
        marketSymbols: symbols,
        refreshMinutes
      });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="info-card-config-editor">
      <label className="market-symbol-search">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '11.5px' }}>
          <span style={{ color: 'var(--fb-text-secondary)', fontWeight: 500 }}>{t("infoCards.ashare.searchLabel")}</span>
          <span style={{ color: symbols.length >= 10 ? 'var(--fb-danger)' : 'var(--fb-brand)', fontWeight: 600 }}>
            {t("infoCards.ashare.selectedCount", { count: symbols.length })}
          </span>
        </div>
        <div className="market-symbol-search-input">
          <Search size={14} aria-hidden="true" />
          <input
            value={query}
            placeholder={t("infoCards.ashare.searchPlaceholder")}
            autoComplete="off"
            disabled={symbols.length >= 10}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        {query.trim().length >= 2 && (
          <div className="market-symbol-results" role="listbox">
            {searching ? (
              <p>{t("infoCards.ashare.searching")}</p>
            ) : searchError ? (
              <p>{t("infoCards.ashare.searchError")}</p>
            ) : results.length ? (
              results.map((result) => {
                const selected = symbols.includes(result.symbol);
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    key={result.symbol}
                    disabled={selected || symbols.length >= 10}
                    onClick={() => addSymbol(result)}
                  >
                    <span>
                      <strong>{result.name}</strong>
                      <small>
                        {result.code} · {t(`infoCards.ashare.exchanges.${result.exchange}`)}
                        {result.securityType ? ` · ${result.securityType}` : ""}
                      </small>
                    </span>
                    <span className={`add-badge ${selected ? 'added' : 'add'}`}>
                      {selected ? (
                        <>
                          <Check size={11} strokeWidth={2.5} style={{ marginRight: '2px', display: 'inline-flex', verticalAlign: 'middle' }} />
                          {t("infoCards.ashare.selected")}
                        </>
                      ) : (
                        <>
                          <Plus size={11} strokeWidth={2.5} style={{ marginRight: '2px', display: 'inline-flex', verticalAlign: 'middle' }} />
                          {t("infoCards.ashare.add")}
                        </>
                      )}
                    </span>
                  </button>
                );
              })
            ) : (
              <p>{t("infoCards.ashare.noSearchResults")}</p>
            )}
          </div>
        )}
      </label>

      {symbols.length > 0 && (
        <div className="market-symbol-chips" style={{ marginTop: '8px' }}>
          {symbols.map((symbol) => (
            <span className="market-symbol-chip" key={symbol}>
              <span>
                <strong>{selectedNames[symbol] || symbol.toUpperCase()}</strong>
                {selectedNames[symbol] && <small>{symbol.toUpperCase()}</small>}
              </span>
              <button
                type="button"
                title={t("infoCards.ashare.removeSymbol", {
                  name: selectedNames[symbol] || symbol.toUpperCase()
                })}
                aria-label={t("infoCards.ashare.removeSymbol", {
                  name: selectedNames[symbol] || symbol.toUpperCase()
                })}
                onClick={() => setSymbols(symbols.filter((entry) => entry !== symbol))}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="info-card-config-compact-row">
        <label>
          <span>{t("infoCards.refreshMinutes")}</span>
          <input
            type="number"
            min={1}
            max={720}
            value={refreshMinutes}
            onChange={(event) =>
              setRefreshMinutes(Math.max(1, Math.min(720, Number(event.currentTarget.value) || 1)))
            }
          />
        </label>

        <button 
          type="button" 
          className={`ghost ${saved ? 'saved' : ''}`} 
          disabled={saving} 
          onClick={() => void save()}
        >
          {saving ? (
            <RefreshCw size={13} className="spin" />
          ) : saved ? (
            <Check size={13} />
          ) : (
            <Save size={13} />
          )}
          {saved ? t("infoCards.saved") : saving ? t("infoCards.saving") : t("common.save")}
        </button>
      </div>

      <div className="info-card-footnote" style={{ marginTop: '10px' }}>
        <Info size={11} />
        <span>{t("infoCards.ashare.symbolHint")}</span>
      </div>
    </div>
  );
}

function SportsCardEditor({ card }: { card: InfoCardConfig }) {
  const { t } = useTranslation();
  const updateCard = useInfoCardStore((state) => state.updateCard);
  const [refreshMinutes, setRefreshMinutes] = useState(card.refreshMinutes);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setRefreshMinutes(card.refreshMinutes);
  }, [card]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateCard({ id: card.id, refreshMinutes });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="info-card-config-editor sports-card-editor">
      <div className="info-card-config-compact-row" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
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

        <button 
          type="button" 
          className={`ghost ${saved ? 'saved' : ''}`} 
          disabled={saving} 
          onClick={() => void save()}
        >
          {saving ? (
            <RefreshCw size={13} className="spin" />
          ) : saved ? (
            <Check size={13} />
          ) : (
            <Save size={13} />
          )}
          {saved ? t("infoCards.saved") : saving ? t("infoCards.saving") : t("common.save")}
        </button>
      </div>

      <div className="info-card-footnote" style={{ marginTop: '10px' }}>
        <Info size={11} />
        <span>{t("infoCards.sportsProviderHint")}</span>
      </div>
    </div>
  );
}

function CardEditor({ 
  card, 
  index, 
  total,
  isExpanded,
  onToggleExpand
}: { 
  card: InfoCardConfig; 
  index: number; 
  total: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
}) {
  const { t } = useTranslation();
  const cards = useInfoCardStore((state) => state.cards);
  const updateCard = useInfoCardStore((state) => state.updateCard);
  const deleteCard = useInfoCardStore((state) => state.deleteCard);
  const reorderCards = useInfoCardStore((state) => state.reorderCards);

  const isDefaultTitle = (val: string | undefined) => {
    const lowercase = (val || "").trim().toLowerCase();
    return (
      !lowercase ||
      lowercase === "feed" ||
      lowercase === "market indices" ||
      lowercase === "sports events" ||
      lowercase === "builtin rss" ||
      lowercase === t("infoCards.types.rss").toLowerCase() ||
      lowercase === t("infoCards.builtinRss").toLowerCase() ||
      lowercase === t("infoCards.types.market").toLowerCase() ||
      lowercase === t("infoCards.types.sports").toLowerCase()
    );
  };

  const [title, setTitle] = useState(isDefaultTitle(card.title) ? "" : card.title);

  useEffect(() => {
    setTitle(isDefaultTitle(card.title) ? "" : card.title);
  }, [card.title, card.type]);

  const move = async (direction: -1 | 1, event: React.MouseEvent) => {
    event.stopPropagation();
    const ordered = [...cards].sort((a, b) => a.order - b.order);
    const currentIndex = ordered.findIndex((entry) => entry.id === card.id);
    const neighbor = ordered[currentIndex + direction];
    if (!neighbor) return;
    [ordered[currentIndex], ordered[currentIndex + direction]] = [neighbor, card];
    await reorderCards(ordered.map((entry) => entry.id));
  };

  const handleToggleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    void updateCard({ id: card.id, enabled: event.target.checked });
  };

  const displayTitle = isDefaultTitle(card.title)
    ? t(`infoCards.types.${card.type}`)
    : card.title;

  const handleDelete = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (window.confirm(t("infoCards.deleteConfirm", { title: displayTitle }))) {
      void deleteCard(card.id);
    }
  };

  return (
    <section 
      className={`info-card-editor ${isExpanded ? 'expanded' : 'collapsed'}`} 
      id={`info-card-editor-${card.type}`}
    >
      <div className="info-card-editor-header" onClick={onToggleExpand}>
        <div className="info-card-editor-header-left">
          <ChevronRight size={15} className="info-card-editor-chevron" />
          <span className={`info-card-type-badge ${card.type}`}>
            {t(`infoCards.types.${card.type}`)}
          </span>
          <strong className="info-card-editor-display-title">
            {displayTitle}
          </strong>
          <small>{card.type === "rss" ? t("infoCards.builtinRss") : card.id.slice(0, 8)}</small>
        </div>
        <div className="info-card-editor-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="icon-btn" disabled={index === 0} onClick={(e) => void move(-1, e)}>
            <ArrowUp size={14} />
          </button>
          <button type="button" className="icon-btn" disabled={index === total - 1} onClick={(e) => void move(1, e)}>
            <ArrowDown size={14} />
          </button>
          <label className="feed-switch" title={card.enabled ? t("feed.enabled") : t("feed.disabled")}>
            <input
              type="checkbox"
              checked={card.enabled}
              onChange={handleToggleChange}
            />
            <span aria-hidden="true" />
          </label>
          {card.type !== "rss" && (
            <button
              type="button"
              className="icon-btn danger"
              title={t("common.delete")}
              onClick={handleDelete}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      {isExpanded && (
        <div className="info-card-editor-body">
          <label className="info-card-title-field" style={{ marginTop: 0 }}>
            <span>{t("infoCards.cardTitle")}</span>
            <input
              value={title}
              placeholder={t(`infoCards.types.${card.type}`)}
              onChange={(event) => setTitle(event.currentTarget.value)}
              onBlur={() => {
                const trimmed = title.trim();
                if (trimmed !== card.title && !(isDefaultTitle(card.title) && trimmed === "")) {
                  void updateCard({ id: card.id, title: trimmed });
                }
              }}
            />
          </label>
          {card.type === "rss" ? (
            <details className="info-card-rss-settings">
              <summary>{t("infoCards.manageRssSources")}</summary>
              <FeedTab />
            </details>
          ) : card.type === "market" ? (
            <MarketCardEditor card={card} />
          ) : (
            <SportsCardEditor card={card} />
          )}
        </div>
      )}
    </section>
  );
}

function GalleryCard({
  cardType,
  icon: Icon,
  themeClass,
  onConfigure,
  onCreate
}: {
  cardType: "market" | "sports";
  icon: typeof TrendingUp;
  themeClass: string;
  onConfigure: () => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  const cards = useInfoCardStore((state) => state.cards);
  const loaded = useInfoCardStore((state) => state.loaded);
  const loading = useInfoCardStore((state) => state.loading);
  const updateCard = useInfoCardStore((state) => state.updateCard);
  const card = cards.find((c) => c.type === cardType);
  const selectedTypeExists = Boolean(card);

  return (
    <div className={`info-card-template-card ${themeClass}`}>
      <div className="info-card-template-header">
        <div className="info-card-template-icon-wrapper">
          <Icon size={18} />
        </div>
        {selectedTypeExists ? (
          <span className="info-card-status-badge added">
            {t("infoCards.typeAlreadyAdded")}
          </span>
        ) : (
          <span className="info-card-status-badge not-added">
            {t("infoCards.statusNotAdded")}
          </span>
        )}
      </div>
      <div className="info-card-template-info">
        <h4>{t(`infoCards.types.${cardType}`)}</h4>
        <p>{t(`infoCards.${cardType}Description`)}</p>
      </div>
      <div className="info-card-template-footer">
        {card && (
          <>
            <label
              className="feed-switch"
              title={card.enabled ? t("feed.enabled") : t("feed.disabled")}
            >
              <input
                type="checkbox"
                checked={card.enabled}
                onChange={(event) => {
                  void updateCard({ id: card.id, enabled: event.currentTarget.checked });
                }}
              />
              <span aria-hidden="true" />
            </label>
            <button type="button" className="action-btn" onClick={onConfigure}>
              <Settings2 size={12} />
              {t("infoCards.configureAction")}
            </button>
          </>
        )}
        <button
          type="button"
          className={`action-btn ${selectedTypeExists ? "" : "primary"}`}
          disabled={!loaded || loading || selectedTypeExists}
          onClick={onCreate}
          style={selectedTypeExists ? undefined : { width: "100%", justifyContent: "center" }}
        >
          <Plus size={12} />
          {t("infoCards.addCard")}
        </button>
      </div>
    </div>
  );
}

export function InfoCardsTab() {
  const { t } = useTranslation();
  const cards = useInfoCardStore((state) => state.cards);
  const loaded = useInfoCardStore((state) => state.loaded);
  const load = useInfoCardStore((state) => state.load);
  const createCard = useInfoCardStore((state) => state.createCard);
  const updateCard = useInfoCardStore((state) => state.updateCard);

  const ordered = useMemo(() => [...cards].sort((a, b) => a.order - b.order), [cards]);

  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);

  const rssCard = useMemo(() => cards.find((c) => c.type === "rss"), [cards]);

  useEffect(() => {
    if (!loaded) void load();
  }, [load, loaded]);

  useEffect(() => {
    if (ordered.length > 0 && expandedCardId === null) {
      setExpandedCardId(ordered[0].id);
    }
  }, [ordered, expandedCardId]);

  useEffect(() => {
    return window.freebuddy?.infoCards.onChanged(() => void load());
  }, [load]);

  const scrollToEditor = (type: string) => {
    const card = cards.find((c) => c.type === type);
    if (card) {
      setExpandedCardId(card.id);
      setTimeout(() => {
        const el = document.getElementById(`info-card-editor-${type}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.style.borderColor = "var(--fb-brand)";
          setTimeout(() => {
            el.style.borderColor = "";
          }, 1000);
        }
      }, 120);
    }
  };

  const handleCreate = (type: "market" | "sports") => {
    void createCard({ type }).then((newCard) => {
      if (newCard) {
        setExpandedCardId(newCard.id);
        setTimeout(() => scrollToEditor(type), 150);
      }
    });
  };

  return (
    <div className="settings-tab info-cards-settings-tab">
      <div className="settings-section-heading">
        <h3 className="settings-section-title">{t("infoCards.settingsTitle")}</h3>
        <span className="settings-section-desc">{t("infoCards.settingsDescription")}</span>
      </div>

      <div className="info-card-gallery">
        <h4 className="info-card-gallery-title">{t("infoCards.galleryTitle")}</h4>
        
        <div className="info-card-gallery-grid">
          {/* RSS News Feed Card */}
          <div className="info-card-template-card rss-theme">
            <div className="info-card-template-header">
              <div className="info-card-template-icon-wrapper">
                <Rss size={18} />
              </div>
              <span className="info-card-status-badge builtin">
                {t("infoCards.builtinStatus")}
              </span>
            </div>
            <div className="info-card-template-info">
              <h4>{t("infoCards.types.rss")}</h4>
              <p>{t("infoCards.rssDescription")}</p>
            </div>
            <div className="info-card-template-footer">
              <label 
                className="feed-switch" 
                title={rssCard?.enabled ? t("feed.enabled") : t("feed.disabled")}
              >
                <input
                  type="checkbox"
                  checked={rssCard?.enabled ?? false}
                  disabled={!rssCard}
                  onChange={(event) => {
                    if (rssCard) {
                      void updateCard({ id: rssCard.id, enabled: event.currentTarget.checked });
                    }
                  }}
                />
                <span aria-hidden="true" />
              </label>

              <button
                type="button"
                className="action-btn"
                onClick={() => scrollToEditor("rss")}
              >
                <Settings2 size={12} />
                {t("infoCards.manageRssAction")}
              </button>
            </div>
          </div>

          {/* Market Indices Card */}
          <GalleryCard
            cardType="market"
            icon={TrendingUp}
            themeClass="market-theme"
            onConfigure={() => scrollToEditor("market")}
            onCreate={() => handleCreate("market")}
          />

          {/* Sports Matches Card */}
          <GalleryCard
            cardType="sports"
            icon={Trophy}
            themeClass="sports-theme"
            onConfigure={() => scrollToEditor("sports")}
            onCreate={() => handleCreate("sports")}
          />
        </div>
      </div>

      <div className="info-card-editor-list">
        {ordered.map((card, index) => (
          <CardEditor 
            key={card.id} 
            card={card} 
            index={index} 
            total={ordered.length} 
            isExpanded={expandedCardId === card.id}
            onToggleExpand={() => setExpandedCardId(expandedCardId === card.id ? null : card.id)}
          />
        ))}
      </div>
    </div>
  );
}
