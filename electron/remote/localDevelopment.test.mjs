import assert from "node:assert/strict";
import test from "node:test";

import { startReadOnlyRemoteDevelopment } from "../../dist-electron/remote/localDevelopment.js";

test("read-only remote development cannot start from a packaged app", () => {
  const previous = new Map([
    ["FB_REMOTE_READONLY_DEV", process.env.FB_REMOTE_READONLY_DEV],
    ["FB_REMOTE_DEV_ENDPOINT", process.env.FB_REMOTE_DEV_ENDPOINT],
    ["FB_REMOTE_DEV_HOST_TOKEN", process.env.FB_REMOTE_DEV_HOST_TOKEN],
    ["FB_REMOTE_DEV_HOST_ID", process.env.FB_REMOTE_DEV_HOST_ID]
  ]);
  process.env.FB_REMOTE_READONLY_DEV = "1";
  process.env.FB_REMOTE_DEV_ENDPOINT = "ws://127.0.0.1:8080/v1/ws/host";
  process.env.FB_REMOTE_DEV_HOST_TOKEN = "test-host-token";
  process.env.FB_REMOTE_DEV_HOST_ID = "host_packaged_test";
  try {
    assert.equal(startReadOnlyRemoteDevelopment({ isPackaged: true }), undefined);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
