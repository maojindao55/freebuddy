(function () {
  "use strict";

  var TOKEN_KEY = "fb_remote_token";

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || "";
  }
  function setToken(t) {
    sessionStorage.setItem(TOKEN_KEY, t);
    localStorage.setItem(TOKEN_KEY, t);
  }
  function clearToken() {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  }

  function authHeaders() {
    var h = { "Content-Type": "application/json" };
    var t = getToken();
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }

  async function postJson(path, body) {
    var res = await fetch(path, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body || {})
    });
    return res.json();
  }

  async function invoke(channel) {
    var args = Array.prototype.slice.call(arguments, 1);
    var res = await fetch("/api/invoke", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: channel, args: args })
    });
    if (res.status === 401) {
      clearToken();
      closeWs();
      showLogin();
      throw new Error("unauthorized");
    }
    var json = await res.json();
    if (!json.ok) throw new Error(json.error || "invoke failed: " + channel);
    return json.result;
  }

  function noopUnsub() {
    return function () {};
  }

  var ws = null;
  var wsConnecting = false;
  var wsStopped = false;
  var subscribers = new Map();

  function closeWs() {
    wsStopped = true;
    try { if (ws) ws.close(); } catch (e) {}
    ws = null;
    wsConnecting = false;
  }

  function openWs() {
    if (ws || wsConnecting || wsStopped) return;
    wsConnecting = true;
    try {
      var proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(proto + "//" + location.host + "/ws");
      ws.onopen = function () {
        wsConnecting = false;
        ws.send(JSON.stringify({ type: "auth", token: getToken() }));
      };
      ws.onmessage = function (ev) {
        try {
          var msg = JSON.parse(ev.data);
          if (msg.channel) {
            var set = subscribers.get(msg.channel);
            if (set) set.forEach(function (cb) { try { cb(msg.payload); } catch (e) {} });
          }
        } catch (e) {}
      };
      ws.onclose = function (ev) {
        ws = null;
        wsConnecting = false;
        // 1008 means the server rejected or revoked this session. Retrying
        // would spin forever against a token that can never authenticate.
        if (ev && ev.code === 1008) {
          clearToken();
          showLogin();
          return;
        }
        if (!wsStopped) setTimeout(openWs, 2500);
      };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    } catch (e) {
      ws = null;
      wsConnecting = false;
      if (!wsStopped) setTimeout(openWs, 2500);
    }
  }

  function subscribe(channel, cb) {
    if (!subscribers.has(channel)) subscribers.set(channel, new Set());
    subscribers.get(channel).add(cb);
    openWs();
    return function () {
      var s = subscribers.get(channel);
      if (s) s.delete(cb);
    };
  }

  var ATTACHMENT_ACCEPT = [
    ".png", ".jpg", ".jpeg", ".webp", ".gif",
    ".pdf",
    ".txt", ".md", ".json", ".csv", ".log",
    ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".php",
    ".html", ".css", ".scss", ".yaml", ".yml", ".toml", ".xml", ".sh",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"
  ].join(",");

  function pickAttachmentFiles() {
    return new Promise(function (resolve) {
      var input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = ATTACHMENT_ACCEPT;
      input.style.position = "fixed";
      input.style.left = "-9999px";
      input.style.top = "0";
      input.addEventListener("change", function () {
        var list = [];
        if (input.files) {
          for (var i = 0; i < input.files.length; i++) list.push(input.files[i]);
        }
        resolve(list);
      });
      input.click();
    });
  }

  window.freebuddy = {
    platform: "web",
    arch: "web",
    versions: { chrome: "", electron: "", node: "" },
    appVersion: "",
    sessionToken: function () { return getToken(); },

    cli: {
      listAdapters: function () { return invoke("cli:listAdapters"); },
      listOverrides: function () { return invoke("cli:listOverrides"); },
      upsertOverride: function (o) { return invoke("cli:upsertOverride", o); },
      resetOverride: function (id) { return invoke("cli:resetOverride", id); },

      listRuntimes: function () { return invoke("cli:listRuntimes"); },
      onRuntimeUpdated: function (cb) { return subscribe("cli://runtime", cb); },
      onConversationsChanged: function (cb) { return subscribe("conversations://changed", cb); },
      onMessagesChanged: function (cb) {
        return subscribe("messages://changed", function (p) { if (p && p.conversationId) cb(p.conversationId); });
      },
      codexUsage: function () { return invoke("cli:codexUsage"); },
      usageSummary: function (period) { return invoke("cli:usageSummary", period); },
      refreshUsage: function (period) { return invoke("cli:refreshUsage", period); },
      cursorUsageStatus: function () { return invoke("cli:cursorUsageStatus"); },
      connectCursorUsage: function (input) { return invoke("cli:connectCursorUsage", input); },
      disconnectCursorUsage: function () { return invoke("cli:disconnectCursorUsage"); },
      openCursorUsageSettings: function () { return invoke("cli:openCursorUsageSettings"); },
      probeAuthentication: function (args) { return invoke("cli:probeAuthentication", args); },
      logout: function (args) { return invoke("cli:logout", args); },
      check: function (adapter, binary, env, runtimeAdapter) {
        return invoke("cli:check", { adapter: adapter, binary: binary, env: env, runtimeAdapter: runtimeAdapter });
      },
      install: function (adapter, command) { return invoke("cli:install", { adapter: adapter, command: command }); },
      installStream: function () { return noopUnsub(); },

      run: function (args) { return invoke("cli:run", args); },
      getCachedSessionConfigOptions: function (args) { return invoke("cli:getCachedSessionConfigOptions", args); },
      inspectSessionConfigOptions: function (args) { return invoke("cli:inspectSessionConfigOptions", args); },
      kill: function (sessionId) { return invoke("cli:kill", sessionId); },
      permissionDecision: function (args) { return invoke("cli:permissionDecision", args); },
      authenticationDecision: function (args) { return invoke("cli:authenticationDecision", args); },
      authenticationTerminalInput: function (args) { return invoke("cli:authenticationTerminalInput", args); },
      authenticationTerminalCancel: function (args) { return invoke("cli:authenticationTerminalCancel", args); },

      listTasks: function (args) { return invoke("cli:listTasks", args); },
      getTask: function (id) { return invoke("cli:getTask", id); },
      readTaskLog: function (args) { return invoke("cli:readTaskLog", args); },

      getToolSession: function (agentId, workspacePath) { return invoke("cli:getToolSession", { agentId: agentId, workspacePath: workspacePath }); },
      saveToolSession: function (args) { return invoke("cli:saveToolSession", args); },

      listProjects: function () { return invoke("cli:listProjects"); },
      getProject: function (id) { return invoke("cli:getProject", id); },
      createProject: function (input) { return invoke("cli:createProject", input); },
      ensureProjectForCwd: function (cwd) { return invoke("cli:ensureProjectForCwd", cwd); },
      updateProject: function (input) { return invoke("cli:updateProject", input); },
      deleteProject: function (id) { return invoke("cli:deleteProject", id); },
      importCodexSession: function () { return Promise.resolve({ created: false, turns: 0, messages: 0 }); },

      listConversations: function (args) { return invoke("cli:listConversations", args); },
      getConversation: function (id) { return invoke("cli:getConversation", id); },
      createConversation: function (input) { return invoke("cli:createConversation", input); },
      previewHandoffBrief: function (input) { return invoke("cli:previewHandoffBrief", input); },
      transferConversation: function (input) { return invoke("cli:transferConversation", input); },
      createConversationShare: function (input) { return invoke("cli:createConversationShare", input); },
      attachConversationShares: function (input) { return invoke("cli:attachConversationShares", input); },
      listConversationContextReferences: function (conversationId) { return invoke("cli:listConversationContextReferences", conversationId); },
      removeConversationContextReference: function (input) { return invoke("cli:removeConversationContextReference", input); },
      renameConversation: function (id, title, titleSource) { return invoke("cli:renameConversation", { id: id, title: title, titleSource: titleSource }); },
      updateConversationAgentName: function (agentId, agentName) { return invoke("cli:updateConversationAgentName", { agentId: agentId, agentName: agentName }); },
      archiveConversation: function (id, archived) { return invoke("cli:archiveConversation", { id: id, archived: archived }); },
      deleteConversation: function (id) { return invoke("cli:deleteConversation", id); },
      setConversationApprovalMode: function (id, approvalMode) { return invoke("cli:setConversationApprovalMode", { id: id, approvalMode: approvalMode }); },
      setConversationConfigOptionOverrides: function (id, overrides) { return invoke("cli:setConversationConfigOptionOverrides", { id: id, overrides: overrides }); },
      setConversationSkills: function (id, skillIds) { return invoke("cli:setConversationSkills", { id: id, skillIds: skillIds }); },
      listMessages: function (conversationId) { return invoke("cli:listMessages", conversationId); },
      listMessage: function (id) { return invoke("cli:listMessage", id); },
      appendMessage: function (input) { return invoke("cli:appendMessage", input); },
      updateMessage: function (input) { return invoke("cli:updateMessage", input); },

      selectDirectory: function () { return Promise.resolve(null); },
      searchWorkspaceFiles: function (cwd, query, limit) { return invoke("cli:searchWorkspaceFiles", { cwd: cwd, query: query, limit: limit }); },
      selectAttachments: async function () {
        var files = await pickAttachmentFiles();
        if (!files || files.length === 0) return [];
        var prepared = await window.freebuddy.cli.prepareAttachmentFiles(files);
        return (prepared && prepared.candidates) || [];
      },
      prepareAttachmentFiles: async function (files) {
        var rejections = [];
        var payload = [];
        for (var i = 0; i < files.length; i++) {
          var f = files[i];
          if (f.size > 50 * 1024 * 1024) {
            rejections.push({ name: f.name || "file", reason: "file_too_large" });
            continue;
          }
          try {
            var b64 = await new Promise(function (resolve, reject) {
              var r = new FileReader();
              r.onload = function () {
                var idx = r.result.indexOf(",");
                resolve(idx >= 0 ? r.result.slice(idx + 1) : r.result);
              };
              r.onerror = function () { reject(new Error("read_failed")); };
              r.readAsDataURL(f);
            });
            payload.push({
              name: f.name || "file",
              mimeType: f.type || "application/octet-stream",
              data: b64
            });
          } catch (e) {
            rejections.push({ name: f.name || "file", reason: "unsupported_type" });
          }
        }
        if (!payload.length) {
          return { candidates: [], rejections: rejections };
        }
        var res = await postJson("/api/upload", { files: payload });
        if (res && res.ok && res.result) {
          return {
            candidates: res.result.candidates || [],
            rejections: (res.result.rejections || []).concat(rejections)
          };
        }
        return { candidates: [], rejections: rejections };
      },
      discardManagedAttachment: function (filePath) { return invoke("cli:discardManagedAttachment", filePath); },
      discardManagedAttachmentIfUnreferenced: function (filePath) { return invoke("cli:discardManagedAttachmentIfUnreferenced", filePath); },
      discardManagedAttachments: function () {},

      resolveBrowserEntry: function (cwd) { return invoke("cli:resolveBrowserEntry", cwd); },
      readBrowserMarkdown: function (cwd, rel) { return invoke("cli:readBrowserMarkdown", { cwd: cwd, rel: rel }); },
      openBrowserExternal: function () { return Promise.resolve(true); },

      ensureAgentGuides: function (cwd, options) { return invoke("cli:ensureAgentGuides", { cwd: cwd, options: options }); },

      onEvent: function (sessionId, cb) { return subscribe("cli://" + sessionId, cb); }
    },

    window: {
      onChromeVisible: function (cb) { return subscribe("window:chrome", cb); },
      onBridge: function (cb) { return subscribe("freebuddy://bridge", cb); },
      onBrowserTool: function (cb) { return subscribe("freebuddy://browser-tool", cb); },
      resolveBrowserTool: function (resolution) { return invoke("browser-tool:resolve", resolution); }
    },

    session: {
      logout: function () {
        // The session cookie is HttpOnly, so only the server can retire it.
        // Clearing the local token alone would leave the browser signed in.
        return fetch("/api/logout", { method: "POST", headers: authHeaders() })
          .catch(function () {})
          .then(function () {
            clearToken();
            closeWs();
            showLogin();
          });
      }
    },

    settings: {
      getSetting: function (key) { return invoke("settings:get", key); },
      setSetting: function (key, value) { return invoke("settings:set", { key: key, value: value }); }
    },

    feed: {
      listSources: function () { return invoke("feed:listSources"); },
      addSource: function (input) { return invoke("feed:addSource", input); },
      updateSource: function (input) { return invoke("feed:updateSource", input); },
      deleteSource: function (id) { return invoke("feed:deleteSource", id); },
      listItems: function (args) { return invoke("feed:listItems", args); },
      refreshSource: function (id) { return invoke("feed:refreshSource", id); },
      refreshAll: function () { return invoke("feed:refreshAll"); },
      markInterpreted: function (id) { return invoke("feed:markInterpreted", id); }
    },

    infoCards: {
      list: function () { return invoke("infoCards:list"); },
      create: function (input) { return invoke("infoCards:create", input); },
      update: function (input) { return invoke("infoCards:update", input); },
      delete: function (id) { return invoke("infoCards:delete", id); },
      reorder: function (ids) { return invoke("infoCards:reorder", ids); },
      snapshot: function (id) { return invoke("infoCards:snapshot", id); },
      refresh: function (id, timeZone) { return invoke("infoCards:refresh", id, timeZone); },
      marketProvider: function () { return invoke("infoCards:marketProvider"); },
      searchMarketSymbols: function (query) { return invoke("infoCards:searchMarketSymbols", query); },
      onChanged: function (cb) { return subscribe("infoCards://changed", cb); }
    },

    delegation: {
      listTeams: function () { return invoke("delegation:listTeams"); },
      getTeam: function (id) { return invoke("delegation:getTeam", id); },
      createTeam: function (input) { return invoke("delegation:createTeam", input); },
      updateTeam: function (id, patch) { return invoke("delegation:updateTeam", { id: id, patch: patch }); },
      deleteTeam: function (id) { return invoke("delegation:deleteTeam", id); },
      getRun: function (id) { return invoke("delegation:getRun", id); },
      getRunByConversation: function (conversationId) { return invoke("delegation:getRunByConversation", conversationId); },
      listEvents: function (runId) { return invoke("delegation:listEvents", runId); },
      listPendingApprovals: function (runId) { return invoke("delegation:listPendingApprovals", runId); },
      stopRun: function (runId) { return invoke("delegation:stopRun", runId); },
      pauseRun: function () { return Promise.resolve(false); },
      resumeRun: function () { return Promise.resolve(false); },
      hasRunForConversation: function (conversationId) { return invoke("delegation:hasRunForConversation", conversationId); },
      followUp: function (input) { return invoke("delegation:followUp", input); },
      onChanged: function (cb) { return subscribe("delegationTeams://changed", cb); },
      onRunFinished: function (cb) { return subscribe("delegation://finished", cb); }
    },

    workflow: {
      validate: function (plan) { return invoke("workflow:validate", plan); },
      previewReviewLoop: function (input) { return invoke("workflow:previewReviewLoop", input); },
      coordinatorPrompt: function (input) { return invoke("workflow:coordinatorPrompt", input); },
      createRun: function (input) { return invoke("workflow:createRun", input); },
      start: function (runId) { return invoke("workflow:start", runId); },
      pause: function (runId) { return invoke("workflow:pause", runId); },
      resume: function (runId) { return invoke("workflow:resume", runId); },
      stop: function (runId) { return invoke("workflow:stop", runId); },
      retryStep: function (args) { return invoke("workflow:retryStep", args); },
      approveGate: function (args) { return invoke("workflow:approveGate", args); },
      requestGateChanges: function (args) { return invoke("workflow:requestGateChanges", args); },
      continueImplementReview: function (runId) { return invoke("workflow:continueImplementReview", runId); },
      getRun: function (runId) { return invoke("workflow:getRun", runId); },
      listActiveRuns: function () { return invoke("workflow:listActiveRuns"); },
      getSteps: function (runId) { return invoke("workflow:getSteps", runId); },
      listRuns: function (conversationId) { return invoke("workflow:listRuns", conversationId); },
      previewTeamRun: function (input) { return invoke("workflow:previewTeamRun", input); },
      createTeamRun: function (input) { return invoke("workflow:createTeamRun", input); },
      onStepMessage: function (conversationId, cb) { return subscribe("workflow://message/" + conversationId, cb); },
      onStepEvent: function (conversationId, cb) { return subscribe("workflow://event/" + conversationId, cb); },
      onRunFinished: function (cb) { return subscribe("workflow://finished", cb); }
    },

    workflowTeams: {
      list: function () { return invoke("workflowTeams:list"); },
      get: function (id) { return invoke("workflowTeams:get", id); },
      create: function (input) { return invoke("workflowTeams:create", input); },
      update: function (args) { return invoke("workflowTeams:update", args); },
      delete: function (id) { return invoke("workflowTeams:delete", id); },
      seedBuiltins: function () { return invoke("workflowTeams:seedBuiltins"); },
      onChanged: function (cb) { return subscribe("workflowTeams://changed", cb); }
    },

    skills: {
      list: function () { return invoke("skills:list"); },
      import: function () { return Promise.resolve(null); },
      setEnabled: function (id, enabled) { return invoke("skills:setEnabled", id, enabled); },
      setTrusted: function (id, trusted) { return invoke("skills:setTrusted", id, trusted); },
      delete: function (id) { return invoke("skills:delete", id); },
      read: function (id) { return invoke("skills:read", id); },
      selectDirectory: function () { return Promise.resolve(null); },
      selectArchive: function () { return Promise.resolve(null); },
      reveal: function () { return Promise.resolve(false); },
      marketProviders: function () { return invoke("skills:marketProviders"); },
      getMarketProvider: function () { return invoke("skills:getMarketProvider"); },
      setMarketProvider: function (provider) { return invoke("skills:setMarketProvider", provider); },
      searchMarket: function (args) { return invoke("skills:searchMarket", args); },
      installFromMarket: function () { return Promise.resolve({ ok: false, error: "not_supported_remotely" }); },
      openMarketUrl: function () { return Promise.resolve(true); },
      resolveMarketHomepage: function (args) { return invoke("skills:resolveMarketHomepage", args); },
      onChanged: function (cb) { return subscribe("skills://changed", cb); }
    },

    plugins: {
      list: function (agent) { return invoke("plugins:list", agent); },
      install: function () { return Promise.resolve({ ok: false, error: "not_supported_remotely" }); },
      update: function () { return Promise.resolve({ ok: false, error: "not_supported_remotely" }); },
      uninstall: function () { return Promise.resolve({ ok: false, error: "not_supported_remotely" }); },
      addMarketplace: function () { return Promise.resolve({ ok: false, error: "not_supported_remotely" }); },
      updateMarketplace: function () { return Promise.resolve({ ok: false, error: "not_supported_remotely" }); },
      removeMarketplace: function () { return Promise.resolve({ ok: false, error: "not_supported_remotely" }); }
    },

    scheduledTasks: {
      list: function () { return invoke("scheduledTasks:list"); },
      listRuns: function (taskId) { return invoke("scheduledTasks:listRuns", taskId); },
      listAgents: function () { return invoke("scheduledTasks:listAgents"); },
      create: function (input) { return invoke("scheduledTasks:create", input); },
      update: function (args) { return invoke("scheduledTasks:update", args); },
      delete: function (id) { return invoke("scheduledTasks:delete", id); },
      run: function (id) { return invoke("scheduledTasks:run", id); },
      onChanged: function (cb) { return subscribe("scheduledTasks://changed", cb); }
    },

    updater: {
      getVersion: function () { return invoke("app:getVersion"); },
      check: function () { return Promise.resolve({ ok: true, available: false, version: null }); },
      download: function () { return Promise.resolve({ ok: true }); },
      quitAndInstall: function () { return Promise.resolve(true); },
      onEvent: function (cb) { return subscribe("updater://event", cb); }
    },

    shell: {
      showItemInFolder: function () { return Promise.resolve(false); }
    },

    debugLogs: {
      write: function () { return Promise.resolve(); },
      preview: function () { return Promise.resolve(""); },
      prepareSelfCheck: function () { return Promise.resolve({ path: "" }); },
      export: function () { return Promise.resolve({ canceled: true }); }
    },

    butlerBuddy: {
      reportTaskResult: function () {},
      updatePreferences: function () { return Promise.resolve(); },
      onPreferencesChanged: function () { return noopUnsub(); }
    },

    game: {
      getState: function (conversationId) { return invoke("game:getState", conversationId); },
      playerMove: function (conversationId, actionId) {
        return invoke("game:playerMove", { conversationId: conversationId, actionId: actionId });
      },
      agentMove: function (conversationId, actionId, reason, speech, mood) {
        return invoke("game:agentMove", {
          conversationId: conversationId,
          actionId: actionId,
          reason: reason,
          speech: speech,
          mood: mood
        });
      },
      sendChat: function (conversationId, message, mood) {
        return invoke("game:sendChat", {
          conversationId: conversationId,
          message: message,
          mood: mood
        });
      },
      resetGame: function (conversationId) { return invoke("game:resetGame", conversationId); },
      playerResign: function (conversationId) { return invoke("game:playerResign", conversationId); },
      onGameEvent: function (cb) { return subscribe("freebuddy://game-event", cb); }
    },

    remote: {
      whoami: function () { return invoke("remote:whoami"); },
      getStatus: function () { return invoke("remote:getStatus"); },
      setEnabled: function () { return Promise.resolve({ status: null, initialPassword: null }); },
      listUsers: function () { return Promise.resolve([]); },
      createUser: function () { return Promise.resolve({ user: { id: "", username: "", isOwner: false, createdAt: 0 }, password: "" }); },
      resetUserPassword: function () { return Promise.resolve(null); },
      deleteUser: function () { return Promise.resolve(false); },
      listUserRoots: function () { return Promise.resolve([]); },
      setUserRoots: function () { return Promise.resolve([]); }
    }
  };

  var LOGIN_LANG = null;
  var LOGIN_I18N = {
    en: {
      title: "Shared access login",
      username: "Username",
      password: "Password",
      signin: "Sign in",
      signing: "Signing in...",
      failed: "Login failed",
      invalid_credentials: "Wrong username or password",
      remote_not_initialized: "Shared access is not set up yet",
      too_many_attempts: "Too many attempts. Try again later."
    },
    zh: {
      title: "共享访问登录",
      username: "用户名",
      password: "密码",
      signin: "登录",
      signing: "登录中…",
      failed: "登录失败",
      invalid_credentials: "用户名或密码错误",
      remote_not_initialized: "共享访问尚未配置",
      too_many_attempts: "尝试次数过多，请稍后再试。"
    }
  };

  function browserLoginLang() {
    var tag = navigator.language || navigator.userLanguage || "en";
    return String(tag).toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
  }

  function normalizeLoginLang(value) {
    if (!value) return null;
    var v = String(value).toLowerCase();
    if (v.indexOf("zh") === 0) return "zh";
    if (v === "en" || v.indexOf("en-") === 0) return "en";
    return null;
  }

  async function resolveLoginLang() {
    if (LOGIN_LANG) return LOGIN_LANG;
    try {
      var res = await fetch("/api/status");
      var json = await res.json();
      LOGIN_LANG = normalizeLoginLang(json && json.language) || browserLoginLang();
    } catch (e) {
      LOGIN_LANG = browserLoginLang();
    }
    try {
      document.documentElement.lang = LOGIN_LANG === "zh" ? "zh-CN" : "en";
    } catch (e) {}
    return LOGIN_LANG;
  }

  function loginT(key) {
    var lang = LOGIN_LANG || browserLoginLang();
    var dict = LOGIN_I18N[lang] || LOGIN_I18N.en;
    return dict[key] || LOGIN_I18N.en[key] || key;
  }

  function loginErrorMessage(code) {
    var lang = LOGIN_LANG || browserLoginLang();
    var dict = LOGIN_I18N[lang] || LOGIN_I18N.en;
    if (code && dict[code]) return dict[code];
    return code || dict.failed;
  }

  async function showLogin(message) {
    if (document.getElementById("fb-login-root")) return;
    await resolveLoginLang();
    var root = document.createElement("div");
    root.id = "fb-login-root";
    root.style.cssText =
      "position:fixed;inset:0;background:#0b1329;display:flex;align-items:center;justify-content:center;z-index:99999;font-family:system-ui,-apple-system,\"PingFang SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",sans-serif;";
    root.innerHTML =
      '<div style="width:320px;padding:28px;background:#131c36;border:1px solid #243154;border-radius:14px;color:#e6ebf5;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,0.4);">' +
      '<div style="font-size:20px;font-weight:700;margin-bottom:4px;">FreeBuddy</div>' +
      '<div style="font-size:13px;color:#8b97b8;margin-bottom:18px;">' + (message || loginT("title")) + "</div>" +
      '<input id="fb-login-user" type="text" placeholder="' + loginT("username") + '" autocomplete="username" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2c3a5e;background:#0b1329;color:#e6ebf5;font-size:14px;margin-bottom:10px;outline:none;" />' +
      '<input id="fb-login-pw" type="password" placeholder="' + loginT("password") + '" autocomplete="current-password" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2c3a5e;background:#0b1329;color:#e6ebf5;font-size:14px;margin-bottom:12px;outline:none;" />' +
      '<button id="fb-login-btn" style="width:100%;padding:10px;border-radius:8px;border:none;background:#10b981;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">' + loginT("signin") + "</button>" +
      '<div id="fb-login-err" style="color:#ff6b6b;font-size:12px;margin-top:10px;min-height:16px;"></div>' +
      "</div>";
    if (document.body) document.body.appendChild(root);
    else document.documentElement.appendChild(root);
    var btn = root.querySelector("#fb-login-btn");
    var userInput = root.querySelector("#fb-login-user");
    var input = root.querySelector("#fb-login-pw");
    var err = root.querySelector("#fb-login-err");
    function doLogin() {
      err.textContent = "";
      btn.disabled = true;
      btn.textContent = loginT("signing");
      postJson("/api/login", { username: userInput.value, password: input.value }).then(function (json) {
        if (json.ok) {
          setToken(json.token);
          location.reload();
        } else {
          err.textContent = loginErrorMessage(json.error);
          btn.disabled = false;
          btn.textContent = loginT("signin");
        }
      }).catch(function (e) {
        err.textContent = String(e);
        btn.disabled = false;
        btn.textContent = loginT("signin");
      });
    }
    btn.addEventListener("click", doLogin);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") doLogin(); });
    userInput.addEventListener("keydown", function (e) { if (e.key === "Enter") input.focus(); });
    setTimeout(function () { userInput.focus(); }, 0);
  }

  async function syncSessionCookie() {
    var token = getToken();
    if (!token) return;
    try {
      await fetch("/api/session-cookie", {
        method: "POST",
        headers: authHeaders()
      });
    } catch (e) {
      // Cookie sync is best-effort; media URLs also pass ?token=.
    }
  }

  async function bootstrap() {
    if (!getToken()) {
      await showLogin();
      return;
    }
    await syncSessionCookie();
  }

  void bootstrap();
})();
