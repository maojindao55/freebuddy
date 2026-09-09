/**
 * Tiny client for the FreeBuddy <-> freebie page postMessage bridge (v1).
 *
 * The page never receives or sends secrets: `importAgent` only ships a provider
 * preset, and FreeBuddy asks the user for the API key in a native dialog.
 *
 * Outbound messages use targetOrigin "*" because the FreeBuddy renderer runs
 * from file:// in packaged builds and therefore has an opaque origin. Every
 * payload is public data, so that is acceptable. Inbound messages are accepted
 * only from `window.parent`.
 */
(function (global) {
  "use strict";

  const SOURCE = "freebuddy-freebie";
  const PROTOCOL_VERSION = 1;
  const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // import waits for the user to type a key

  function createBridge() {
    const embedded = global.parent && global.parent !== global;
    const pending = new Map();
    const listeners = { hello: new Set(), state: new Set() };
    let host = null;
    let seq = 0;

    function post(message) {
      if (!embedded) return;
      global.parent.postMessage(
        Object.assign({ source: SOURCE, protocolVersion: PROTOCOL_VERSION }, message),
        "*"
      );
    }

    function request(message) {
      const requestId = `${Date.now().toString(36)}-${(seq += 1)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("timeout"));
        }, REQUEST_TIMEOUT_MS);
        pending.set(requestId, { resolve, reject, timer });
        post(Object.assign({ requestId }, message));
      });
    }

    function emit(name, payload) {
      listeners[name].forEach((fn) => {
        try {
          fn(payload);
        } catch (err) {
          console.error("[freebuddy-bridge] listener failed", err);
        }
      });
    }

    global.addEventListener("message", (event) => {
      if (!embedded || event.source !== global.parent) return;
      const data = event.data;
      if (!data || typeof data !== "object" || data.source !== SOURCE) return;
      if (data.protocolVersion !== PROTOCOL_VERSION) return;

      if (data.type === "hello") {
        host = {
          locale: data.locale,
          theme: data.theme,
          platform: data.platform,
          importedProviderIds: data.importedProviderIds || [],
          runtimes: data.runtimes || {}
        };
        emit("hello", host);
        return;
      }
      if (data.type === "state") {
        if (host) {
          host.importedProviderIds = data.importedProviderIds || [];
          host.runtimes = data.runtimes || host.runtimes;
        }
        emit("state", {
          importedProviderIds: data.importedProviderIds || [],
          runtimes: data.runtimes || {}
        });
        return;
      }
      if (data.type === "result" && typeof data.requestId === "string") {
        const entry = pending.get(data.requestId);
        if (!entry) return;
        pending.delete(data.requestId);
        clearTimeout(entry.timer);
        if (data.ok) entry.resolve({ ok: true, agentId: data.agentId });
        else entry.resolve({ ok: false, error: data.error || "unknown" });
      }
    });

    return {
      /** True when the page is running inside an iframe (very likely FreeBuddy). */
      embedded,
      /** Host info after the handshake, or null. */
      get host() {
        return host;
      },
      /** Sends `ready`; resolves with host info or rejects after `timeoutMs` (default 3s). */
      connect(timeoutMs) {
        if (!embedded) return Promise.reject(new Error("not-embedded"));
        if (host) return Promise.resolve(host);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            listeners.hello.delete(onHello);
            reject(new Error("timeout"));
          }, timeoutMs || 3000);
          function onHello(info) {
            clearTimeout(timer);
            listeners.hello.delete(onHello);
            resolve(info);
          }
          listeners.hello.add(onHello);
          post({ type: "ready" });
        });
      },
      onHello(fn) {
        listeners.hello.add(fn);
        return () => listeners.hello.delete(fn);
      },
      onState(fn) {
        listeners.state.add(fn);
        return () => listeners.state.delete(fn);
      },
      /** Asks FreeBuddy to create a BYOK agent from `preset`. Resolves `{ ok, agentId | error }`. */
      importAgent(preset) {
        return request({ type: "importAgent", preset });
      },
      /** Opens an https URL in the user's system browser. */
      openExternal(url) {
        post({ type: "openExternal", url });
      },
      /** Re-requests imported providers / runtime availability; result arrives via onState. */
      refreshState() {
        post({ type: "getState", requestId: `state-${(seq += 1)}` });
      }
    };
  }

  global.FreeBuddyBridge = createBridge();
})(window);
