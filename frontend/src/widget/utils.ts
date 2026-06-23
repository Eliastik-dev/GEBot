import { generateId } from "../utils/generateId.js";
import type { GeolocationConsent, Locale } from "./types.js";

export function cn(...v: Array<string | false | null | undefined>) {
  return v.filter(Boolean).join(" ");
}

/** Clear only GEBot-owned keys — never touch the host WordPress localStorage. */
export function clearGebotEphemeralLocalStorage(): void {
  if (typeof window === "undefined") return;
  const preserveKeys = new Set(["gebot_geo_consent", "gebot_geo_country"]);
  for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
    const key = window.localStorage.key(i);
    if (!key?.startsWith("gebot_")) continue;
    if (preserveKeys.has(key)) continue;
    if (/position/i.test(key)) continue;
    window.localStorage.removeItem(key);
  }
}

export function getOrCreateSessionId(): string {
  const key = "gebot_session_id";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const next = generateId();
  window.localStorage.setItem(key, next);
  return next;
}

export function getStoredSessionToken(): string {
  return window.localStorage.getItem("gebot_session_token") ?? "";
}

export function persistSessionAuth(sessionId: string, sessionToken?: string | null): void {
  window.localStorage.setItem("gebot_session_id", sessionId);
  if (sessionToken) {
    window.localStorage.setItem("gebot_session_token", sessionToken);
  }
}

export function detectLocale(): Locale {
  const raw = (document.documentElement.lang || "").toLowerCase();
  if (raw.startsWith("en")) return "en";
  if (raw.startsWith("nl")) return "nl";
  if (raw.startsWith("pl")) return "pl";
  return "fr";
}

export function getStoredGeoConsent(): GeolocationConsent {
  const raw = window.localStorage.getItem("gebot_geo_consent");
  if (raw === "accepted" || raw === "declined") return raw;
  return "pending";
}

export function getStoredGeoCountry(): string | null {
  const raw = window.localStorage.getItem("gebot_geo_country");
  return raw && raw.trim() ? raw : null;
}
