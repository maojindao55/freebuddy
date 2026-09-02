/**
 * Injection point for the WeChat API adapter.
 *
 * `getWechatApi()` is the only way production code reaches `wx`. Tests call
 * `setWechatApi()` with a fake and `resetWechatApi()` afterwards. The global is resolved
 * lazily on first use so importing this module in Node never touches `wx`.
 */

import { createWechatApi, type WechatApi, type WechatLike } from "./wechatApi";

let injected: WechatApi | null = null;

function resolveGlobalWx(): WechatLike {
  const globalWithWx = globalThis as unknown as { wx?: WechatLike };
  if (!globalWithWx.wx) {
    throw new Error("wx is unavailable; inject a WechatApi implementation instead");
  }
  return globalWithWx.wx;
}

export function setWechatApi(api: WechatApi | null): void {
  injected = api;
}

export function getWechatApi(): WechatApi {
  if (!injected) {
    injected = createWechatApi(resolveGlobalWx());
  }
  return injected;
}

export function resetWechatApi(): void {
  injected = null;
}
