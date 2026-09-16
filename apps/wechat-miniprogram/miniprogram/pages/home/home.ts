/**
 * Home page (route `pages/home/home`).
 *
 * Single-host overview. Subscribes on `onShow`, unsubscribes on `onHide`/`onUnload`; the App
 * session keeps the socket and the cursors alive across that.
 */

import { getPageRuntime, type DatasetEventLike } from "../../platform/pageRuntime";
import { getAppSession } from "../../services/appSession";
import { createHomeController, type HomeController, type HomePageData } from "./controller";

Page({
  data: {
    banner: {
      status: "signedOut",
      tone: "neutral",
      label: "",
      detail: "",
      canReconnect: false,
      needsCredential: true,
      terminal: true
    },
    environment: "",
    hasHost: false,
    hostTitle: "",
    hostSubtitle: "",
    hostTone: "neutral",
    remoteEnabled: false,
    metrics: [],
    projects: [],
    pendingDecisions: [],
    activeTasks: [],
    hasPendingDecisions: false,
    credentialNotice: "",
    isDevConnection: false,
    hostStatusError: null
  } as HomePageData,

  controller: null as HomeController | null,

  onLoad() {
    const session = getAppSession();
    this.controller = createHomeController({
      connection: session.connection,
      dev: session.dev,
      runtime: getPageRuntime(),
      environmentName: session.environment.name,
      setData: (data) => this.setData(data)
    });
  },

  onShow() {
    this.controller?.start();
  },

  onHide() {
    this.controller?.stop();
  },

  onUnload() {
    this.controller?.stop();
  },

  onReconnect(_event: DatasetEventLike) {
    this.controller?.reconnect();
  },

  onOpenConversations(_event: DatasetEventLike) {
    this.controller?.openConversations();
  },

  onLogout(_event: DatasetEventLike) {
    this.controller?.logout();
  }
});
