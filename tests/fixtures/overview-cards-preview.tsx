// Local-only visual fixture: npx vite, then /tests/fixtures/overview-cards-preview.html.
// Renders the production RunMetricsSection + SessionInfoCard with in-memory data.
// URL params: theme=light|dark, lang=zh-CN|en, only=<panelId>.
import { createRoot } from "react-dom/client";
import i18next from "../../src/i18n";
import "../../styles.css";
import { AgentAvatar } from "../../src/components/CLI/AgentAvatar";
import { RunMetricsSection } from "../../src/components/CLI/RunMetricsSection";
import { SessionInfoCard } from "../../src/components/CLI/SessionInfoCard";
import { selectRunCardMetrics } from "../../src/components/CLI/runCardMetrics";

const params = new URLSearchParams(location.search);
void i18next.changeLanguage(params.get("lang") === "en" ? "en" : "zh-CN");
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";

const runFromSummary = (summary: Record<string, unknown>) =>
  selectRunCardMetrics([{ role: "assistant", content: JSON.stringify([{ kind: "usage", runMetrics: { runId: "run", promptSubmitted: true, ...summary } }]) }]);
const liveRun = (summary: Record<string, unknown>) =>
  selectRunCardMetrics([], { taskSessionId: "run", status: "running", items: [{ kind: "usage", runMetrics: { runId: "run", status: "running", promptSubmitted: true, ...summary } }] as never });

const identity = (name: string, summary: string) => (
  <div className="agent-lockup">
    <AgentAvatar adapter="dsh-acp" agentId="cli-dsh-acp" className="agent-avatar" fallback={<span>{name.slice(0, 2).toUpperCase()}</span>} />
    <div>
      <strong>{name}</strong>
      <small title={summary}>{summary}</small>
    </div>
  </div>
);

const panels: Record<string, { width: number; node: React.ReactNode }> = {
  done: {
    width: 375,
    node: <>
      <RunMetricsSection
        metrics={runFromSummary({ status: "done", elapsedMs: 4_500, firstTextLatencyMs: 2_600, tokensPerSecond: 63.5, speedSource: "observed", automaticSpeed: true, inputTokens: 17_000, outputTokens: 174 })}
        elapsedMs={4_500}
        identity={identity("DeepSeek Harness -test", "weibo-glm-5.3 / Max")}
      />
      <SessionInfoCard cwd="" folders={[]} messages={6} turns={3} sessionId="97aa294c-0000-1111-2222-333333365ca2" contextUsed={8_896} contextSize={1_000_000} />
    </>
  },
  "narrow-long": {
    width: 320,
    node: <>
      <RunMetricsSection
        metrics={runFromSummary({ status: "done", elapsedMs: 83_000, firstTextLatencyMs: 12_300, tokensPerSecond: 123.4, speedSource: "call-average", inputTokens: 123_456, outputTokens: 8_896 })}
        elapsedMs={83_000}
        identity={identity("DeepSeek Harness -test with a very long agent name", "weibo-glm-5.3 / Max / extremely-long-summary-segment")}
      />
      <SessionInfoCard
        projectName="FreeBuddy"
        cwd="/Users/demo/www/freebuddy"
        folders={["/Users/demo/www/freebuddy", "/Users/demo/www/agy-acp"]}
        primaryFolder="/Users/demo/www/freebuddy"
        worktreePath="/Users/demo/.worktrees/freebuddy"
        messages={6}
        turns={3}
        contextUsed={102_500}
        contextSize={1_000_000}
      />
    </>
  },
  running: {
    width: 375,
    node: <>
      <RunMetricsSection
        metrics={liveRun({ elapsedMs: 3_200, automaticSpeed: true })}
        elapsedMs={3_200}
        identity={identity("DeepSeek Harness -test", "weibo-glm-5.3 / Max")}
      />
      <SessionInfoCard cwd="" folders={[]} messages={2} turns={1} contextUsed={8_896} contextSize={1_000_000} />
    </>
  },
  idle: {
    width: 375,
    node: <>
      <RunMetricsSection metrics={selectRunCardMetrics([])} identity={identity("DeepSeek Harness -test", "weibo-glm-5.3 / Max")} />
      <SessionInfoCard cwd="" folders={[]} messages={0} turns={0} />
    </>
  },
  "failed-partial": {
    width: 320,
    node: <>
      <RunMetricsSection
        metrics={runFromSummary({ status: "failed", elapsedMs: 9_800, inputTokens: 17_000 })}
        elapsedMs={9_800}
        identity={identity("DeepSeek Harness -test", "weibo-glm-5.3 / Max")}
      />
      <SessionInfoCard cwd="" folders={[]} messages={4} turns={2} />
    </>
  },
  "extreme-320": {
    width: 320,
    node: <>
      <RunMetricsSection
        metrics={runFromSummary({ status: "done", elapsedMs: 83_000, firstTextLatencyMs: 12_300, tokensPerSecond: 123.4, speedSource: "call-average", inputTokens: 99_900_000, outputTokens: 1_234_567 })}
        elapsedMs={83_000}
        identity={identity("DeepSeek Harness -test", "weibo-glm-5.3 / Max")}
      />
      <SessionInfoCard cwd="" folders={[]} messages={6} turns={3} contextUsed={1_234_567} contextSize={2_000_000} />
    </>
  },
  "extreme-375": {
    width: 375,
    node: <>
      <RunMetricsSection
        metrics={runFromSummary({ status: "done", elapsedMs: 83_000, firstTextLatencyMs: 12_300, tokensPerSecond: 123.4, speedSource: "call-average", inputTokens: 99_900_000, outputTokens: 1_234_567 })}
        elapsedMs={83_000}
        identity={identity("DeepSeek Harness -test", "weibo-glm-5.3 / Max")}
      />
      <SessionInfoCard cwd="" folders={[]} messages={6} turns={3} contextUsed={1_234_567} contextSize={2_000_000} />
    </>
  },
  team: {
    width: 375,
    node: <>
      <RunMetricsSection
        metrics={runFromSummary({ status: "done", elapsedMs: 5_000 })}
        elapsedMs={5_000}
        team
      />
      <SessionInfoCard projectName="FreeBuddy" cwd="/Users/demo/www/freebuddy" folders={["/Users/demo/www/freebuddy"]} messages={12} turns={5} team />
    </>
  }
};

const only = params.get("only");
const ids = Object.keys(panels).filter(id => !only || id === only);

createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", flexWrap: "wrap", gap: 24, padding: 16, alignItems: "flex-start", background: "var(--fb-home-bg-primary)" }}>
    {ids.map(id => (
      <div key={id}>
        <div style={{ margin: "0 0 6px 2px", color: "var(--fb-text-secondary)", fontSize: 11, fontFamily: "var(--fb-mono, monospace)" }}>{id} · {panels[id].width}px</div>
        <div className="details-panel workspace-panel detail-column" data-panel={id} style={{ width: panels[id].width, height: 960 }}>
          <div className="workspace-cards">{panels[id].node}</div>
        </div>
      </div>
    ))}
  </div>
);

void document.fonts.ready.then(() => {
  window.setTimeout(() => {
    const findings: { panel: string; selector: string; text: string }[] = [];
    const fontSizes: Record<string, string> = {};
    const selectors = [".run-metrics-grid > div", ".run-metrics-value", ".run-overview-identity", ".agent-lockup", ".workspace-overview-project", ".workspace-overview-context", ".workspace-overview-disclosure summary"];
    for (const panel of document.querySelectorAll<HTMLElement>(".details-panel[data-panel]")) {
      const panelId = panel.dataset.panel ?? "?";
      const value = panel.querySelector<HTMLElement>(".run-metrics-value");
      if (value) fontSizes[panelId] = getComputedStyle(value).fontSize;
      for (const selector of selectors) {
        for (const el of panel.querySelectorAll<HTMLElement>(selector)) {
          const overflow = el.scrollWidth > el.clientWidth + 1;
          const clipped = el.classList.contains("run-metrics-pair") && el.scrollWidth > el.clientWidth;
          const tallValue = el.classList.contains("run-metrics-value") && el.getBoundingClientRect().height > 40;
          if (overflow || clipped || tallValue) findings.push({ panel: panelId, selector: clipped ? `${selector} (clipped)` : tallValue ? `${selector} (tall)` : selector, text: (el.textContent ?? "").trim().slice(0, 80) });
        }
      }
    }
    document.body.dataset.qaFonts = JSON.stringify(fontSizes);
    document.body.dataset.qa = JSON.stringify(findings);
  }, 400);
});
