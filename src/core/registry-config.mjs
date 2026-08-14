// Community registry endpoint. An empty TOKEN_METER_REGISTRY_URL disables all
// registry traffic and keeps the widget in fully local mode.
export const REGISTRY_URL = "https://api.tokenwidget.app";

export function registryBase() {
  const url = process.env.TOKEN_METER_REGISTRY_URL ?? REGISTRY_URL;
  return /^https?:\/\//.test(url) ? url.replace(/\/$/, "") : null;
}
