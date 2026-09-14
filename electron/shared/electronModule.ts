import * as electronNamespace from "electron";

/**
 * Electron is a CommonJS package in Node mode, where its default export is the
 * executable path. In an Electron main process its API can be exposed as that
 * default object, while test doubles commonly provide named exports only.
 */
export function electronModule(): typeof import("electron") | undefined {
  const defaultExport = (electronNamespace as { default?: unknown }).default;
  const candidate = defaultExport && typeof defaultExport === "object"
    ? defaultExport
    : electronNamespace;
  return candidate && typeof candidate === "object"
    ? candidate as typeof import("electron")
    : undefined;
}
