import { getActiveEnvironment } from "../../config/runtimeConfig";
import { getLoginPlaceholderView } from "../../services/loginPlaceholder";

interface IndexPageData {
  title: string;
  message: string;
  actionLabel: string;
  actionEnabled: boolean;
  environment: string;
}

Page({
  data: {
    title: "",
    message: "",
    actionLabel: "",
    actionEnabled: false,
    environment: ""
  } as IndexPageData,

  onLoad() {
    const view = getLoginPlaceholderView();
    this.setData({
      title: view.title,
      message: view.message,
      actionLabel: view.actionLabel,
      actionEnabled: view.actionEnabled,
      environment: getActiveEnvironment().name
    });
  },

  onPlaceholderAction() {
    // W1 intentionally does nothing: admin login is implemented in W2 via the Relay
    // /v1/auth/wechat endpoint. No code exchange, no token, no storage write happens here.
  }
});
