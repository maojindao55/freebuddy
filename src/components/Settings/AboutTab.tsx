import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useUpdaterStore, type UpdateStatus } from "@/store/updaterStore";
import { useDebugLogsDialogStore } from "@/store/debugLogsDialogStore";
import {
  formatReleaseNotes,
  isReleaseNotesHtml,
  sanitizeReleaseNotesHtml
} from "@/utils/releaseNotes";
import appIconUrl from "../../../assets/app-icon.png";

const RELEASES_URL = "https://github.com/maojindao55/freebuddy/releases";

type RuntimeSnapshot = {
  activeVersion: string | null;
  pendingVersion: string | null;
  lastKnownGoodVersion: string | null;
  channel: string;
  lastError?: string | null;
};

function RuntimePackPanel() {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const api = window.freebuddy?.runtimePack;

  const reload = async () => {
    if (!api) return;
    setSnapshot(await api.status());
  };

  useEffect(() => {
    void reload();
  }, []);

  if (!api) return null;
  const active = snapshot?.activeVersion || t("runtimePack.bundled");

  return (
    <section className="settings-section runtime-pack-section">
      <h3>{t("runtimePack.sectionTitle")}</h3>
      <dl className="runtime-pack-status">
        <div>
          <dt>{t("runtimePack.active")}</dt>
          <dd>{active}</dd>
        </div>
        <div>
          <dt>{t("runtimePack.pending")}</dt>
          <dd>{snapshot?.pendingVersion || "—"}</dd>
        </div>
        <div>
          <dt>{t("runtimePack.lastKnownGood")}</dt>
          <dd>{snapshot?.lastKnownGoodVersion || t("runtimePack.bundled")}</dd>
        </div>
      </dl>
      <div className="about-update-actions">
        <button
          type="button"
          className="primary-btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api
              .check()
              .then((result) => {
                setMessage(
                  result.available
                    ? t("runtimePack.available", { version: result.version ?? "" })
                    : t("runtimePack.upToDate")
                );
                return reload();
              })
              .catch((err: Error) => {
                setMessage(t("runtimePack.error", { message: err.message }));
              })
              .finally(() => setBusy(false));
          }}
        >
          {busy ? t("runtimePack.checking") : t("runtimePack.check")}
        </button>
      </div>
      {message && <p className="about-status">{message}</p>}
      {snapshot?.lastError && <p className="about-error">{snapshot.lastError}</p>}
      <details className="runtime-pack-advanced">
        <summary>{t("runtimePack.advanced")}</summary>
        <label className="runtime-pack-channel">
          {t("runtimePack.channel")}
          <select
            value={snapshot?.channel ?? "stable"}
            onChange={(event) => {
              const channel = event.target.value as "stable" | "beta" | "development";
              void api.setChannel(channel).then(() => reload());
            }}
          >
            <option value="stable">{t("runtimePack.channelStable")}</option>
            <option value="beta">{t("runtimePack.channelBeta")}</option>
            <option value="development">{t("runtimePack.channelDevelopment")}</option>
          </select>
        </label>
        <div className="about-update-actions">
          <button
            type="button"
            className="link-btn"
            disabled={!snapshot?.pendingVersion || busy}
            onClick={() => {
              if (!snapshot?.pendingVersion) return;
              setBusy(true);
              void api.activate(snapshot.pendingVersion).then(() => reload()).finally(() => setBusy(false));
            }}
          >
            {t("runtimePack.activatePending")}
          </button>
          <button
            type="button"
            className="link-btn"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api.rollback().then(() => reload()).finally(() => setBusy(false));
            }}
          >
            {t("runtimePack.rollback")}
          </button>
        </div>
      </details>
    </section>
  );
}

export function AboutTab() {
  const { t } = useTranslation();
  const appVersion = useUpdaterStore((s) => s.appVersion);
  const status = useUpdaterStore((s) => s.status);
  const latestVersion = useUpdaterStore((s) => s.latestVersion);
  const releaseNotes = useUpdaterStore((s) => s.releaseNotes);
  const downloadPercent = useUpdaterStore((s) => s.downloadPercent);
  const errorMessage = useUpdaterStore((s) => s.errorMessage);
  const load = useUpdaterStore((s) => s.load);
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);
  const downloadUpdate = useUpdaterStore((s) => s.downloadUpdate);
  const quitAndInstall = useUpdaterStore((s) => s.quitAndInstall);
  const setDebugLogsOpen = useDebugLogsDialogStore((s) => s.setOpen);

  useEffect(() => {
    void load();
  }, [load]);

  const api = window.freebuddy;
  const updaterAvailable = Boolean(api?.updater);
  const platform = api?.platform ?? "";
  const arch = api?.arch ?? "";

  const isBusy: boolean =
    status === "checking" || status === "downloading";
  const canCheck = updaterAvailable && !isBusy && status !== "downloaded";
  const canInstall = status === "downloaded";

  const notesText = formatReleaseNotes(releaseNotes);
  const notesHtml =
    notesText && isReleaseNotesHtml(notesText)
      ? sanitizeReleaseNotesHtml(notesText)
      : null;

  const platformLabel = platform
    ? [
        t(`updater.platform.${platform}` as const, { defaultValue: platform }),
        arch ? t(`updater.arch.${arch}` as const, { defaultValue: arch }) : ""
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const statusLabel: Record<UpdateStatus, string> = {
    idle: "",
    checking: t("updater.status.checking"),
    available: t("updater.status.available", { version: latestVersion ?? "" }),
    "not-available": t("updater.status.notAvailable"),
    downloading: t("updater.status.downloading", {
      percent: Math.round(downloadPercent)
    }),
    downloaded: t("updater.status.downloaded", { version: latestVersion ?? "" }),
    error: t("updater.status.error")
  };

  return (
    <div className="settings-about">
      <section className="about-card">
        <img className="about-card-icon" src={appIconUrl} alt="" />
        <div className="about-card-meta">
          <div className="about-card-name">FreeBuddy</div>
          <div className="about-card-version">v{appVersion || "—"}</div>
          <div className="about-card-platform">
            {t("runtimePack.label")}: {t("runtimePack.bundled")}
          </div>
          {platformLabel && (
            <div className="about-card-platform">{platformLabel}</div>
          )}
        </div>
      </section>

      <RuntimePackPanel />

      <section className="settings-section">
        <h3>{t("updater.updateTitle")}</h3>
        {!updaterAvailable && (
          <p className="about-hint">{t("updater.unavailable")}</p>
        )}
        {updaterAvailable && (
          <>
            <div className="about-update-actions">
              <button
                type="button"
                className="primary-btn"
                disabled={!canCheck}
                onClick={() => void checkForUpdates()}
              >
                {t("updater.check")}
              </button>
              {canInstall && (
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => void quitAndInstall()}
                >
                  {t("updater.installNow")}
                </button>
              )}
            </div>

            {status !== "idle" && (
              <p className={`about-status about-status-${status}`}>
                {statusLabel[status]}
              </p>
            )}

            {status === "downloading" && (
              <div className="about-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(downloadPercent)}>
                <div
                  className="about-progress-bar"
                  style={{ width: `${Math.round(downloadPercent)}%` }}
                />
              </div>
            )}

            {status === "available" && latestVersion && (
              <button
                type="button"
                className="link-btn"
                disabled={isBusy}
                onClick={() => void downloadUpdate()}
              >
                {t("updater.downloadNow")}
              </button>
            )}

            {notesText && (
              <details className="about-notes">
                <summary>{t("updater.releaseNotes")}</summary>
                {notesHtml ? (
                  <div
                    className="about-notes-content"
                    dangerouslySetInnerHTML={{ __html: notesHtml }}
                  />
                ) : (
                  <div className="about-notes-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {notesText}
                    </ReactMarkdown>
                  </div>
                )}
              </details>
            )}

            {status === "error" && errorMessage && (
              <p className="about-error">{errorMessage}</p>
            )}

            <p className="about-hint">{t("updater.autoCheckHint")}</p>
          </>
        )}
      </section>

      <section className="settings-section">
        <h3>{t("updater.linksTitle")}</h3>
        <button
          type="button"
          className="link-btn about-releases-link"
          onClick={() => window.open(RELEASES_URL, "_blank", "noopener")}
        >
          {t("updater.releasesLink")} ↗
        </button>
      </section>

      <section className="settings-section">
        <h3>{t("debugLogs.aboutSectionTitle")}</h3>
        <p className="about-hint">{t("debugLogs.aboutSectionHint")}</p>
        <button
          type="button"
          className="primary-btn"
          onClick={() => setDebugLogsOpen(true)}
        >
          {t("debugLogs.openButton")}
        </button>
      </section>
    </div>
  );
}
