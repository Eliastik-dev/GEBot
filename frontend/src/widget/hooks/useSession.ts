import { useEffect, useState } from "react";
import i18n from "../../i18n.js";
import type { Locale } from "../types.js";
import { detectLocale, getOrCreateSessionId, getStoredSessionToken, persistSessionAuth } from "../utils.js";

export function useSession() {
  const [locale, setLocale] = useState<Locale>(() => detectLocale());
  const [sessionId, setSessionId] = useState<string>(() => getOrCreateSessionId());
  const [sessionToken, setSessionToken] = useState<string>(() => getStoredSessionToken());

  useEffect(() => {
    void i18n.changeLanguage(locale);
  }, [locale]);

  useEffect(() => {
    const syncLocale = () => setLocale(detectLocale());
    syncLocale();
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.type === "attributes" && record.attributeName === "lang")) {
        syncLocale();
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    return () => observer.disconnect();
  }, []);

  const updateSessionAuth = (nextSessionId: string, nextSessionToken?: string | null) => {
    setSessionId(nextSessionId);
    if (nextSessionToken) {
      setSessionToken(nextSessionToken);
      persistSessionAuth(nextSessionId, nextSessionToken);
    } else {
      setSessionToken("");
      window.localStorage.removeItem("gebot_session_token");
      window.localStorage.setItem("gebot_session_id", nextSessionId);
    }
  };

  const applySessionToken = (token: string) => {
    setSessionToken(token);
    persistSessionAuth(sessionId, token);
  };

  return {
    locale,
    setLocale,
    sessionId,
    setSessionId,
    sessionToken,
    setSessionToken,
    updateSessionAuth,
    applySessionToken,
    detectLocale,
  };
}
