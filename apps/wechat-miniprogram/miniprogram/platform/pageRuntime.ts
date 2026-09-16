/**
 * Page/navigation seam.
 *
 * Pages need navigation, a title, a toast and a confirmation — nothing else. Keeping those calls
 * behind one small interface means a page controller can be unit-tested in Node with a recording
 * double, exactly like the transport and RPC layers, and the number of `wx` entry points stays
 * countable: `platform/wechatApi.ts` owns login/storage/request/socket/network, this file owns
 * navigation and user-facing UI.
 *
 * Nothing here is allowed to carry secret material: a confirmation or toast only ever receives
 * text a page already renders, and the interface has no "open arbitrary URL" or "navigate to a
 * caller-supplied host" method, so a page cannot be tricked into leaving the configured Relay.
 */

export type ToastIcon = "none" | "success" | "error";

export interface ToastOptions {
  readonly title: string;
  readonly icon?: ToastIcon;
}

export interface ConfirmOptions {
  readonly title: string;
  readonly content: string;
  readonly confirmText?: string;
  readonly cancelText?: string;
}

export interface PageRuntime {
  /** Pushes a mini-program route. Best effort: a full page stack fails quietly, as WeChat does. */
  navigateTo(url: string): void;
  navigateBack(delta?: number): void;
  reLaunch(url: string): void;
  setNavigationBarTitle(title: string): void;
  showToast(options: ToastOptions): void;
  showConfirm(options: ConfirmOptions): Promise<boolean>;
  stopPullDownRefresh(): void;
}

/** Structural subset of the global `wx` object this module calls. */
export interface WxPageLike {
  navigateTo(option: { url: string; fail?: (error: { errMsg: string }) => void }): void;
  navigateBack(option?: { delta?: number }): void;
  reLaunch(option: { url: string }): void;
  setNavigationBarTitle(option: { title: string }): void;
  showToast(option: { title: string; icon?: string; duration?: number }): void;
  showModal(option: {
    title?: string;
    content?: string;
    confirmText?: string;
    cancelText?: string;
    success?: (result: { confirm: boolean; cancel: boolean }) => void;
    fail?: (error: { errMsg: string }) => void;
  }): void;
  stopPullDownRefresh(option?: { fail?: (error: { errMsg: string }) => void }): void;
}

const DEFAULT_TOAST_DURATION_MS = 2_000;

/** Minimal structural shapes for the page events the read-only pages actually handle. */
export interface InputEventLike {
  readonly detail: { readonly value: string };
}

export interface DatasetEventLike {
  readonly currentTarget: { readonly dataset: Record<string, unknown> };
}

export function createWechatPageRuntime(host: WxPageLike): PageRuntime {
  return {
    navigateTo(url) {
      // A navigation failure must not throw inside an event handler: WeChat already surfaces its
      // own error to the operator (usually the 10-level page stack limit).
      host.navigateTo({ url, fail: () => undefined });
    },

    navigateBack(delta) {
      host.navigateBack(delta === undefined ? {} : { delta });
    },

    reLaunch(url) {
      host.reLaunch({ url });
    },

    setNavigationBarTitle(title) {
      host.setNavigationBarTitle({ title });
    },

    showToast(options) {
      host.showToast({
        title: options.title,
        icon: options.icon ?? "none",
        duration: DEFAULT_TOAST_DURATION_MS
      });
    },

    showConfirm(options) {
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (value: boolean): void => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        try {
          host.showModal({
            title: options.title,
            content: options.content,
            confirmText: options.confirmText,
            cancelText: options.cancelText,
            success: (result) => settle(result.confirm === true),
            // A modal that cannot be shown must not approve a destructive action.
            fail: () => settle(false)
          });
        } catch {
          settle(false);
        }
      });
    },

    stopPullDownRefresh() {
      host.stopPullDownRefresh({ fail: () => undefined });
    }
  };
}

let injected: PageRuntime | null = null;

function resolveGlobalWx(): WxPageLike {
  const globalWithWx = globalThis as unknown as { wx?: WxPageLike };
  if (!globalWithWx.wx) {
    throw new Error("wx is unavailable; inject a PageRuntime implementation instead");
  }
  return globalWithWx.wx;
}

export function setPageRuntime(runtime: PageRuntime | null): void {
  injected = runtime;
}

export function getPageRuntime(): PageRuntime {
  if (!injected) {
    injected = createWechatPageRuntime(resolveGlobalWx());
  }
  return injected;
}

export function resetPageRuntime(): void {
  injected = null;
}
