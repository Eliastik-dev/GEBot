import { useState } from "react";
import { fetchGeoCountry } from "../api/client.js";
import type { GeolocationConsent, Locale } from "../types.js";
import { getStoredGeoConsent, getStoredGeoCountry, persistSessionAuth } from "../utils.js";

type UseGeolocationOptions = {
  apiBaseUrl: string;
  sessionId: string;
  locale: Locale;
  onSessionToken: (token: string) => void;
};

export function useGeolocation({ apiBaseUrl, sessionId, locale, onSessionToken }: UseGeolocationOptions) {
  const [geoConsent, setGeoConsent] = useState<GeolocationConsent>(() => getStoredGeoConsent());
  const [geoCountry, setGeoCountry] = useState<string | null>(() => getStoredGeoCountry());

  const isChatLocked = geoConsent === "pending";

  async function onGeoConsentPick(nextConsent: GeolocationConsent) {
    setGeoConsent(nextConsent);
    window.localStorage.setItem("gebot_geo_consent", nextConsent);
    if (nextConsent !== "accepted") {
      setGeoCountry(null);
      window.localStorage.removeItem("gebot_geo_country");
      return;
    }
    try {
      const country = await fetchGeoCountry(apiBaseUrl, sessionId, locale, (token) => {
        onSessionToken(token);
        persistSessionAuth(sessionId, token);
      });
      setGeoCountry(country);
      if (country) {
        window.localStorage.setItem("gebot_geo_country", country);
      }
    } catch {
      setGeoCountry(null);
      window.localStorage.removeItem("gebot_geo_country");
    }
  }

  function reopenGeolocationConsent() {
    setGeoConsent("pending");
    setGeoCountry(null);
    window.localStorage.removeItem("gebot_geo_consent");
    window.localStorage.removeItem("gebot_geo_country");
  }

  return {
    geoConsent,
    geoCountry,
    setGeoCountry,
    isChatLocked,
    onGeoConsentPick,
    reopenGeolocationConsent,
  };
}
