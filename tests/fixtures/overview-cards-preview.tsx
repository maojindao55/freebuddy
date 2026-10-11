// Local-only visual fixture: npx vite, then /tests/fixtures/overview-cards-preview.html.
// Renders the production AgentSessionCard with in-memory data.
// URL params: theme=light|dark, lang=zh-CN|en, only=<panelId>.
import { createRoot } from "react-dom/client";
import i18next from "../../src/i18n";
import "../../styles.css";
import { AgentAvatar } from "../../src/components/CLI/AgentAvatar";
import { AgentSessionCard } from "../../src/components/CLI/AgentSessionCard";
import { selectRunCardMetrics } from "../../src/components/CLI/runCardMetrics";

const params = new URLSearchParams(location.search);
void i18next.changeLanguage(params.get("lang") === "en" ? "en" : "zh-CN");
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";

const runFromSummary = (summary: Record<string, unknown>) =>
  selectRunCardMetrics([{ role: "assistant", content: JSON.stringify([{ kind: "usage", runMetrics: { runId: "run", promptSubmitted: true, ...summary } }]) }]);
const liveRun = (summary: Record<string, unknown>, liveStatus = "running") =>
  selectRunCardMetrics([], { taskSessionId: "run", status: liveStatus, items: [{ kind: "usage", runMetrics: { runId: "run", status: "running", promptSubmitted: true, firstOutputTracked: true, ...summary } }] as never });

const identity = (name: string, summary: string) => (
  <div className="agent-lockup">
    <AgentAvatar adapter="dsh-acp" agentId="cli-dsh-acp" className="agent-avatar" fallback={<span>{name.slice(0, 2).toUpperCase()}</span>} />
    <div>
      <strong>{name}</strong>
      <small title={summary}>{summary}</small>
    </div>
  </div>
);
const dsh = identity("DeepSeek Harness -test", "weibo-glm-5.3 / Max");

const session = {
  projectName: "FreeBuddy",
  cwd: "/Users/demo/www/freebuddy",
  folders: ["/Users/demo/www/freebuddy"],
  sessionId: "97aa294c-0000-1111-2222-333333365ca2",
  messages: 6,
  turns: 3
};

const panels: Record<string, { width: number; node: React.ReactNode }> = {
  idle: {
    width: 375,
    node: <AgentSessionCard metrics={selectRunCardMetrics([])} status="idle" identity={dsh} cwd="" folders={[]} messages={0} turns={0} />
  },
  preparing: {
    width: 375,
    node: <AgentSessionCard metrics={liveRun({ elapsedMs: 0, promptSubmitted: false }, "starting")} status="preparing" identity={dsh} {...session} folders={[]} cwd="" />
  },
  "running-waiting": {
    width: 375,
    node: <AgentSessionCard metrics={liveRun({ elapsedMs: 3_200 })} status="running" elapsedMs={3_200} identity={dsh} {...session} contextUsed={8_896} contextSize={1_000_000} />
  },
  "running-first-output": {
    width: 375,
    node: <AgentSessionCard metrics={liveRun({ elapsedMs: 3_200, firstOutputTracked: true, firstOutputLatencyMs: 500, firstOutputKind: "thinking" })} status="running" elapsedMs={3_200} identity={dsh} {...session} contextUsed={8_896} contextSize={1_000_000} />
  },
  done: {
    width: 375,
    node: <AgentSessionCard metrics={runFromSummary({ status: "done", elapsedMs: 4_500, firstOutputTracked: true, firstOutputLatencyMs: 2_600, tokensPerSecond: 63.5, speedSource: "observed", automaticSpeed: true, inputTokens: 17_000, outputTokens: 174 })} status="done" identity={dsh} {...session} contextUsed={8_896} contextSize={1_000_000} />
  },
  failed: {
    width: 375,
    node: <AgentSessionCard metrics={runFromSummary({ status: "failed", elapsedMs: 9_800, inputTokens: 17_000 })} status="failed" identity={dsh} {...session} />
  },
  "narrow-long": {
    width: 320,
    node: <AgentSessionCard
      metrics={runFromSummary({ status: "done", elapsedMs: 83_000, firstOutputTracked: true, firstOutputLatencyMs: 12_300, tokensPerSecond: 123.4, speedSource: "call-average", inputTokens: 123_456, outputTokens: 8_896 })}
      status="done"
      identity={identity("DeepSeek Harness -test with a very long agent name", "weibo-glm-5.3 / Max / extremely-long-summary-segment")}
      {...session}
      folders={["/Users/demo/www/freebuddy", "/Users/demo/www/agy-acp"]}
      primaryFolder="/Users/demo/www/freebuddy"
      worktreePath="/Users/demo/.worktrees/freebuddy"
      contextUsed={102_500}
      contextSize={1_000_000}
    />
  },
  "team-running": {
    width: 375,
    node: <AgentSessionCard metrics={runFromSummary({ status: "done", elapsedMs: 5_000 })} status="running" elapsedMs={5_000} team teamRunning {...session} messages={12} turns={5} />
  },
  "team-done": {
    width: 375,
    node: <AgentSessionCard metrics={runFromSummary({ status: "done", elapsedMs: 125_000 })} status="done" elapsedMs={125_000} team {...session} messages={12} turns={5} />
  }
};

const only = params.get("only");
const ids = Object.keys(panels).filter(id => !only || id === only);

createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", flexWrap: "wrap", gap: 24, padding: 16, alignItems: "flex-start", background: "var(--fb-home-bg-primary)" }}>
    {ids.map(id => (
      <div key={id}>
        <div style={{ margin: "0 0 6px 2px", color: "var(--fb-text-secondary)", fontSize: 11, fontFamily: "var(--fb-mono, monospace)" }}>{id} · {panels[id].width}px</div>
        <div data-panel={id} style={{ width: panels[id].width, padding: 16, background: "var(--fb-home-bg-primary)", borderLeft: "1px solid var(--fb-border)" }}>
          <div className="workspace-cards" style={{ display: "block", height: "auto", overflow: "visible" }}>{panels[id].node}</div>
        </div>
      </div>
    ))}
  </div>
);

void document.fonts.ready.then(() => {
  window.setTimeout(() => {
    for (const disclosure of document.querySelectorAll("details.workspace-overview-disclosure")) {
      (disclosure as HTMLDetailsElement).open = true;
    }
    window.setTimeout(() => {
      const findings: { panel: string; selector: string; text: string }[] = [];
      const selectors = [".agent-session-heading", ".agent-lockup", ".agent-session-live", ".workspace-overview-project", ".workspace-overview-context", ".workspace-overview-disclosure summary", ".workspace-overview-detail-list > div", ".workspace-mounted-list li", ".session-id-copy"];
      for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) {
        const panelId = panel.dataset.panel ?? "?";
        for (const selector of selectors) {
          for (const el of panel.querySelectorAll<HTMLElement>(selector)) {
            if (el.scrollWidth > el.clientWidth + 1) {
              findings.push({ panel: panelId, selector, text: (el.textContent ?? "").trim().slice(0, 80) });
            }
          }
        }
      }
      document.body.dataset.qa = JSON.stringify(findings);
    }, 200);
  }, 400);
});
