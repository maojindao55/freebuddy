(function () {
  "use strict";

  const bridge = window.FreeBuddyBridge;
  const params = new URLSearchParams(location.search);

  const STRINGS = {
    "zh-CN": {
      title: "白嫖兄弟",
      subtitle: "免费模型 & 免费额度专区",
      lead:
        "这些服务商提供免费模型或新用户免费额度。点「一键导入」即可在 FreeBuddy 里生成一个 BYOK 自定义 Agent，API Key 只会在 FreeBuddy 的原生窗口里输入，不经过本页面。",
      filterAll: "全部",
      filterCn: "国内直连",
      filterGlobal: "海外",
      disclaimer: "免费政策随时变化，以各服务商官网为准。发现过期信息欢迎到 GitHub 提交 PR。",
      statusConnecting: "正在连接 FreeBuddy…",
      statusConnected: "已连接 FreeBuddy，可以一键导入",
      statusStandalone: "在 FreeBuddy 侧栏的「白嫖」页打开本页，即可一键导入",
      regionCn: "国内直连",
      regionGlobal: "海外",
      protocolOpenai: "OpenAI 兼容",
      protocolAnthropic: "Anthropic 兼容",
      protocolDeepseek: "DeepSeek",
      homepage: "官网",
      getKey: "领取 Key",
      import: "一键导入",
      importAgain: "再导入一个",
      importing: "等待 FreeBuddy 确认…",
      imported: "已导入",
      runtimeMissing: "需要先安装 {runtime} CLI，导入时 FreeBuddy 会给出指引",
      verified: "核验于 {date}",
      updated: "目录更新于 {date}",
      count: "{n} 家服务商",
      importFailed: "导入失败：{error}",
      loadFailed: "目录加载失败，请刷新重试。"
    },
    en: {
      title: "Freebie Buddies",
      subtitle: "Free models & free-tier credits",
      lead:
        "These providers offer free models or free credits for new accounts. Click Import to create a BYOK custom agent in FreeBuddy. Your API key is entered in FreeBuddy's native dialog and never touches this page.",
      filterAll: "All",
      filterCn: "China (direct)",
      filterGlobal: "Global",
      disclaimer: "Free tiers change often; the provider's website is the source of truth. PRs with corrections are welcome on GitHub.",
      statusConnecting: "Connecting to FreeBuddy…",
      statusConnected: "Connected to FreeBuddy — one-click import is ready",
      statusStandalone: "Open this page from the Free Tier entry in FreeBuddy's sidebar to import with one click",
      regionCn: "China",
      regionGlobal: "Global",
      protocolOpenai: "OpenAI-compatible",
      protocolAnthropic: "Anthropic-compatible",
      protocolDeepseek: "DeepSeek",
      homepage: "Website",
      getKey: "Get API key",
      import: "Import",
      importAgain: "Import another",
      importing: "Waiting for FreeBuddy…",
      imported: "Imported",
      runtimeMissing: "Requires the {runtime} CLI; FreeBuddy will guide you during import",
      verified: "Verified {date}",
      updated: "Catalog updated {date}",
      count: "{n} providers",
      importFailed: "Import failed: {error}",
      loadFailed: "Could not load the catalog. Please refresh."
    }
  };

  const RUNTIME_LABEL = { codex: "Codex", claude: "Claude Code", deepseek: "DeepSeek" };

  const state = {
    locale: normalizeLocale(params.get("lang") || navigator.language),
    theme: params.get("theme") === "dark" ? "dark" : "light",
    region: "all",
    providers: [],
    updatedAt: null,
    connected: false,
    importedProviderIds: new Set(),
    runtimes: null,
    busy: new Set()
  };

  function normalizeLocale(tag) {
    return String(tag || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  }

  function t(key, vars) {
    const table = STRINGS[state.locale] || STRINGS.en;
    let text = table[key] || STRINGS.en[key] || key;
    if (vars) {
      Object.keys(vars).forEach((name) => {
        text = text.replace(`{${name}}`, String(vars[name]));
      });
    }
    return text;
  }

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);
  }

  function applyLocale() {
    document.documentElement.lang = state.locale;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
  }

  function runtimeKey(protocol) {
    if (protocol === "anthropic") return "claude";
    if (protocol === "deepseek") return "deepseek";
    return "codex";
  }

  function protocolLabel(protocol) {
    if (protocol === "anthropic") return t("protocolAnthropic");
    if (protocol === "deepseek") return t("protocolDeepseek");
    return t("protocolOpenai");
  }

  function summaryFor(provider) {
    const summary = provider.freeTierSummary || {};
    return summary[state.locale] || summary.en || Object.values(summary)[0] || "";
  }

  function openLink(event) {
    if (!state.connected) return; // standalone: let the browser handle target=_blank
    event.preventDefault();
    bridge.openExternal(event.currentTarget.href);
  }

  function setStatus(text, kind) {
    const el = document.getElementById("host-status");
    el.textContent = text;
    el.dataset.kind = kind || "";
  }

  function renderMeta() {
    const el = document.getElementById("catalog-meta");
    const parts = [t("count", { n: state.providers.length })];
    if (state.updatedAt) parts.push(t("updated", { date: state.updatedAt }));
    el.textContent = parts.join(" · ");
  }

  function renderCards() {
    const root = document.getElementById("providers");
    const template = document.getElementById("provider-card");
    root.textContent = "";
    state.providers
      .filter((p) => state.region === "all" || p.region === state.region)
      .forEach((provider) => {
        const node = template.content.firstElementChild.cloneNode(true);
        node.dataset.providerId = provider.id;

        node.querySelector(".card-name").textContent = provider.name;

        const tags = node.querySelector(".card-tags");
        if (provider.region) {
          const tag = document.createElement("span");
          tag.className = `tag region-${provider.region}`;
          tag.textContent = provider.region === "cn" ? t("regionCn") : t("regionGlobal");
          tags.appendChild(tag);
        }
        const proto = document.createElement("span");
        proto.className = "tag protocol";
        proto.textContent = protocolLabel(provider.protocol);
        tags.appendChild(proto);

        const imported = state.importedProviderIds.has(provider.id);
        const badge = node.querySelector(".card-imported");
        badge.hidden = !imported;
        badge.textContent = t("imported");

        node.querySelector(".card-summary").textContent = summaryFor(provider);

        const models = node.querySelector(".card-models");
        provider.models.forEach((model) => {
          const li = document.createElement("li");
          li.textContent = model.name || model.id;
          li.title = model.id;
          if (model.supportsVision) li.classList.add("vision");
          models.appendChild(li);
        });

        const homepage = node.querySelector(".card-homepage");
        if (provider.homepage) {
          homepage.href = provider.homepage;
          homepage.textContent = t("homepage");
          homepage.addEventListener("click", openLink);
        } else homepage.remove();

        const consoleLink = node.querySelector(".card-console");
        if (provider.consoleUrl) {
          consoleLink.href = provider.consoleUrl;
          consoleLink.textContent = t("getKey");
          consoleLink.addEventListener("click", openLink);
        } else consoleLink.remove();

        const btn = node.querySelector(".import-btn");
        const busy = state.busy.has(provider.id);
        btn.textContent = busy ? t("importing") : imported ? t("importAgain") : t("import");
        btn.disabled = !state.connected || busy;
        btn.classList.toggle("secondary", imported);
        btn.addEventListener("click", () => importProvider(provider));

        const verified = node.querySelector(".card-verified");
        const notes = [];
        if (provider.verifiedAt) notes.push(t("verified", { date: provider.verifiedAt }));
        if (state.runtimes && state.runtimes[runtimeKey(provider.protocol)] === false) {
          notes.push(t("runtimeMissing", { runtime: RUNTIME_LABEL[runtimeKey(provider.protocol)] }));
          node.classList.add("runtime-missing");
        }
        verified.textContent = notes.join(" · ");

        root.appendChild(node);
      });
  }

  async function importProvider(provider) {
    if (!state.connected || state.busy.has(provider.id)) return;
    state.busy.add(provider.id);
    renderCards();
    try {
      const result = await bridge.importAgent(provider);
      if (result && result.ok) {
        state.importedProviderIds.add(provider.id);
      } else if (result && result.error && result.error !== "cancelled") {
        window.alert(t("importFailed", { error: result.error }));
      }
    } catch (err) {
      window.alert(t("importFailed", { error: err && err.message ? err.message : String(err) }));
    } finally {
      state.busy.delete(provider.id);
      renderCards();
    }
  }

  function applyHostState(info) {
    state.importedProviderIds = new Set(info.importedProviderIds || []);
    state.runtimes = info.runtimes || null;
  }

  async function connectHost() {
    if (!bridge.embedded) {
      setStatus(t("statusStandalone"), "standalone");
      return;
    }
    setStatus(t("statusConnecting"), "connecting");
    try {
      const info = await bridge.connect(4000);
      state.connected = true;
      if (info.locale) state.locale = normalizeLocale(info.locale);
      if (info.theme === "dark" || info.theme === "light") state.theme = info.theme;
      applyHostState(info);
      applyTheme();
      applyLocale();
      setStatus(t("statusConnected"), "connected");
    } catch {
      setStatus(t("statusStandalone"), "standalone");
    }
    renderMeta();
    renderCards();
  }

  async function loadCatalog() {
    try {
      const res = await fetch("./providers.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.providers = Array.isArray(data.providers) ? data.providers : [];
      state.updatedAt = data.updatedAt || null;
    } catch (err) {
      console.error("[freebie] catalog load failed", err);
      document.getElementById("providers").innerHTML =
        `<p class="load-error">${t("loadFailed")}</p>`;
      return;
    }
    renderMeta();
    renderCards();
  }

  document.querySelectorAll(".filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.region = btn.dataset.region;
      document.querySelectorAll(".filter").forEach((b) => b.classList.toggle("active", b === btn));
      renderCards();
    });
  });

  bridge.onState(applyHostState);
  bridge.onState(renderCards);

  applyTheme();
  applyLocale();
  loadCatalog();
  connectHost();
})();
