// Production editor and SettingsPage wrappers with memory-only sample data.
// Keep the wrappers: their label/input rules reproduce the image-control bug.
import { createRoot } from "react-dom/client";
import i18next from "../../src/i18n";
import "../../styles.css";
import { CLIAdaptersTab } from "../../src/components/Settings/CLIAdaptersTab";
import { cliAdapterDefinitions } from "../../src/config/cliAdapters";
import { cliClient } from "../../src/services/cli/client";
import type { CLIExecutorOverride } from "../../src/services/cli/types";
import { useCliExecutorStore } from "../../src/store/cliExecutorStore";
import { useConversationStore } from "../../src/store/conversationStore";
import { useGuideInstallStore } from "../../src/store/guideInstallStore";
import { useProviderStore } from "../../src/store/providerStore";
import { useSkillStore } from "../../src/store/skillStore";

const params = new URLSearchParams(location.search);
void i18next.changeLanguage(params.get("lang") === "en" ? "en" : "zh-CN");
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
const adapter = cliAdapterDefinitions.find(item => item.id === params.get("adapter")) ??
  cliAdapterDefinitions.find(item => item.id === "pi-acp")!;
const byok = {
  enabled: true,
  providerId: "custom",
  baseUrl: "https://relay.example.test/v1",
  apiKeyPreview: "••••••••DEMO",
  models: [{ id: "senseaudio-s2", supportsVision: false }]
};
const override: CLIExecutorOverride = {
  id: adapter.id,
  enabled: true,
  ...(adapter.id === "codex-acp" ? { codexByok: byok } :
    adapter.id === "dsh-acp" ? { deepseekByok: byok } : { piByok: byok })
};
const noop = async () => {};
cliClient.isAvailable = () => true;
useCliExecutorStore.setState({
  loaded: true,
  adapters: [adapter],
  overrides: { [adapter.id]: override },
  runtimes: { [adapter.id]: { adapter: adapter.id, installed: true, version: "preview" } },
  load: noop, check: noop, checkAll: noop, checkUpdates: noop, refreshRuntimes: noop,
  upsertOverride: async input => {
    useCliExecutorStore.setState(state => ({ overrides: { ...state.overrides, [input.id]: input } }));
  }
});
useConversationStore.setState({ members: [], refreshMembers: noop });
useGuideInstallStore.setState({ settleGuideTurn: noop });
useProviderStore.setState({ providers: [], loaded: true, loading: false });
useSkillStore.setState({ skills: [], loaded: true });

createRoot(document.getElementById("root")!).render(
  <section className="settings-page-shell" style={{ height: "100vh" }}>
    <div className="settings-surface settings-surface-page">
      <div className="settings-layout settings-layout-content-only">
        <div className="settings-panel settings-panel-full">
          <CLIAdaptersTab />
        </div>
      </div>
    </div>
  </section>
);
