/**
 * App entry point.
 *
 * Responsible for exactly three things:
 *
 * 1. Fail fast at boot when the generated protocol binding drifted or the environment table would
 *    weaken transport security.
 * 2. Own the App-scoped session (`services/appSession.ts`): the single socket, the single network
 *    listener and the recovery state that must outlive every page. `onLaunch` registers the
 *    listener; `onShow`/`onHide` tell the session the process went to the background and back,
 *    which is when WeChat may have reclaimed the socket or frozen the process.
 * 3. Contain failures: `onError`, `onUnhandledRejection` and `onPageNotFound` are routed to the
 *    error boundary, which never rethrows and always redacts.
 *
 * Nothing here authenticates: there is no `wx.login`, no code exchange and no token. The only
 * credential this stage can hold is the DEV operator token entered on the connect page.
 */

import { ENVIRONMENTS } from "./config/environments";
import { assertEnvironmentTable, getActiveEnvironment } from "./config/runtimeConfig";
// Explicit `/index`: the WeChat loader appends `.js` and does **not** resolve a directory to its
// `index.js` the way Node does, so `import ... from "./protocol"` emits `require("./protocol")`
// and fails at runtime with `module 'protocol.js' is not defined`. `emit:check` guards this.
import { assertProtocolBinding, REMOTE_PROTOCOL_VERSION } from "./protocol/index";
import { getAppSession } from "./services/appSession";
import { createAppErrorBoundary } from "./utils/errorBoundary";

// Fail fast on a drifted protocol binding or an unsafe environment table.
assertEnvironmentTable(Object.values(ENVIRONMENTS));
assertProtocolBinding();

const environment = getActiveEnvironment();
const boundary = createAppErrorBoundary(environment.debugLogging);

App({
  globalData: {
    environment: environment.name,
    protocolVersion: REMOTE_PROTOCOL_VERSION
  },

  onLaunch() {
    // Register the single network listener now. Nothing connects yet: without a credential the
    // socket layer stays `signedOut`, which is exactly what the connect page reports.
    boundary.run("app.onLaunch", () => getAppSession().start(), undefined);
  },

  onShow() {
    // A backgrounded mini program must not assume its socket survived: this re-proves liveness or
    // reconnects, and never stacks a second reconnect timer.
    boundary.run("app.onShow", () => getAppSession().onShow(), undefined);
  },

  onHide() {
    // The process may be frozen or reclaimed from here, so the cursor is persisted first.
    boundary.run("app.onHide", () => getAppSession().onHide(), undefined);
  },

  onError(error: string) {
    boundary.handleError("app.onError", error);
  },

  onUnhandledRejection(reason: unknown) {
    boundary.handleUnhandledRejection(reason);
  },

  onPageNotFound(info: unknown) {
    boundary.handleError("app.onPageNotFound", info);
  }
});
