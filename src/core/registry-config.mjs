// Community registry endpoint. Temporary tunnel domain for internal testing —
// replace with the real Token Meter domain when it exists. An empty string
// disables all registry traffic (fully local mode).
export const REGISTRY_URL = "https://mlb-newsletter-door-constructed.trycloudflare.com";

export function registryBase() {
  const url = process.env.TOKEN_METER_REGISTRY_URL ?? REGISTRY_URL;
  return /^https?:\/\//.test(url) ? url.replace(/\/$/, "") : null;
}
