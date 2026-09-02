/**
 * App entry point.
 *
 * W1 scope: prove the scaffold boots, the generated protocol binding matches this build, the
 * environment table satisfies the transport constraints, and failures are contained by the
 * error boundary. Authentication, sockets and RPC arrive in W2+.
 */

import { ENVIRONMENTS } from "./config/environments";
import { assertEnvironmentTable, getActiveEnvironment } from "./config/runtimeConfig";
import { assertProtocolBinding, REMOTE_PROTOCOL_VERSION } from "./protocol";
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
