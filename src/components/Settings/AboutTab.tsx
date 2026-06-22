import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useUpdaterStore, type UpdateStatus } from "@/store/updaterStore";
import appIconUrl from "../../../assets/app-icon.png";

const RELEASES_URL = "https://github.com/maojindao55/freebuddy/releases";

function formatReleaseNotes(notes: unknown): string | null {
  if (!notes) return null;
  if (typeof notes === "string") return notes.trim() || null;
  if (Array.isArray(notes)) {
    const text = notes
      .map((n) => (typeof n === "string" ? n : (n as { note?: string })?.note ?? ""))
      .filter(Boolean)
      .join("\n\n");
    return text.trim() || null;
  }
  return null;
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
          {platformLabel && (
            <div className="about-card-platform">{platformLabel}</div>
          )}
        </div>
      </section>

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
                <pre>{notesText}</pre>
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
    </div>
  );
}
