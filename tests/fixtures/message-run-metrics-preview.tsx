// Local-only visual fixture: npx vite, then /tests/fixtures/message-run-metrics-preview.html.
// Renders the message action row with the production MessageRunMetrics popover trigger.
// URL params: theme=light|dark, lang=zh-CN|en.
import { Copy, ThumbsDown, ThumbsUp } from "lucide-react";
import { createRoot } from "react-dom/client";
import i18next from "../../src/i18n";
import "../../styles.css";
import { AgentAvatar } from "../../src/components/CLI/AgentAvatar";
import { LiveRunElapsed, MessageRunMetrics } from "../../src/components/CLI/MessageRunMetrics";
import { selectRunMetrics } from "../../src/components/CLI/runCardMetrics";

const params = new URLSearchParams(location.search);
void i18next.changeLanguage(params.get("lang") === "en" ? "en" : "zh-CN");
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";

const metrics = (summary: Record<string, unknown>) =>
  selectRunMetrics([{ kind: "usage", runMetrics: { runId: "run", promptSubmitted: true, ...summary } } as never], "run");

const states: Record<string, ReturnType<typeof metrics>> = {
  full: metrics({ status: "done", elapsedMs: 18_200, firstOutputTracked: true, firstOutputLatencyMs: 3_700, firstOutputKind: "text", tokensPerSecond: 52.4, speedSource: "measured", inputTokens: 3_200, outputTokens: 860 }),
  cline: metrics({ status: "done", elapsedMs: 20_000, automaticSpeed: true, firstOutputTracked: true, firstOutputLatencyMs: 1_200 }),
  failed: metrics({ status: "failed", elapsedMs: 9_800, inputTokens: 17_000 }),
  zeros: metrics({ status: "done", elapsedMs: 2_000, tokensPerSecond: 0, inputTokens: 0, outputTokens: 860 }),
  extreme: metrics({ status: "done", elapsedMs: 83_000, firstOutputTracked: true, firstOutputLatencyMs: 12_300, firstOutputKind: "thinking", tokensPerSecond: 123.4, speedSource: "call-average", inputTokens: 99_900_000, outputTokens: 1_234_567 }),
  legacy: metrics({ status: "done", elapsedMs: 20_000, firstTextLatencyMs: 19_000 })
};

const avatar = (
  <button type="button" className="msg-avatar-whip-target" disabled tabIndex={-1}>
    <AgentAvatar adapter="dsh-acp" agentId="cli-dsh-acp" className="msg-avatar agent-avatar" fallback={<span>✦</span>} />
  </button>
);

const buttons = (
  <>
    <button type="button" className="msg-action-btn" title="Copy" aria-label="Copy"><Copy className="msg-action-icon" aria-hidden="true" /></button>
    <button type="button" className="msg-action-btn" title="Upvote" aria-label="Upvote"><ThumbsUp className="msg-action-icon" aria-hidden="true" /></button>
    <button type="button" className="msg-action-btn" title="Downvote" aria-label="Downvote"><ThumbsDown className="msg-action-icon" aria-hidden="true" /></button>
  </>
);

function DemoMessage({ state, width, withButtons = true, open = false, running = false, label }: {
  state: keyof typeof states;
  width: number;
  withButtons?: boolean;
  open?: boolean | "up";
  running?: boolean;
  label?: string;
}) {
  const liveSummary = { runId: "run", status: "running", elapsedMs: 12_000, promptSubmitted: true, firstOutputTracked: true };
  return (
    <div style={{ width }}>
      <div style={{ margin: "0 0 6px 2px", color: "var(--fb-text-secondary)", fontSize: 11, fontFamily: "var(--fb-mono, monospace)" }}>{label ?? `${state} · ${width}px`}</div>
      <div className="msg msg-assistant" data-open={open === "up" ? "up" : open ? "true" : undefined}>
        {avatar}
        <div className="msg-content-wrapper">
          {running && (
            <div className="msg-header">
              <span className="msg-author">DeepSeek Harness</span>
              <span className="status-pill running">
                <span>{i18next.t("status.running")}</span>
                <LiveRunElapsed summary={liveSummary as never} receivedAt={performance.now()} />
              </span>
            </div>
          )}
          <div className="msg-bubble"><div className="msg-items"><p style={{ margin: 0, color: "var(--fb-text-primary)", fontSize: 14 }}>Done — here is the answer.</p></div></div>
          <div className="msg-actions">
            {withButtons && buttons}
            <span className="msg-action-time">10月9日 14:32</span>
            <MessageRunMetrics metrics={states[state]} />
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", flexDirection: "column", gap: 20, padding: 16, background: "var(--fb-home-bg-primary)", minHeight: "100vh" }}>
    {/* Open popovers sit in their own empty stretches so they cover nothing:
        the first sits at the top of the page (opens down), the last at the
        bottom (opens up). */}
    <DemoMessage state="full" width={640} open label="popover · opens down" />
    <div style={{ height: 460 }} />
    <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
      {[360, 480, 640, 900].map(width => <DemoMessage key={width} state="full" width={width} />)}
    </div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
      <DemoMessage state="cline" width={640} />
      <DemoMessage state="failed" width={640} withButtons={false} label="failed · 640px · metrics only" />
      <DemoMessage state="zeros" width={640} />
      <DemoMessage state="extreme" width={640} />
      <DemoMessage state="legacy" width={640} />
      <DemoMessage state="full" width={640} running label="running header · 640px" />
    </div>
    <div style={{ height: 520 }} />
    <DemoMessage state="full" width={640} open="up" label="popover · opens up" />
    <div style={{ height: 20 }} />
  </div>
);

void document.fonts.ready.then(() => {
  window.setTimeout(() => {
    // Open two popovers: one with clear space below (opens down), one at the page bottom (opens up).
    document.querySelector<HTMLButtonElement>('[data-open="true"] .msg-run-metrics')?.click();
    document.querySelector<HTMLButtonElement>('[data-open="up"] .msg-run-metrics')?.click();
    window.setTimeout(() => {
      const findings: { row: string; issue: string; detail: string }[] = [];
      document.querySelectorAll<HTMLElement>(".msg-assistant").forEach((msg, index) => {
        const panel = msg.querySelector<HTMLElement>(".msg-run-metrics-panel");
        const actions = msg.querySelector<HTMLElement>(".msg-actions");
        // An open popover intentionally stretches the scroll area; only a
        // closed action row may not overflow the message width.
        if (!panel && actions && actions.scrollWidth > actions.clientWidth + 1) {
          findings.push({ row: `#${index} w${Math.round(msg.getBoundingClientRect().width)}`, issue: "row-overflow", detail: (actions.textContent ?? "").slice(0, 80) });
        }
        if (panel) {
          const msgRight = msg.getBoundingClientRect().right;
          const panelRect = panel.getBoundingClientRect();
          if (panelRect.right > msgRight + 1) findings.push({ row: `#${index}`, issue: "panel-past-right-edge", detail: `panel right ${Math.round(panelRect.right)} > msg right ${Math.round(msgRight)}` });
          const coveredBy = document.elementFromPoint(panelRect.left + 8, panelRect.top + 8);
          if (coveredBy && !panel.contains(coveredBy)) findings.push({ row: `#${index}`, issue: "panel-covered", detail: coveredBy.className?.toString().slice(0, 60) ?? "?" });
        }
      });
      document.body.dataset.qa = JSON.stringify(findings);
    }, 300);
  }, 500);
});
