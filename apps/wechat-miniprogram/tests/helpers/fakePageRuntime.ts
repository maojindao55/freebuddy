/** Recording `PageRuntime` double. Lives under `tests/` so it can never reach a bundle. */

import type { ConfirmOptions, PageRuntime, ToastOptions } from "../../miniprogram/platform/pageRuntime";

export interface RecordedRuntime extends PageRuntime {
  readonly toasts: readonly string[];
  readonly toastOptions: readonly ToastOptions[];
  readonly navigations: readonly string[];
  readonly backs: readonly number[];
  readonly relaunches: readonly string[];
  readonly titles: readonly string[];
  readonly confirms: readonly ConfirmOptions[];
  pullDownStops(): number;
  /** Answer used by `showConfirm`. Defaults to `true` so destructive flows can be exercised. */
  confirmResult: boolean;
}

export function createRecordingPageRuntime(): RecordedRuntime {
  const toasts: ToastOptions[] = [];
  const navigations: string[] = [];
  const backs: number[] = [];
  const relaunches: string[] = [];
  const titles: string[] = [];
  const confirms: ConfirmOptions[] = [];
  let pullDownStopCount = 0;
  let confirmResult = true;

  return {
    toastOptions: toasts,
    navigations,
    backs,
    relaunches,
    titles,
    confirms,

    get toasts() {
      return toasts.map((toast) => toast.title);
    },

    get confirmResult() {
      return confirmResult;
    },

    set confirmResult(value: boolean) {
      confirmResult = value;
    },

    navigateTo(url) {
      navigations.push(url);
    },

    navigateBack(delta) {
      backs.push(delta ?? 1);
    },

    reLaunch(url) {
      relaunches.push(url);
    },

    setNavigationBarTitle(title) {
      titles.push(title);
    },

    showToast(options) {
      toasts.push(options);
    },

    async showConfirm(options) {
      confirms.push(options);
      return confirmResult;
    },

    stopPullDownRefresh() {
      pullDownStopCount += 1;
    },

    pullDownStops() {
      return pullDownStopCount;
    }
  };
}
