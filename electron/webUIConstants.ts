export const WEBUI_DEFAULT_PORT = 18080;
export const WEBUI_MIN_PORT = 1024;
export const WEBUI_MAX_PORT = 65535;

export function normalizeWebUIPort(value: unknown): number {
  const port = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isInteger(port) || port < WEBUI_MIN_PORT || port > WEBUI_MAX_PORT) {
    return WEBUI_DEFAULT_PORT;
  }
  return port;
}
