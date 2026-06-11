import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SafeMarkdown } from "../components/SafeMarkdown.js";
import { sanitizeTel } from "../utils/safeUrl.js";
import i18n from "../i18n.js";
import { generateId } from "../utils/generateId.js";

import chatbotClosedLogo from "../assets/2026-05-29_APP_M+_PICTO_GEBOT_PICT_BOT_LOGO_1880x512.svg";
import chatbotOpenLogo from "../assets/2026-05-29_APP_M+_PICTO_GEBOT_PICT_BOT_GEN_512x512.svg";

type Props = {
  apiBaseUrl: string;
};

type ChatMsg = { role: "user" | "assistant"; content: string; messageId?: string | null | undefined; feedback?: number | null | undefined };
type Audience = "professional" | "particulier" | null;
type ProductTheme = "plomberie" | "piscine" | "chauffage" | "batiment" | "maintenance" | "automobile" | "eco-conception" | null;
type Locale = "fr" | "en" | "nl" | "pl";
type GeolocationConsent = "pending" | "accepted" | "declined";
type FooterEditMode = "profile" | "domain" | null;

const THEME_KEYS = [
  "plomberie",
  "piscine",
  "chauffage",
  "batiment",
  "maintenance",
  "automobile",
  "eco-conception",
] as const satisfies readonly Exclude<ProductTheme, null>[];

type ChatStreamPayload = {
  delta?: string;
  replaceContent?: string;
  done?: boolean;
  error?: string;
  sessionId?: string;
  audience?: Audience;
  theme?: Exclude<ProductTheme, null>;
  showThemeReplies?: boolean;
  status?: "searching" | "generating";
  handoff?: { label: string; phone: string } | null;
  geoCountry?: string | null;
  messageId?: string | null;
};

function cn(...v: Array<string | false | null | undefined>) {
  return v.filter(Boolean).join(" ");
}

/** Clear only GEBot-owned keys — never touch the host WordPress localStorage. */
function clearGebotEphemeralLocalStorage(): void {
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

clearGebotEphemeralLocalStorage();

/* const chatbotClosedLogo = new URL("../assets/2026-05-29_APP_M+_PICTO_GEBOT_PICT_BOT_LOGO_1880x512.svg", import.meta.url).href;
const chatbotOpenLogo = new URL("../assets/2026-05-29_APP_M+_PICTO_GEBOT_PICT_BOT_GEN_512x512.svg", import.meta.url).href; */

async function streamChat(
  apiBaseUrl: string,
  message: string,
  sessionId: string,
  locale: Locale,
  profile: Exclude<Audience, null> | null,
  theme: Exclude<ProductTheme, null> | null,
  geoConsent: GeolocationConsent,
  geoCountry: string | null,
  onDelta: (delta: string) => void,
  onMeta: (meta: ChatStreamPayload) => void,
  onReplace?: (content: string) => void,
): Promise<void> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({
      message,
      sessionId,
      locale,
      ...(profile ? { profile } : {}),
      ...(theme ? { theme } : {}),
      geoConsent: geoConsent === "accepted" ? true : geoConsent === "declined" ? false : undefined,
      ...(geoCountry ? { geoCountry } : {}),
    }),
  });
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Chat API error (${res.status}): ${txt}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames separated by blank line
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const lines = frame.split("\n").filter(Boolean);
      const dataLine = lines.find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const json = dataLine.slice("data: ".length);
      try {
        const payload = JSON.parse(json) as ChatStreamPayload;
        if (payload.error) throw new Error(payload.error);
        if (payload.replaceContent !== undefined) {
          onReplace?.(payload.replaceContent);
        } else if (payload.delta) onDelta(payload.delta);
        onMeta(payload);
      } catch {
        // ignore malformed chunks
      }
    }
  }
}

function getOrCreateSessionId(): string {
  const key = "gebot_session_id";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const next = generateId();
  window.localStorage.setItem(key, next);
  return next;
}

function detectLocale(): Locale {
  const raw = (document.documentElement.lang || "").toLowerCase();
  if (raw.startsWith("en")) return "en";
  if (raw.startsWith("nl")) return "nl";
  if (raw.startsWith("pl")) return "pl";
  return "fr";
}

function getStoredGeoConsent(): GeolocationConsent {
  const raw = window.localStorage.getItem("gebot_geo_consent");
  if (raw === "accepted" || raw === "declined") return raw;
  return "pending";
}

function getStoredGeoCountry(): string | null {
  const raw = window.localStorage.getItem("gebot_geo_country");
  return raw && raw.trim() ? raw : null;
}

async function fetchGeoCountry(apiBaseUrl: string, sessionId: string, locale: Locale): Promise<string | null> {
  const endpoint = `${apiBaseUrl.replace(/\/$/, "")}/api/geolocation?sessionId=${encodeURIComponent(sessionId)}&locale=${encodeURIComponent(locale)}`;
  const response = await fetch(endpoint, {
    headers: { "x-session-id": sessionId, Accept: "application/json" },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { countryCode?: string | null };
  return typeof payload.countryCode === "string" ? payload.countryCode : null;
}

export function Widget({ apiBaseUrl }: Props) {
  const { t } = useTranslation();
  const [locale, setLocale] = useState<Locale>(() => detectLocale());
  const [sessionId, setSessionId] = useState<string>(() => getOrCreateSessionId());
  const [open, setOpen] = useState(false);
  const [audience, setAudience] = useState<Audience>(null);
  const [theme, setTheme] = useState<ProductTheme>(null);
  const [showQuickReplies, setShowQuickReplies] = useState(true);
  const [showThemeReplies, setShowThemeReplies] = useState(false);
  const [geoConsent, setGeoConsent] = useState<GeolocationConsent>(() => getStoredGeoConsent());
  const [geoCountry, setGeoCountry] = useState<string | null>(() => getStoredGeoCountry());
  const [handoff, setHandoff] = useState<{ label: string; phone: string } | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [backendStatus, setBackendStatus] = useState<"searching" | "generating" | null>(null);
  const [footerEditMode, setFooterEditMode] = useState<FooterEditMode>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const latestAssistantRef = useRef<HTMLDivElement | null>(null);
  const hasScrolledToNewMsg = useRef(false);

  const isChatLocked = geoConsent === "pending";
  const canSend = input.trim().length > 0 && !busy && !isChatLocked;

  const themeLabel = useCallback(
    (key: Exclude<ProductTheme, null>) => {
      const labels: Record<Exclude<ProductTheme, null>, string> = {
        plomberie: t("themePlomberie"),
        piscine: t("themePiscine"),
        chauffage: t("themeChauffage"),
        batiment: t("themeBatiment"),
        maintenance: t("themeMaintenance"),
        automobile: t("themeAutomobile"),
        "eco-conception": t("themeEcoConception"),
      };
      return labels[key];
    },
    [t],
  );

  const toggleFooterEditMode = useCallback((mode: Exclude<FooterEditMode, null>) => {
    if (busy) return;
    setFooterEditMode((current) => (current === mode ? null : mode));
  }, [busy]);

  const scrollToNewMessage = useCallback(() => {
    if (hasScrolledToNewMsg.current) return;
    const container = listRef.current;
    const msgEl = latestAssistantRef.current;
    if (!container || !msgEl) return;
    hasScrolledToNewMsg.current = true;
    const msgTop = msgEl.offsetTop - container.offsetTop;
    container.scrollTo({ top: msgTop - 8, behavior: "smooth" });
  }, []);

  useEffect(() => {
    void i18n.changeLanguage(locale);
  }, [locale]);

  useEffect(() => {
    if (isChatLocked) return;
    setMsgs((existing) => {
      if (existing.length === 0) {
        return [{ role: "assistant", content: t("onboardingQuestion") }];
      }
      if (existing.length === 1 && existing[0]?.role === "assistant") {
        return [{ role: "assistant", content: t("onboardingQuestion") }];
      }
      return existing;
    });
  }, [isChatLocked, t]);

  useEffect(() => {
    if (busy || isChatLocked) setFooterEditMode(null);
  }, [busy, isChatLocked]);

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

  async function submitFeedback(msgIdx: number, feedback: 1 | -1) {
    const msg = msgs[msgIdx];
    if (!msg?.messageId || msg.feedback === feedback) return;
    setMsgs((prev) => {
      const next = [...prev];
      const current = next[msgIdx];
      if (current) {
        next[msgIdx] = { role: current.role, content: current.content, messageId: current.messageId, feedback };
      }
      return next;
    });
    try {
      await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: msg.messageId, sessionId, feedback }),
      });
    } catch {
      /* best-effort */
    }
  }

  async function sendMessage(rawMessage: string, optimisticAudience?: Exclude<Audience, null>) {
    const q = rawMessage.trim();
    if (!q || busy) return;
    const strictLocale = detectLocale();
    if (strictLocale !== locale) {
      setLocale(strictLocale);
    }
    const nextAudience = optimisticAudience ?? audience;
    if (!rawMessage) return;
    setInput("");
    setBusy(true);
    setBackendStatus("searching");
    if (optimisticAudience) {
      setAudience(optimisticAudience);
      setShowQuickReplies(false);
    }
    hasScrolledToNewMsg.current = false;
    setMsgs((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "" }]);

    let acc = "";
    try {
      await streamChat(
        apiBaseUrl,
        q,
        sessionId,
        strictLocale,
        nextAudience ?? null,
        theme,
        geoConsent,
        geoCountry,
        (delta) => {
          acc += delta;
          setMsgs((m) => {
            const next = [...m];
            const last = next[next.length - 1];
            if (last?.role === "assistant") last.content = acc;
            return next;
          });
          queueMicrotask(scrollToNewMessage);
        },
        (meta) => {
          if (meta.status) setBackendStatus(meta.status);
          if (meta.sessionId && meta.sessionId !== sessionId) {
            setSessionId(meta.sessionId);
            window.localStorage.setItem("gebot_session_id", meta.sessionId);
          }
          if (meta.audience) {
            setAudience(meta.audience);
            setShowQuickReplies(false);
          }
          if (meta.theme) {
            setTheme(meta.theme);
            setShowThemeReplies(false);
          }
          if (meta.showThemeReplies) {
            setShowThemeReplies(true);
          }
          if (meta.geoCountry !== undefined) {
            setGeoCountry(meta.geoCountry ?? null);
          }
          if (meta.handoff !== undefined) {
            setHandoff(meta.handoff ?? null);
          }
          if (meta.messageId) {
            const mid = meta.messageId;
            setMsgs((m) => {
              const next = [...m];
              const last = next[next.length - 1];
              if (last?.role === "assistant") last.messageId = mid ?? null;
              return next;
            });
          }
        },
        (content) => {
          acc = content;
          setMsgs((m) => {
            const next = [...m];
            const last = next[next.length - 1];
            if (last?.role === "assistant") last.content = acc;
            return next;
          });
          queueMicrotask(scrollToNewMessage);
        },
      );
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : "Erreur réseau — vérifiez que le backend tourne (port 8787).";
      setMsgs((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last?.role === "assistant") last.content = acc ? `${acc}\n\n[Erreur: ${msg}]` : `[Erreur: ${msg}]`;
        return next;
      });
    } finally {
      setBusy(false);
      setBackendStatus(null);
    }
  }

  async function onSend() {
    await sendMessage(input);
  }

  async function onQuickReplyPick(picked: Exclude<Audience, null>) {
    const pickedLabel = picked === "professional" ? t("quickReplyProfessional") : t("quickReplyParticulier");
    setFooterEditMode(null);
    await sendMessage(pickedLabel, picked);
  }

  async function onThemeReplyPick(picked: Exclude<ProductTheme, null>) {
    setFooterEditMode(null);
    setTheme(picked);
    setShowThemeReplies(false);
    await sendMessage(themeLabel(picked));
  }

  async function onProfileChangePick(picked: Exclude<Audience, null>) {
    if (picked === audience) {
      setFooterEditMode(null);
      return;
    }
    const pickedLabel = picked === "professional" ? t("quickReplyProfessional") : t("quickReplyParticulier");
    setFooterEditMode(null);
    await sendMessage(pickedLabel, picked);
  }

  async function onDomainChangePick(picked: Exclude<ProductTheme, null>) {
    if (picked === theme) {
      setFooterEditMode(null);
      return;
    }
    await onThemeReplyPick(picked);
  }

  async function onGeoConsentPick(nextConsent: GeolocationConsent) {
    setGeoConsent(nextConsent);
    window.localStorage.setItem("gebot_geo_consent", nextConsent);
    if (nextConsent !== "accepted") {
      setGeoCountry(null);
      window.localStorage.removeItem("gebot_geo_country");
      return;
    }
    try {
      const country = await fetchGeoCountry(apiBaseUrl, sessionId, locale);
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

  return (
    <div
      className={cn(
        "fixed z-[2147483647] text-[#1A2B4B]",
        "bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))]",
        open && "right-[max(0.75rem,env(safe-area-inset-right))] sm:right-auto",
      )}
      style={{ fontFamily: "Roboto, system-ui, sans-serif" }}
    >
      {!open && (
        <button
          type="button"
          className={cn(
            "mb-1.5 max-w-[min(calc(100vw-5rem),14rem)] rounded-full bg-white px-2.5 py-1.5",
            "text-[11px] leading-snug shadow-md sm:text-xs",
            "cursor-pointer hover:brightness-95 active:brightness-90 transition",
          )}
          style={{ border: "1px solid rgba(20,102,172,0.35)" }}
          onClick={() => setOpen(true)}
          aria-label={t("openChatAria")}
        >
          {t("tooltipQuestion")}
        </button>
      )}
      <button
        type="button"
        className={cn(
          "shadow-lg",
          "grid place-items-center overflow-hidden",
          "hover:brightness-95 active:brightness-90 transition",
          open
            ? "h-11 w-11 rounded-full sm:h-12 sm:w-12"
            : "h-11 w-[min(11rem,calc(100vw-1.5rem))] rounded-full bg-white px-2.5 sm:h-12 sm:w-[12.5rem] sm:px-3",
        )}
        style={open ? { backgroundColor: "rgb(20, 102, 172)" } : { border: "1px solid rgba(20,102,172,0.35)" }}
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? t("close") : t("openChatAria")}
      >
        <img
          src={open ? chatbotOpenLogo : chatbotClosedLogo}
          alt=""
          aria-hidden="true"
          className={open ? "h-6 w-6 object-contain sm:h-7 sm:w-7" : "h-7 w-full object-contain sm:h-8"}
        />
      </button>

      {/* Panel */}
      {open && (
        <div
          className={cn(
            "gebot-panel absolute bottom-[calc(2.75rem+env(safe-area-inset-bottom,0px))] left-0 sm:bottom-14",
            "flex flex-col overflow-hidden",
            "rounded-xl shadow-2xl border backdrop-blur bg-white sm:rounded-2xl",
          )}
          style={{ borderColor: "rgba(20,102,172,0.35)" }}
        >
          <div
            className={cn("flex shrink-0 items-center justify-between border-b px-3 py-2 sm:px-3.5 sm:py-2.5")}
            style={{ borderColor: "rgba(20,102,172,0.35)" }}
          >
            <div className="min-w-0 flex-1 pr-2">
              <div
                className="truncate text-xs font-semibold tracking-tight text-[#1A2B4B] sm:text-sm"
                style={{ fontFamily: "Montserrat, Roboto, system-ui, sans-serif" }}
              >
                GEBot
              </div>
              <div className={cn("truncate text-[10px] text-[#1A2B4B]/70 sm:text-[11px]")}>
                {t("subtitle", { audience: audience ?? t("audienceUnknown") })}
              </div>
            </div>
            <button
              type="button"
              className={cn(
                "shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] text-[#1A2B4B] hover:bg-[#1466AC]/10 sm:px-2 sm:py-1 sm:text-xs",
              )}
              style={{ borderColor: "rgba(20,102,172,0.35)" }}
              onClick={() => setOpen(false)}
            >
              {t("close")}
            </button>
          </div>

          <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-auto px-2.5 py-2 sm:space-y-2.5 sm:px-3 sm:py-2.5">
            {isChatLocked && (
              <div className="rounded-lg border border-[#1466AC]/25 bg-[#1466AC]/5 p-2 text-[11px] text-[#1A2B4B] sm:rounded-xl sm:p-2.5 sm:text-xs">
                <p className="mb-1.5 sm:mb-2">{t("geolocationConsentPrompt")}</p>
                <div className="flex flex-wrap gap-1.5 sm:gap-2">
                  <button
                    type="button"
                    className="rounded-full bg-[#1466AC] px-2.5 py-1 text-[11px] font-semibold text-white hover:brightness-95 sm:px-3 sm:py-1.5 sm:text-xs"
                    onClick={() => void onGeoConsentPick("accepted")}
                  >
                    {t("allow")}
                  </button>
                  <button
                    type="button"
                    className="rounded-full border border-[#1A2B4B]/25 bg-white px-2.5 py-1 text-[11px] font-semibold text-[#1A2B4B] hover:bg-[#1A2B4B]/5 sm:px-3 sm:py-1.5 sm:text-xs"
                    onClick={() => void onGeoConsentPick("declined")}
                  >
                    {t("decline")}
                  </button>
                </div>
              </div>
            )}

            {!isChatLocked &&
              msgs.map((m, idx) => {
              const isUser = m.role === "user";
              const isLastAssistant = !isUser && idx === msgs.length - 1;
              const showFeedback = !isUser && m.content && m.messageId && !busy;
              return (
                <div key={idx} ref={isLastAssistant ? latestAssistantRef : undefined} className={cn("flex flex-col", isUser ? "items-end" : "items-start")}>
                  <div
                    className={cn(
                      "max-w-[92%] rounded-xl px-2.5 py-1.5 text-xs leading-relaxed sm:max-w-[88%] sm:rounded-2xl sm:px-3 sm:py-2 sm:text-sm",
                      isUser
                        ? "bg-[#1466AC] text-white"
                        : "bg-[#1A2B4B]/5 border text-[#1A2B4B]",
                    )}
                    style={isUser ? undefined : { borderColor: "rgba(20,102,172,0.25)" }}
                  >
                    {m.content ? (
                      isUser ? (
                        m.content
                      ) : (
                        <SafeMarkdown content={m.content} />
                      )
                    ) : busy && idx === msgs.length - 1 ? (
                      <span className="opacity-70">…</span>
                    ) : null}
                  </div>
                  {showFeedback && (
                    <div className="mt-1 flex gap-1">
                      <button
                        type="button"
                        title={t("feedbackHelpful")}
                        className={cn(
                          "rounded-md px-1.5 py-0.5 text-xs transition-colors",
                          m.feedback === 1
                            ? "bg-green-100 text-green-700"
                            : "text-[#1A2B4B]/40 hover:bg-green-50 hover:text-green-600",
                        )}
                        onClick={() => void submitFeedback(idx, 1)}
                      >
                        <svg viewBox="0 0 20 20" fill="currentColor" className="inline h-3.5 w-3.5">
                          <path d="M2 10.5a1.5 1.5 0 113 0v6a1.5 1.5 0 01-3 0v-6zM6 10.333v5.43a2 2 0 001.106 1.79l.05.025A4 4 0 008.943 18h5.416a2 2 0 001.962-1.608l1.2-6A2 2 0 0015.56 8H12V4a2 2 0 00-2-2 1 1 0 00-1 1v.667a4 4 0 01-.8 2.4L6.8 7.933a4 4 0 00-.8 2.4z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        title={t("feedbackNotHelpful")}
                        className={cn(
                          "rounded-md px-1.5 py-0.5 text-xs transition-colors",
                          m.feedback === -1
                            ? "bg-red-100 text-red-700"
                            : "text-[#1A2B4B]/40 hover:bg-red-50 hover:text-red-600",
                        )}
                        onClick={() => void submitFeedback(idx, -1)}
                      >
                        <svg viewBox="0 0 20 20" fill="currentColor" className="inline h-3.5 w-3.5 rotate-180">
                          <path d="M2 10.5a1.5 1.5 0 113 0v6a1.5 1.5 0 01-3 0v-6zM6 10.333v5.43a2 2 0 001.106 1.79l.05.025A4 4 0 008.943 18h5.416a2 2 0 001.962-1.608l1.2-6A2 2 0 0015.56 8H12V4a2 2 0 00-2-2 1 1 0 00-1 1v.667a4 4 0 01-.8 2.4L6.8 7.933a4 4 0 00-.8 2.4z" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              );
              })}

            {!isChatLocked && showQuickReplies && !audience && !busy && (
              <div className="flex flex-wrap gap-1.5 pt-0.5 sm:gap-2 sm:pt-1">
                <button
                  type="button"
                  className={cn(
                    "min-w-[calc(50%-0.375rem)] flex-1 rounded-full px-2.5 py-1.5 text-[11px] text-white shadow-sm",
                    "transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md sm:min-w-0 sm:flex-none sm:px-3 sm:py-2 sm:text-xs",
                  )}
                  style={{
                    backgroundColor: "rgb(26, 43, 75)",
                    fontFamily: "Roboto, system-ui, sans-serif",
                  }}
                  onClick={() => void onQuickReplyPick("professional")}
                >
                  {t("quickReplyProfessional")}
                </button>
                <button
                  type="button"
                  className={cn(
                    "min-w-[calc(50%-0.375rem)] flex-1 rounded-full px-2.5 py-1.5 text-[11px] text-white shadow-sm",
                    "transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md sm:min-w-0 sm:flex-none sm:px-3 sm:py-2 sm:text-xs",
                  )}
                  style={{
                    backgroundColor: "rgb(20, 102, 172)",
                    fontFamily: "Roboto, system-ui, sans-serif",
                  }}
                  onClick={() => void onQuickReplyPick("particulier")}
                >
                  {t("quickReplyParticulier")}
                </button>
              </div>
            )}

            {!isChatLocked && showThemeReplies && audience && !theme && !busy && (
              <div className="flex flex-wrap gap-1.5 pt-0.5 sm:gap-2 sm:pt-1">
                {THEME_KEYS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={cn(
                      "min-w-[calc(50%-0.375rem)] flex-1 rounded-full px-2.5 py-1.5 text-[11px] text-white shadow-sm",
                      "transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md sm:min-w-0 sm:flex-none sm:px-3 sm:py-2 sm:text-xs",
                    )}
                    style={{
                      backgroundColor: "rgb(20, 102, 172)",
                      fontFamily: "Roboto, system-ui, sans-serif",
                    }}
                    onClick={() => void onThemeReplyPick(key)}
                  >
                    {themeLabel(key)}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={cn("shrink-0 border-t p-2 sm:p-2.5")} style={{ borderColor: "rgba(20,102,172,0.35)" }}>
            {busy && backendStatus === "searching" && (
              <div className="mb-1.5 text-[10px] text-[#1A2B4B]/70 sm:mb-2 sm:text-[11px]">{t("statusSearchingSheets")}</div>
            )}
            {handoff && (
              <button
                type="button"
                className="mb-1.5 w-full truncate rounded-md bg-[#1466AC] px-2 py-0.5 text-[10px] font-semibold leading-tight text-white hover:brightness-95 sm:mb-2 sm:text-[11px]"
                onClick={() => {
                  const tel = sanitizeTel(handoff.phone);
                  if (tel) window.open(`tel:${tel}`, "_self");
                }}
              >
                {handoff.label}: {handoff.phone}
              </button>
            )}
            <div className="flex gap-1.5 max-[340px]:flex-col sm:gap-2">
              <input
                className={cn(
                  "min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-xs outline-none sm:rounded-xl sm:px-3 sm:py-2 sm:text-sm",
                  "bg-white border text-[#1A2B4B]",
                  "placeholder:text-[#1A2B4B]/60",
                )}
                style={{ borderColor: "rgba(20,102,172,0.35)" }}
                placeholder={t("inputPlaceholder")}
                value={input}
                maxLength={4000}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSend();
                }}
                disabled={busy || isChatLocked}
              />
              <button
                type="button"
                className={cn(
                  "shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold max-[340px]:w-full sm:rounded-xl sm:px-3 sm:py-2 sm:text-sm",
                  canSend ? "text-white" : "bg-[#1A2B4B]/20 text-[#1A2B4B]/60",
                )}
                style={canSend ? { backgroundColor: "rgb(20, 102, 172)" } : undefined}
                onClick={onSend}
                disabled={!canSend}
              >
                {t("send")}
              </button>
            </div>
            <div className={cn("mt-1.5 space-y-1.5 sm:mt-2 sm:space-y-2")}>
              <div
                className={cn(
                  "text-[10px] text-[#1A2B4B]/70 sm:text-[11px]",
                  audience ? "grid grid-cols-2 gap-x-3" : "flex items-baseline",
                )}
              >
                <span className="inline-flex min-w-0 items-baseline gap-1">
                  <span className="shrink-0" style={{ fontFamily: "Montserrat, Roboto, system-ui, sans-serif" }}>
                    {t("profile")}:
                  </span>
                  <span className="truncate text-[#1466AC]">
                    {audience ? t(`audience.${audience}`) : t("audienceUnknown")}
                  </span>
                  {audience && !busy && !isChatLocked && (
                    <button
                      type="button"
                      className="shrink-0 rounded px-1 text-[#1466AC] underline decoration-[#1466AC]/40 underline-offset-2 hover:bg-[#1466AC]/10"
                      onClick={() => toggleFooterEditMode("profile")}
                    >
                      {t("change")}
                    </button>
                  )}
                </span>
                {audience && (
                  <span className="inline-flex min-w-0 items-baseline gap-1">
                    <span className="shrink-0" style={{ fontFamily: "Montserrat, Roboto, system-ui, sans-serif" }}>
                      {t("domain")}:
                    </span>
                    <span className="truncate text-[#1466AC]">{theme ? themeLabel(theme) : t("domainUnknown")}</span>
                    {!busy && !isChatLocked && (
                      <button
                        type="button"
                        className="shrink-0 rounded px-1 text-[#1466AC] underline decoration-[#1466AC]/40 underline-offset-2 hover:bg-[#1466AC]/10"
                        onClick={() => toggleFooterEditMode("domain")}
                      >
                        {t("change")}
                      </button>
                    )}
                  </span>
                )}
              </div>

              {footerEditMode === "profile" && !busy && !isChatLocked && (
                <div className="flex flex-wrap gap-1 sm:gap-1.5">
                  {(["professional", "particulier"] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={cn(
                        "min-w-[calc(50%-0.25rem)] flex-1 rounded-full px-2 py-1 text-[10px] font-medium shadow-sm transition-colors sm:min-w-0 sm:flex-none sm:px-2.5 sm:py-1.5 sm:text-[11px]",
                        audience === key
                          ? "bg-[#1466AC] text-white"
                          : "border border-[#1466AC]/35 bg-white text-[#1466AC] hover:bg-[#1466AC]/10",
                      )}
                      onClick={() => void onProfileChangePick(key)}
                    >
                      {key === "professional" ? t("quickReplyProfessional") : t("quickReplyParticulier")}
                    </button>
                  ))}
                </div>
              )}

              {footerEditMode === "domain" && !busy && !isChatLocked && (
                <div className="flex flex-wrap gap-1 sm:gap-1.5">
                  {THEME_KEYS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={cn(
                        "min-w-[calc(50%-0.25rem)] flex-1 rounded-full px-2 py-1 text-[10px] font-medium shadow-sm transition-colors sm:min-w-0 sm:flex-none sm:px-2.5 sm:py-1.5 sm:text-[11px]",
                        theme === key
                          ? "bg-[#1466AC] text-white"
                          : "border border-[#1466AC]/35 bg-white text-[#1466AC] hover:bg-[#1466AC]/10",
                      )}
                      onClick={() => void onDomainChangePick(key)}
                    >
                      {themeLabel(key)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {!isChatLocked && (
              <div className="mt-1.5 sm:mt-2">
                <button
                  type="button"
                  className="rounded-md border border-[#1466AC]/35 px-1.5 py-0.5 text-[10px] text-[#1466AC] hover:bg-[#1466AC]/10 sm:px-2 sm:py-1 sm:text-[11px]"
                  onClick={reopenGeolocationConsent}
                >
                  {t("updateLocationPreference")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

