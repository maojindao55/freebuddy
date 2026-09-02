/**
 * W1 must ship a login screen that cannot pretend to authenticate: no `wx.login` call, no
 * code exchange, no token, no storage write.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getLoginPlaceholderView } from "../miniprogram/services/loginPlaceholder";
import { resetWechatApi, setWechatApi } from "../miniprogram/platform/wechatApiProvider";
import { createExplodingWechatApi } from "./helpers/fakeWechatApi";

describe("login placeholder", () => {
  test("the primary action is disabled", () => {
    const view = getLoginPlaceholderView();
    assert.equal(view.actionEnabled, false);
    assert.equal(view.status, "auth_not_implemented");
    assert.ok(view.title.length > 0);
    assert.ok(view.message.length > 0);
    assert.ok(view.actionLabel.length > 0);
  });

  test("the view exposes no credential material", () => {
    const serialized = JSON.stringify(getLoginPlaceholderView());
    assert.doesNotMatch(serialized, /token|secret|openid|appsecret|authorization|bearer/i);
    assert.doesNotMatch(serialized, /https?:\/\//);
  });

  test("building the view never touches the WeChat API", (t) => {
    t.after(() => resetWechatApi());

    const api = createExplodingWechatApi();
    setWechatApi(api);

    assert.doesNotThrow(() => getLoginPlaceholderView());
    assert.deepEqual(api.calls, []);
  });
});
