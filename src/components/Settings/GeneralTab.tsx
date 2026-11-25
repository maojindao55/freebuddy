import {
  AlarmClock,
  AlertCircle,
  AppWindow,
  Check,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Gift,
  Keyboard,
  ListTodo,
  PanelLeft,
  PawPrint,
  RotateCcw,
  Sparkles,
  UsersRound
} from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_PINNED_SIDEBAR_ITEMS,
  PINNABLE_SIDEBAR_NAV_ITEMS,
  isDefaultPinnedSidebarItems,
  type PinnableSidebarNavId
} from "@/config/sidebarNavigation";
import { cliClient } from "@/services/cli/client";
import type {
  ConversationDigestConfig,
  ConversationDigestConfigState
} from "@/services/cli/types";
import { useProviderStore } from "@/store/providerStore";
import { useSettingsStore } from "@/store/settingsStore";
import {
  SUPPORTED_LANGUAGE_PREFERENCES,
  type LanguagePreference
} from "@/utils/detectLocale";
import {
  SUPPORTED_THEME_PREFERENCES,
  type ThemePreference
} from "@/utils/detectTheme";

const SIDEBAR_SHORTCUT_ICON: Record<
  PinnableSidebarNavId,
  ComponentType<{ size?: number | string; strokeWidth?: number }>
> = {
  todos: ListTodo,
  scheduledTasks: AlarmClock,
  workflowTeams: UsersRound,
  freebie: Gift
};

const LANGUAGE_LABEL_KEY: Record<LanguagePreference, string> = {
  system: "general.languageSystem",
  en: "general.languageEn",
  "zh-CN": "general.languageZhCN"
};

const THEME_LABEL_KEY: Record<ThemePreference, string> = {
  system: "general.themeSystem",
  light: "general.themeLight",
  dark: "general.themeDark"
};

const DEFAULT_BUTLER_SHORTCUT = "CommandOrControl+Shift+Space";
const DEFAULT_BUTLER_MAIN_WINDOW_SHORTCUT = "CommandOrControl+Shift+M";
const petImageUrl = `${import.meta.env.BASE_URL}butlerbuddy-pet.png`;

function shortcutFromEvent(event: KeyboardEvent): string | undefined {
  if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return;

  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push("CommandOrControl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");

  const keyMap: Record<string, string> = {
    " ": "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown"
  };
  const key =
    keyMap[event.key] ??
    (/^F(?:[1-9]|1\d|2[0-4])$/.test(event.key)
      ? event.key
      : event.key.length === 1
        ? event.key.toUpperCase()
        : undefined);
  return key ? [...modifiers, key].join("+") : undefined;
}

function shortcutTokens(shortcut: string): string[] {
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  return shortcut.split("+").map((token) => {
    if (token === "CommandOrControl") return isMac ? "⌘" : "Ctrl";
    if (token === "Shift") return "⇧";
    if (token === "Alt") return isMac ? "⌥" : "Alt";
    if (token === "Space") return "Space";
    return token;
  });
}

type ShortcutRecordingTarget = "chat" | "mainWindow" | null;

export function GeneralTab() {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const telemetryEnabled = useSettingsStore((s) => s.telemetryEnabled);
  const setTelemetryEnabled = useSettingsStore((s) => s.setTelemetryEnabled);
  const sidebarPinnedItems = useSettingsStore((s) => s.sidebarPinnedItems);
  const setSidebarPinnedItems = useSettingsStore((s) => s.setSidebarPinnedItems);
  const setSidebarNavPinned = useSettingsStore((s) => s.setSidebarNavPinned);
  const moveSidebarNavPinned = useSettingsStore((s) => s.moveSidebarNavPinned);
  const butlerVisible = useSettingsStore((s) => s.butlerBuddyVisible);
  const shortcutEnabled = useSettingsStore((s) => s.butlerBuddyShortcutEnabled);
  const shortcut = useSettingsStore((s) => s.butlerBuddyShortcut);
  const shortcutRegistered = useSettingsStore(
    (s) => s.butlerBuddyShortcutRegistered
  );
  const shortcutError = useSettingsStore((s) => s.butlerBuddyShortcutError);
  const mainWindowShortcutEnabled = useSettingsStore(
    (s) => s.butlerBuddyMainWindowShortcutEnabled
  );
  const mainWindowShortcut = useSettingsStore(
    (s) => s.butlerBuddyMainWindowShortcut
  );
  const mainWindowShortcutRegistered = useSettingsStore(
    (s) => s.butlerBuddyMainWindowShortcutRegistered
  );
  const mainWindowShortcutError = useSettingsStore(
    (s) => s.butlerBuddyMainWindowShortcutError
  );
  const updateButler = useSettingsStore(
    (s) => s.updateButlerBuddyPreferences
  );
  const [recordingTarget, setRecordingTarget] =
    useState<ShortcutRecordingTarget>(null);
  const [captureError, setCaptureError] = useState("");
  const providers = useProviderStore((s) => s.providers);
  const [digestState, setDigestState] =
    useState<ConversationDigestConfigState | null>(null);

  useEffect(() => {
    if (!cliClient.isAvailable()) return;
    void useProviderStore.getState().load();
    void cliClient
      .getConversationDigestConfig()
      .then((state) => {
        if (state) setDigestState(state);
      })
      .catch(() => {
        // Ignore digest settings probe error when unavailable.
      });
  }, []);

  const updateDigestConfig = async (
    patch: Partial<ConversationDigestConfig>
  ) => {
    if (!cliClient.isAvailable()) return;
    try {
      const next = await cliClient.setConversationDigestConfig(patch);
      if (next) setDigestState(next);
    } catch {
      // Ignore host-only setting update errors in restricted sessions.
    }
  };

  const digestProviders = providers.filter((p) => p.enabled && p.hasKey);
  const selectedDigestProvider = digestState?.config.providerId
    ? digestProviders.find((p) => p.id === digestState.config.providerId)
    : digestProviders.find(
        (p) => p.id === digestState?.availability.resolvedProviderId
      );
  const selectedDigestModels = (selectedDigestProvider?.models ?? []).filter(
    (m) => m.enabled !== false
  );

  useEffect(() => {
    if (!recordingTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (event.key === "Escape") {
        setRecordingTarget(null);
        setCaptureError("");
        return;
      }
      const next = shortcutFromEvent(event);
      if (!next) {
        if (!["Control", "Meta", "Alt", "Shift"].includes(event.key)) {
          setCaptureError(
            recordingTarget === "mainWindow"
              ? t("general.butlerMainWindowShortcutInvalid")
              : t("general.butlerShortcutInvalid")
          );
        }
        return;
      }
      setCaptureError("");
      const target = recordingTarget;
      setRecordingTarget(null);
      if (target === "mainWindow") {
        void updateButler({
          mainWindowShortcut: next,
          mainWindowShortcutEnabled: true
        });
      } else {
        void updateButler({ shortcut: next, shortcutEnabled: true });
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recordingTarget, t, updateButler]);

  const shownShortcutError =
    (recordingTarget === "chat" ? captureError : "") ||
    (shortcutError ? t("general.butlerShortcutUnavailable") : "");

  const shownMainWindowShortcutError =
    (recordingTarget === "mainWindow" ? captureError : "") ||
    (mainWindowShortcutError
      ? t("general.butlerMainWindowShortcutUnavailable")
      : "");

  const shortcutById = new Map(
    PINNABLE_SIDEBAR_NAV_ITEMS.map((item) => [item.id, item])
  );
  const isDefaultPinned = isDefaultPinnedSidebarItems(sidebarPinnedItems);

  return (
    <div className="settings-tab-scroll">
      <section
        id="sidebar-shortcuts-settings"
        className="settings-section butler-settings-section sidebar-shortcuts-section"
      >
        <div className="butler-settings-heading">
          <span className="butler-settings-heading-icon" aria-hidden="true">
            <PanelLeft size={17} strokeWidth={1.9} />
          </span>
          <div>
            <h3>{t("general.sidebarShortcutsTitle")}</h3>
            <p>{t("general.sidebarShortcutsDescription")}</p>
          </div>
        </div>

        <div className="butler-settings-card sidebar-shortcuts-card">
          {PINNABLE_SIDEBAR_NAV_ITEMS.map((item, index) => {
            const Icon = SIDEBAR_SHORTCUT_ICON[item.id];
            const pinned = sidebarPinnedItems.includes(item.id);
            return (
              <div key={item.id}>
                {index > 0 && <div className="butler-settings-divider" />}
                <div className="butler-settings-row sidebar-shortcuts-row">
                  <span className="butler-settings-row-icon" aria-hidden="true">
                    <Icon size={18} strokeWidth={1.8} />
                  </span>
                  <div className="butler-settings-copy">
                    <strong>{t(item.sidebarLabelKey)}</strong>
                    <small>{t(item.descriptionKey)}</small>
                  </div>
                  <label className="butler-settings-switch">
                    <input
                      type="checkbox"
                      checked={pinned}
                      onChange={(event) =>
                        void setSidebarNavPinned(item.id, event.target.checked)
                      }
                      aria-label={t(item.sidebarLabelKey)}
                    />
                    <span aria-hidden="true" />
                  </label>
                </div>
              </div>
            );
          })}

          {(sidebarPinnedItems.length > 1 || !isDefaultPinned) && (
            <>
              <div className="butler-settings-divider" />
              <div className="sidebar-shortcuts-footer">
                {sidebarPinnedItems.length > 1 ? (
                  <div className="sidebar-shortcuts-order">
                    <span className="sidebar-shortcuts-order-label">
                      {t("general.sidebarOrderLabel")}
                    </span>
                    <div className="sidebar-shortcuts-order-list">
                      {sidebarPinnedItems.map((id, index) => {
                        const def = shortcutById.get(id);
                        if (!def) return null;
                        const Icon = SIDEBAR_SHORTCUT_ICON[id];
                        return (
                          <div key={id} className="sidebar-shortcuts-order-item">
                            <span className="sidebar-shortcuts-order-name">
                              <Icon size={14} strokeWidth={1.8} />
                              <span>{t(def.sidebarLabelKey)}</span>
                            </span>
                            <span className="sidebar-shortcuts-order-actions">
                              <button
                                type="button"
                                className="sidebar-shortcuts-move-btn"
                                disabled={index === 0}
                                onClick={() => void moveSidebarNavPinned(id, "up")}
                                title={t("general.sidebarMoveUp")}
                                aria-label={t("general.sidebarMoveUp")}
                              >
                                <ChevronUp size={13} strokeWidth={2} />
                              </button>
                              <button
                                type="button"
                                className="sidebar-shortcuts-move-btn"
                                disabled={index === sidebarPinnedItems.length - 1}
                                onClick={() => void moveSidebarNavPinned(id, "down")}
                                title={t("general.sidebarMoveDown")}
                                aria-label={t("general.sidebarMoveDown")}
                              >
                                <ChevronDown size={13} strokeWidth={2} />
                              </button>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                {!isDefaultPinned && (
                  <div className="sidebar-shortcuts-reset-row">
                    <button
                      type="button"
                      className="sidebar-shortcuts-reset-btn"
                      onClick={() =>
                        void setSidebarPinnedItems(DEFAULT_PINNED_SIDEBAR_ITEMS)
                      }
                    >
                      <RotateCcw size={13} strokeWidth={1.9} />
                      <span>{t("general.sidebarResetDefault")}</span>
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </section>

      <section className="settings-section butler-settings-section">
        <div className="butler-settings-heading">
          <span className="butler-settings-heading-icon" aria-hidden="true">
            <PawPrint size={17} strokeWidth={1.9} />
          </span>
          <div>
            <h3>{t("general.butlerTitle")}</h3>
            <p>{t("general.butlerDescription")}</p>
          </div>
        </div>

        <div className="butler-settings-card">
          <div className="butler-settings-row">
            <div className="butler-settings-pet-preview" aria-hidden="true">
              <img src={petImageUrl} alt="" />
              <span />
            </div>
            <div className="butler-settings-copy">
              <strong>{t("general.butlerShowPet")}</strong>
              <small>{t("general.butlerShowPetDescription")}</small>
            </div>
            <label className="butler-settings-switch">
              <input
                type="checkbox"
                checked={butlerVisible}
                onChange={(event) =>
                  void updateButler({ visible: event.target.checked })
                }
                aria-label={t("general.butlerShowPet")}
              />
              <span aria-hidden="true" />
            </label>
          </div>

          <div className="butler-settings-divider" />

          <div className="butler-settings-row">
            <span className="butler-settings-row-icon" aria-hidden="true">
              <Crosshair size={18} strokeWidth={1.8} />
            </span>
            <div className="butler-settings-copy">
              <strong>{t("general.butlerScreenBall")}</strong>
              <small>{t("general.butlerScreenBallDescription")}</small>
            </div>
            <button
              type="button"
              className="butler-settings-game-button"
              disabled={!butlerVisible}
              onClick={() => window.freebuddy?.butlerBuddy?.startScreenBall()}
            >
              {t("general.butlerScreenBallStart")}
            </button>
          </div>

          <div className="butler-settings-divider" />

          <div className="butler-settings-row butler-settings-shortcut-row">
            <span className="butler-settings-row-icon" aria-hidden="true">
              <Keyboard size={18} strokeWidth={1.8} />
            </span>
            <div className="butler-settings-copy">
              <strong>{t("general.butlerShortcut")}</strong>
              <small>{t("general.butlerShortcutDescription")}</small>
            </div>
            <label className="butler-settings-switch">
              <input
                type="checkbox"
                checked={shortcutEnabled}
                onChange={(event) => {
                  setRecordingTarget(null);
                  setCaptureError("");
                  void updateButler({ shortcutEnabled: event.target.checked });
                }}
                aria-label={t("general.butlerShortcut")}
              />
              <span aria-hidden="true" />
            </label>
          </div>

          {shortcutEnabled && (
            <div className="butler-shortcut-editor">
              <button
                type="button"
                className={`butler-shortcut-recorder${recordingTarget === "chat" ? " is-recording" : ""}`}
                aria-pressed={recordingTarget === "chat"}
                onClick={() => {
                  setCaptureError("");
                  setRecordingTarget((target) =>
                    target === "chat" ? null : "chat"
                  );
                }}
              >
                <span className="butler-shortcut-recorder-label">
                  {recordingTarget === "chat"
                    ? t("general.butlerShortcutRecording")
                    : t("general.butlerShortcutCurrent")}
                </span>
                <span className="butler-shortcut-keys" aria-label={shortcut}>
                  {recordingTarget === "chat" ? (
                    <kbd>…</kbd>
                  ) : (
                    shortcutTokens(shortcut).map((token, index) => (
                      <kbd key={`${token}-${index}`}>{token}</kbd>
                    ))
                  )}
                </span>
                <span className="butler-shortcut-action">
                  {recordingTarget === "chat"
                    ? t("general.butlerShortcutCancelHint")
                    : t("general.butlerShortcutChange")}
                </span>
              </button>
              <button
                type="button"
                className="butler-shortcut-reset"
                onClick={() => {
                  setRecordingTarget(null);
                  setCaptureError("");
                  void updateButler({ shortcut: DEFAULT_BUTLER_SHORTCUT });
                }}
                disabled={shortcut === DEFAULT_BUTLER_SHORTCUT}
                title={t("general.butlerShortcutReset")}
                aria-label={t("general.butlerShortcutReset")}
              >
                <RotateCcw size={14} strokeWidth={1.9} />
              </button>
            </div>
          )}

          {shortcutEnabled && shownShortcutError ? (
            <div className="butler-shortcut-status is-error" role="alert">
              <AlertCircle size={13} />
              <span>{shownShortcutError}</span>
            </div>
          ) : shortcutEnabled && shortcutRegistered ? (
            <div className="butler-shortcut-status is-success">
              <Check size={13} />
              <span>{t("general.butlerShortcutReady")}</span>
            </div>
          ) : null}

          <div className="butler-settings-divider" />

          <div className="butler-settings-row butler-settings-shortcut-row">
            <span className="butler-settings-row-icon" aria-hidden="true">
              <AppWindow size={18} strokeWidth={1.8} />
            </span>
            <div className="butler-settings-copy">
              <strong>{t("general.butlerMainWindowShortcut")}</strong>
              <small>{t("general.butlerMainWindowShortcutDescription")}</small>
            </div>
            <label className="butler-settings-switch">
              <input
                type="checkbox"
                checked={mainWindowShortcutEnabled}
                onChange={(event) => {
                  setRecordingTarget(null);
                  setCaptureError("");
                  void updateButler({
                    mainWindowShortcutEnabled: event.target.checked
                  });
                }}
                aria-label={t("general.butlerMainWindowShortcut")}
              />
              <span aria-hidden="true" />
            </label>
          </div>

          {mainWindowShortcutEnabled && (
            <div className="butler-shortcut-editor">
              <button
                type="button"
                className={`butler-shortcut-recorder${recordingTarget === "mainWindow" ? " is-recording" : ""}`}
                aria-pressed={recordingTarget === "mainWindow"}
                onClick={() => {
                  setCaptureError("");
                  setRecordingTarget((target) =>
                    target === "mainWindow" ? null : "mainWindow"
                  );
                }}
              >
                <span className="butler-shortcut-recorder-label">
                  {recordingTarget === "mainWindow"
                    ? t("general.butlerMainWindowShortcutRecording")
                    : t("general.butlerMainWindowShortcutCurrent")}
                </span>
                <span
                  className="butler-shortcut-keys"
                  aria-label={mainWindowShortcut}
                >
                  {recordingTarget === "mainWindow" ? (
                    <kbd>…</kbd>
                  ) : (
                    shortcutTokens(mainWindowShortcut).map((token, index) => (
                      <kbd key={`${token}-${index}`}>{token}</kbd>
                    ))
                  )}
                </span>
                <span className="butler-shortcut-action">
                  {recordingTarget === "mainWindow"
                    ? t("general.butlerMainWindowShortcutCancelHint")
                    : t("general.butlerMainWindowShortcutChange")}
                </span>
              </button>
              <button
                type="button"
                className="butler-shortcut-reset"
                onClick={() => {
                  setRecordingTarget(null);
                  setCaptureError("");
                  void updateButler({
                    mainWindowShortcut: DEFAULT_BUTLER_MAIN_WINDOW_SHORTCUT
                  });
                }}
                disabled={
                  mainWindowShortcut === DEFAULT_BUTLER_MAIN_WINDOW_SHORTCUT
                }
                title={t("general.butlerMainWindowShortcutReset")}
                aria-label={t("general.butlerMainWindowShortcutReset")}
              >
                <RotateCcw size={14} strokeWidth={1.9} />
              </button>
            </div>
          )}

          {mainWindowShortcutEnabled && shownMainWindowShortcutError ? (
            <div className="butler-shortcut-status is-error" role="alert">
              <AlertCircle size={13} />
              <span>{shownMainWindowShortcutError}</span>
            </div>
          ) : mainWindowShortcutEnabled && mainWindowShortcutRegistered ? (
            <div className="butler-shortcut-status is-success">
              <Check size={13} />
              <span>{t("general.butlerMainWindowShortcutReady")}</span>
            </div>
          ) : null}

          {digestState && (
            <>
              <div className="butler-settings-divider" />

              <div className="butler-settings-row">
                <span className="butler-settings-row-icon" aria-hidden="true">
                  <Sparkles size={18} strokeWidth={1.8} />
                </span>
                <div className="butler-settings-copy">
                  <strong>{t("general.butlerDigestTitle")}</strong>
                  <small>{t("general.butlerDigestDescription")}</small>
                </div>
                <label className="butler-settings-switch">
                  <input
                    type="checkbox"
                    checked={digestState.config.enabled}
                    onChange={(event) =>
                      void updateDigestConfig({ enabled: event.target.checked })
                    }
                    aria-label={t("general.butlerDigestTitle")}
                  />
                  <span aria-hidden="true" />
                </label>
              </div>

              <div className="butler-digest-controls">
                <label className="butler-digest-field">
                  <span>{t("general.butlerDigestProviderLabel")}</span>
                  <select
                    value={digestState.config.providerId}
                    onChange={(event) =>
                      void updateDigestConfig({
                        providerId: event.target.value,
                        model: ""
                      })
                    }
                  >
                    <option value="">{t("general.butlerDigestProviderAuto")}</option>
                    {digestProviders.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="butler-digest-field">
                  <span>{t("general.butlerDigestModelLabel")}</span>
                  {selectedDigestModels.length > 0 ? (
                    <select
                      value={digestState.config.model}
                      onChange={(event) =>
                        void updateDigestConfig({ model: event.target.value })
                      }
                    >
                      <option value="">{t("general.butlerDigestModelAuto")}</option>
                      {selectedDigestModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name ? `${model.name} (${model.id})` : model.id}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={digestState.config.model}
                      placeholder={t("general.butlerDigestModelAuto")}
                      onChange={(event) =>
                        void updateDigestConfig({ model: event.target.value })
                      }
                    />
                  )}
                </label>

                <p
                  className={`butler-digest-status ${digestState.availability.hasAvailableProvider ? "is-ready" : "is-missing"}`}
                >
                  {digestState.availability.hasAvailableProvider
                    ? t("general.butlerDigestResolved", {
                        provider: digestState.availability.resolvedProviderName ?? "",
                        model: digestState.availability.resolvedModel ?? ""
                      })
                    : t("general.butlerDigestNoProvider")}
                </p>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h3>{t("general.languageLabel")}</h3>
        <select
          value={language}
          onChange={(e) => void setLanguage(e.target.value as LanguagePreference)}
        >
          {SUPPORTED_LANGUAGE_PREFERENCES.map((lng) => (
            <option key={lng} value={lng}>
              {t(LANGUAGE_LABEL_KEY[lng])}
            </option>
          ))}
        </select>
      </section>

      <section className="settings-section">
        <h3>{t("general.themeLabel")}</h3>
        <select
          value={theme}
          onChange={(e) => void setTheme(e.target.value as ThemePreference)}
        >
          {SUPPORTED_THEME_PREFERENCES.map((value) => (
            <option key={value} value={value}>
              {t(THEME_LABEL_KEY[value])}
            </option>
          ))}
        </select>
      </section>

      <section className="settings-section">
        <h3>{t("general.telemetryLabel")}</h3>
        <label className="telemetry-setting-toggle">
          <input
            type="checkbox"
            checked={telemetryEnabled}
            onChange={(event) => void setTelemetryEnabled(event.target.checked)}
          />
          <span>
            <strong>{t("general.telemetryEnabled")}</strong>
            <small>{t("general.telemetryDescription")}</small>
          </span>
        </label>
      </section>
    </div>
  );
}
