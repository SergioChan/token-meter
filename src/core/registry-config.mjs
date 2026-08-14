// Community registry endpoint. An empty TOKEN_METER_REGISTRY_URL disables all
// registry traffic and keeps the widget in fully local mode.
export const REGISTRY_URL = "https://api.tokenwidget.app";
export const COMMUNITY_WEB_URL = "https://www.tokenwidget.app";

export function registryBase() {
  const url = process.env.TOKEN_METER_REGISTRY_URL ?? REGISTRY_URL;
  return /^https?:\/\//.test(url) ? url.replace(/\/$/, "") : null;
}

export function communityWebBase() {
  const value = process.env.TOKEN_METER_WEB_URL ?? COMMUNITY_WEB_URL;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
