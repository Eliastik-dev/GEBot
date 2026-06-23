import { env } from "../config/env.js";
import { GEO_TIMEOUT_MS } from "../config/constants.js";
import { withTimeout } from "../utils/async.js";

export type GeolocationResult = { countryCode: string | null };

/** Resolve country from client IP via ipapi.co (skipped when GEOLOCATION_ENABLED=false). */
export async function geolocateIp(ip: string | null): Promise<GeolocationResult> {
  if (!env.GEOLOCATION_ENABLED) {
    return { countryCode: null };
  }
  if (!ip) {
    return { countryCode: null };
  }
  const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
  const response = await withTimeout(fetch(url, { headers: { Accept: "application/json" } }), GEO_TIMEOUT_MS, "IP_GEO");
  if (!response.ok) return { countryCode: null };
  const payload = (await response.json()) as { country_code?: string };
  const countryCode = payload.country_code?.toUpperCase() ?? null;
  return { countryCode };
}
