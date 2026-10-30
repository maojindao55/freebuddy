import test from "node:test";
import assert from "node:assert/strict";

import {
  registerDocStudioMainWindow,
  unregisterDocStudioMainWindow,
  isDocStudioMainWindowSender,
  setDocStudioEmbeddedConversation,
  getDocStudioEmbeddedConversation,
  isDocStudioConversationEmbedded
} from "../dist-electron/docStudioWindowRegistry.js";

// The embedded-state registry is what open-conversation routing consults, so
// docking, switching and main-window teardown must leave it exact.
test("embedded doc conversation state tracks docking and clears with the main window", () => {
  // Baseline: nothing docked.
  assert.equal(getDocStudioEmbeddedConversation(), null);
  assert.equal(isDocStudioConversationEmbedded("conv-1"), false);

  setDocStudioEmbeddedConversation("conv-1");
  assert.equal(getDocStudioEmbeddedConversation(), "conv-1");
  assert.equal(isDocStudioConversationEmbedded("conv-1"), true);
  assert.equal(isDocStudioConversationEmbedded("conv-2"), false);

  // Docking another conversation replaces the previous one.
  setDocStudioEmbeddedConversation("conv-2");
  assert.equal(isDocStudioConversationEmbedded("conv-1"), false);
  assert.equal(isDocStudioConversationEmbedded("conv-2"), true);

  // Undocking clears the state, and empty ids mean "nothing docked".
  setDocStudioEmbeddedConversation(null);
  assert.equal(getDocStudioEmbeddedConversation(), null);
  setDocStudioEmbeddedConversation("");
  assert.equal(getDocStudioEmbeddedConversation(), null);

  // Only the registered main window's webContents going away clears the dock;
  // an unrelated id must not disturb it.
  registerDocStudioMainWindow(4242);
  assert.equal(isDocStudioMainWindowSender({ id: 4242 }), true);
  setDocStudioEmbeddedConversation("conv-3");
  unregisterDocStudioMainWindow(9999);
  assert.equal(isDocStudioConversationEmbedded("conv-3"), true);
  unregisterDocStudioMainWindow(4242);
  assert.equal(isDocStudioMainWindowSender({ id: 4242 }), false);
  assert.equal(getDocStudioEmbeddedConversation(), null);
  assert.equal(isDocStudioConversationEmbedded("conv-3"), false);
});
