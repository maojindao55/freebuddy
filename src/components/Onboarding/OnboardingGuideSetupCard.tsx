import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Download, ExternalLink, Layers, Loader2, RefreshCw } from "lucide-react";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useCliInstallStore } from "@/store/cliInstallStore";
import { useOnboardingDetectionStore } from "@/store/onboardingDetectionStore";
import { useOnboardingStore } from "@/store/onboardingStore";
import { buildOnboardingInstallPlan, type OnboardingInstallItem } from "@/utils/onboardingInstallPlan";

export function OnboardingGuideSetupCard({ onOpenSettings, onAskGuide }: {
  onOpenSettings?: () => void;
  onAskGuide?: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const adapters = useCliExecutorStore((s) => s.adapters);
  const runtimes = useCliExecutorStore((s) => s.runtimes);
  const jobs = useCliInstallStore((s) => s.jobs);
  const queue = useCliInstallStore((s) => s.queue);
  const enqueueJobs = useCliInstallStore((s) => s.enqueueJobs);
  const clearQueue = useCliInstallStore((s) => s.clearQueue);
  const phase = useOnboardingDetectionStore((s) => s.phase);
  const discoveryRuntimes = useOnboardingDetectionStore((s) => s.discoveryRuntimes);
  const detect = useOnboardingDetectionStore((s) => s.detect);
  const resolved = useOnboardingStore((s) => s.resolved);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [batchIds, setBatchIds] = useState<string[]>([]);

  useEffect(() => { if (phase === "idle") void detect(); }, [phase, detect]);

  const plan = buildOnboardingInstallPlan(adapters, runtimes, discoveryRuntimes);
  const busy = jobs.some((job) => !job.done) || queue.length > 0;
  const checking = phase === "idle" || phase === "checking";
  const canInstall = phase === "done" && !busy;
  const missing = plan.filter((item) => !item.installed && item.command);
  const selected = missing.filter((item) => !excluded.includes(item.id));
  const installed = plan.filter((item) => item.installed);
  const allSelected = missing.length > 0 && selected.length === missing.length;
  const failed = jobs.filter((job) => plan.some((item) => item.id === job.adapterId) &&
    job.done && job.phase !== "succeeded");
  const batchDone = batchIds.length > 0 && !busy && batchIds.every((id) => runtimes[id]?.installed);

  const handleInstallSelected = () => {
    if (!canInstall || !selected.length) return;
    if (resolved === "done" || resolved === "skipped") void useOnboardingStore.getState().markStarted();
    setBatchIds(selected.map((item) => item.id));
    enqueueJobs(selected.map((item) => ({ adapterId: item.id, label: item.name, command: item.command! })));
  };

  const renderItem = (item: OnboardingInstallItem) => {
    const job = jobs.find((entry) => entry.adapterId === item.id);
    const queued = queue.some((entry) => entry.adapterId === item.id);
    const status = checking ? "checking" : queued ? "queued" : job && !job.done
      ? job.phase === "verifying" ? "verifying" : "installing"
      : item.installed ? "installed" : job && job.phase !== "succeeded" ? "failed"
        : item.needsRepair ? "repair" : item.detected ? "needsConnection" : "missing";
    return <div className={`core-agent-item${item.installed ? " is-installed" : ""}`} key={item.id}>
      <label className="onboarding-agent-choice">
        <input type="checkbox" aria-label={t("onboarding.setup.selectAgent", { name: item.name })}
          checked={item.installed || !excluded.includes(item.id)}
          disabled={!canInstall || item.installed || !item.command}
          onChange={(event) => setExcluded((previous) => event.target.checked
            ? previous.filter((id) => id !== item.id) : [...previous, item.id])} />
        <span className="core-agent-info">
          <span className="core-agent-name-row"><strong>{item.name}</strong>
            {item.recommended && <span className="core-agent-tag">{t("onboarding.setup.recommendedTag")}</span>}
          </span>
          <span className="core-agent-desc">{item.installed
            ? t("onboarding.setup.installedHint")
            : t(item.detected ? "onboarding.setup.connectionHint" : "onboarding.setup.packageHint", { binary: item.binary })}</span>
        </span>
      </label>
      <span className={`core-agent-status${item.installed ? " core-agent-status--installed" : ""}`}>
        {["checking", "installing", "verifying"].includes(status) && <Loader2 size={14} className="spin" />}
        {status === "installed" && <CheckCircle2 size={14} />}
        {t(`onboarding.setup.status.${status}`)}
      </span>
    </div>;
  };

  return <section className="onboarding-setup-card" aria-label={t("onboarding.setup.cardTitle")}>
    <div className="onboarding-setup-header">
      <div className="onboarding-setup-header-icon"><Layers size={18} /></div>
      <div className="onboarding-setup-header-text">
        <div className="setup-header-title-row"><h3>{t("onboarding.setup.cardTitle")}</h3></div>
        <p className="setup-header-subtitle">{t("onboarding.setup.cardSubtitle")}</p>
      </div>
      <button className="step-btn" type="button" onClick={() => void detect()} disabled={checking || busy}>
        <RefreshCw size={13} />{t("onboarding.setup.rescan")}
      </button>
    </div>
    <p className="setup-header-headline" role="status" aria-live="polite">
      {checking ? t("onboarding.setup.detecting") : phase === "error" ? t("onboarding.setup.detectionFailed")
        : t("onboarding.setup.detectedSummary", { count: plan.filter((item) => item.detected).length })}
    </p>
    {!checking && phase === "done" && <>
      <div className="onboarding-install-group">
        <h4>{t("onboarding.setup.existingTitle")}</h4>
        <p>{t("onboarding.setup.existingHint")}</p>
        <div className="onboarding-core-agents-list">
          {plan.filter((item) => item.detected).map(renderItem)}
          {!plan.some((item) => item.detected) && <p>{t("onboarding.setup.noExisting")}</p>}
        </div>
      </div>
      <div className="onboarding-install-group">
        <h4>{t("onboarding.setup.recommendedTitle")}</h4>
        <p>{t("onboarding.setup.recommendedHint")}</p>
        <div className="onboarding-core-agents-list">
          {plan.filter((item) => !item.detected).map(renderItem)}
          {!plan.some((item) => !item.detected) && <p>{t("onboarding.setup.recommendationsCovered")}</p>}
        </div>
      </div>
      {missing.length > 0 && <div className="onboarding-install-controls">
        <label className="onboarding-select-all"><input type="checkbox" checked={allSelected} disabled={!canInstall}
          onChange={() => setExcluded(allSelected ? missing.map((item) => item.id) : [])} />
          {t("onboarding.setup.selectAll")}</label>
        <button type="button" className="step-btn step-btn--primary" disabled={!canInstall || !selected.length}
          onClick={handleInstallSelected}><Download size={14} />
          {t("onboarding.setup.installSelected", { count: selected.length })}</button>
      </div>}
    </>}
    {busy && <div className="onboarding-install-progress" role="status" aria-live="polite">
      <p>{t("onboarding.setup.queueProgress", { name: jobs.find((job) => !job.done)?.label ?? "", count: queue.length })}</p>
      {queue.length > 0 && <button type="button" className="step-btn" onClick={clearQueue}>{t("onboarding.setup.cancelWaiting")}</button>}
    </div>}
    {!busy && failed.length > 0 && <p role="alert" className="onboarding-install-error">
      {t("onboarding.setup.failureHint", { names: failed.map((job) => job.label).join("、") })}
      {onAskGuide && <button type="button" className="step-btn" onClick={() => onAskGuide(t("onboarding.setup.helpPrompt", {
        names: failed.map((job) => `${job.label} (${job.phase})`).join(", ")
      }))}>{t("onboarding.setup.askForHelp")}</button>}
    </p>}
    {batchDone && <p role="status">{t("onboarding.setup.batchComplete")}</p>}
    {phase === "done" && installed.length > 0 && !busy && <div className="onboarding-setup-next-steps">
      <p className="setup-header-subtitle">{t("onboarding.setup.nextHint")}</p>
      <div className="onboarding-install-controls">
        {onOpenSettings && <button className="step-btn" type="button" onClick={onOpenSettings}>{t("onboarding.setup.configureNext")}</button>}
        <button className="step-btn step-btn--primary" type="button" disabled={resolved === "done" || resolved === "skipped"}
          onClick={() => void (failed.length ? useOnboardingStore.getState().markSkipped() : useOnboardingStore.getState().markDone())}>
          {t(resolved === "done" ? "onboarding.setup.finished" : resolved === "skipped" ? "onboarding.setup.postponed" : failed.length ? "onboarding.setup.finishLater" : "onboarding.setup.finishInstallation")}
        </button>
      </div>
    </div>}
    {onOpenSettings && <div className="onboarding-setup-footer">
      <button type="button" className="onboarding-setup-settings-link" onClick={onOpenSettings}>
        {t("onboarding.setup.exploreOtherAgents")}<ExternalLink size={12} />
      </button>
    </div>}
  </section>;
}
