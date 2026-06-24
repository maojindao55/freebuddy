import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  useCliInstallStore,
  type CliInstallJob
} from "@/store/cliInstallStore";

export function CliInstallPanelHost() {
  const jobs = useCliInstallStore((s) => s.jobs);

  if (jobs.length === 0) return null;

  return (
    <div className="install-panel-stack" aria-live="polite">
      {jobs.map((job) => (
        <InstallFloatingPanel key={job.id} job={job} />
      ))}
    </div>
  );
}

function InstallFloatingPanel({ job }: { job: CliInstallJob }) {
  const { t } = useTranslation();
  const setPanelState = useCliInstallStore((s) => s.setPanelState);
  const dismissJob = useCliInstallStore((s) => s.dismissJob);
  const scrollRef = useRef<HTMLDivElement>(null);
  const minimized = job.panelState === "minimized";
  const success = job.done && job.exitCode === 0;

  useEffect(() => {
    if (minimized) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job.output, minimized, job.done]);

  if (minimized) {
    return (
      <button
        type="button"
        className="install-panel-minimized"
        onClick={() => setPanelState(job.id, "expanded")}
        title={t("settings.cli.installExpand")}
      >
        <span className="install-panel-minimized-label">
          {job.done
            ? success
              ? t("settings.cli.installSuccessShort", { label: job.label })
              : t("settings.cli.installFailedShort", { label: job.label })
            : t("settings.cli.installRunning", { label: job.label })}
        </span>
        {!job.done && <span className="install-panel-spinner" aria-hidden="true" />}
      </button>
    );
  }

  return (
    <section className="install-panel" aria-label={t("settings.cli.installTitle", { label: job.label })}>
      <header className="install-panel-header">
        <h3>{t("settings.cli.installTitle", { label: job.label })}</h3>
        <div className="install-panel-header-actions">
          {!job.done && (
            <button
              type="button"
              className="install-panel-action"
              onClick={() => setPanelState(job.id, "minimized")}
              title={t("settings.cli.runInBackground")}
            >
              {t("settings.cli.runInBackground")}
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={() => dismissJob(job.id)}
            aria-label={job.done ? t("common.close") : t("settings.cli.runInBackground")}
            title={job.done ? t("common.close") : t("settings.cli.runInBackground")}
          >
            ✕
          </button>
        </div>
      </header>

      {!job.done && (
        <p className="install-panel-hint muted">{t("settings.cli.installBackgroundHint")}</p>
      )}

      <div className="install-output install-panel-output" ref={scrollRef}>
        {job.output || (!job.done ? t("settings.cli.installStarting") : "")}
        {!job.done && <span className="install-cursor">▌</span>}
      </div>

      {job.done && (
        <div className={`install-result ${success ? "ok" : "warn"}`}>
          {success
            ? t("settings.cli.installSuccess")
            : t("settings.cli.installFailed", {
                code: job.exitCode ?? t("settings.cli.unknownExit"),
                output: ""
              })}
        </div>
      )}

      <div className="install-panel-footer">
        <button type="button" onClick={() => dismissJob(job.id)}>
          {job.done ? t("common.close") : t("settings.cli.runInBackground")}
        </button>
      </div>
    </section>
  );
}
