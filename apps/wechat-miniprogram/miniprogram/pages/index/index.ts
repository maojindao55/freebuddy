/**
 * Connect page (route `pages/index/index`).
 *
 * Thin adapter: it owns the WeChat input events and forwards everything else to
 * `./controller`. The token field is `password`-masked, is never re-read after being committed,
 * and is explicitly emptied on `onHide`/`onUnload` so the value does not linger in page data.
 */

import { getPageRuntime, type DatasetEventLike, type InputEventLike } from "../../platform/pageRuntime";
import { getAppSession } from "../../services/appSession";
import { createLoginController, type LoginController, type LoginPageData } from "./controller";

type PageData = LoginPageData & {
  readonly tokenField: string;
  readonly hostIdInput: string;
};

Page({
  data: {
    tokenField: "",
    hostIdInput: "",
    title: "",
    message: "",
    wechatActionLabel: "",
    wechatActionEnabled: false,
    environment: "",
    banner: {
      status: "signedOut",
      tone: "neutral",
      label: "",
      detail: "",
      canReconnect: false,
      needsCredential: true,
      terminal: true
    },
    bannerDetail: "",
    devVisible: false,
    devAvailable: false,
    devArmed: false,
    devBlockMessage: "",
    devHostId: "",
    devHasHostId: false,
    devHasToken: false,
    devTokenMask: "",
    devNotice: "",
    devSocketUrl: "",
    canSaveToken: false,
    canConnect: false,
    canSignOut: false,
    canEnterConsole: false,
    tokenFieldHint: ""
  } as PageData,

  controller: null as LoginController | null,

  onLoad() {
    const session = getAppSession();
    this.controller = createLoginController({
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
    // Never leave a typed credential in page data once the page is not visible.
    this.setData({ tokenField: "" });
  },

  onUnload() {
    this.controller?.stop();
    this.setData({ tokenField: "" });
  },

  onToggleArm(_event: DatasetEventLike) {
    this.controller?.toggleArm();
  },

  onHostIdInput(event: InputEventLike) {
    const value = typeof event.detail.value === "string" ? event.detail.value : "";
    this.setData({ hostIdInput: value });
    this.controller?.setHostId(value);
  },

  onTokenInput(event: InputEventLike) {
    this.setData({ tokenField: typeof event.detail.value === "string" ? event.detail.value : "" });
  },

  onSaveToken(_event: DatasetEventLike) {
    this.controller?.commitToken(this.data.tokenField);
    // Clear the field: the controller already moved the value into memory.
    this.setData({ tokenField: "" });
  },

  onConnect(_event: DatasetEventLike) {
    this.controller?.connect();
  },

  onEnterConsole(_event: DatasetEventLike) {
    this.controller?.openHome();
  },

  onSignOut(_event: DatasetEventLike) {
    this.controller?.signOut();
  },

  onWechatLogin(_event: DatasetEventLike) {
    this.controller?.wechatLogin();
  }
});
