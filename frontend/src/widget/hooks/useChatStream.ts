import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { streamChat, submitFeedback as apiSubmitFeedback } from "../api/client.js";
import { THEME_KEYS } from "../constants.js";
import type {
  Audience,
  ChatMsg,
  FooterEditMode,
  GeolocationConsent,
  Handoff,
  Locale,
  ProductTheme,
} from "../types.js";

type UseChatStreamOptions = {
  apiBaseUrl: string;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  detectLocale: () => Locale;
  sessionId: string;
  setSessionId: (id: string) => void;
  sessionToken: string;
  setSessionToken: (token: string) => void;
  updateSessionAuth: (sessionId: string, sessionToken?: string | null) => void;
  applySessionToken: (token: string) => void;
  geoConsent: GeolocationConsent;
  geoCountry: string | null;
  setGeoCountry: (country: string | null) => void;
  isChatLocked: boolean;
};

export function useChatStream({
  apiBaseUrl,
  locale,
  setLocale,
  detectLocale,
  sessionId,
  setSessionId,
  sessionToken,
  updateSessionAuth,
  applySessionToken,
  geoConsent,
  geoCountry,
  setGeoCountry,
  isChatLocked,
}: UseChatStreamOptions) {
  const { t } = useTranslation();

  const [audience, setAudience] = useState<Audience>(null);
  const [theme, setTheme] = useState<ProductTheme>(null);
  const [showQuickReplies, setShowQuickReplies] = useState(true);
  const [showThemeReplies, setShowThemeReplies] = useState(false);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [backendStatus, setBackendStatus] = useState<"searching" | "generating" | null>(null);
  const [footerEditMode, setFooterEditMode] = useState<FooterEditMode>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const latestUserRef = useRef<HTMLDivElement | null>(null);
  const latestAssistantRef = useRef<HTMLDivElement | null>(null);
  const hasScrolledToNewMsg = useRef(false);

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

  const toggleFooterEditMode = useCallback(
    (mode: Exclude<FooterEditMode, null>) => {
      if (busy) return;
      setFooterEditMode((current) => (current === mode ? null : mode));
    },
    [busy],
  );

  const scrollToLatestTurn = useCallback(() => {
    const container = listRef.current;
    if (!container) return;
    const userEl = latestUserRef.current;
    const assistantEl = latestAssistantRef.current;
    const target = userEl ?? assistantEl;
    if (!target) return;
    const targetTop = target.offsetTop - container.offsetTop;
    container.scrollTo({ top: Math.max(0, targetTop - 8), behavior: "smooth" });
  }, []);

  const scrollToNewMessage = useCallback(() => {
    if (hasScrolledToNewMsg.current) return;
    const container = listRef.current;
    const msgEl = latestAssistantRef.current;
    if (!container || !msgEl) return;
    hasScrolledToNewMsg.current = true;
    scrollToLatestTurn();
  }, [scrollToLatestTurn]);

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

  async function handleSubmitFeedback(msgIdx: number, feedback: 1 | -1) {
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
      await apiSubmitFeedback(apiBaseUrl, sessionId, sessionToken, msg.messageId, feedback);
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
    queueMicrotask(scrollToLatestTurn);

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
            if (meta.sessionToken) {
              updateSessionAuth(meta.sessionId, meta.sessionToken);
            } else {
              updateSessionAuth(meta.sessionId, null);
            }
          } else if (meta.sessionToken) {
            applySessionToken(meta.sessionToken);
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
          if (meta.messageId != null) {
            const mid = String(meta.messageId);
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

  return {
    audience,
    theme,
    showQuickReplies,
    showThemeReplies,
    handoff,
    msgs,
    input,
    setInput,
    busy,
    backendStatus,
    footerEditMode,
    canSend,
    listRef,
    latestUserRef,
    latestAssistantRef,
    themeLabel,
    themeKeys: THEME_KEYS,
    toggleFooterEditMode,
    handleSubmitFeedback,
    onSend,
    onQuickReplyPick,
    onThemeReplyPick,
    onProfileChangePick,
    onDomainChangePick,
  };
}
