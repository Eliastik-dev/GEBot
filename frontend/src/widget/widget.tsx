import React, { useState } from "react";
import chatbotClosedLogo from "../assets/2026-05-29_APP_M+_PICTO_GEBOT_PICT_BOT_LOGO_1880x512.svg";
import chatbotOpenLogo from "../assets/2026-05-29_APP_M+_PICTO_GEBOT_PICT_BOT_GEN_512x512.svg";
import { ChatHeader } from "./components/ChatHeader.js";
import { Composer } from "./components/Composer.js";
import { MessageList } from "./components/MessageList.js";
import { OnboardingFlow } from "./components/OnboardingFlow.js";
import { WidgetLauncher } from "./components/WidgetLauncher.js";
import { useChatStream } from "./hooks/useChatStream.js";
import { useGeolocation } from "./hooks/useGeolocation.js";
import { useSession } from "./hooks/useSession.js";
import { clearGebotEphemeralLocalStorage, cn } from "./utils.js";

type Props = {
  apiBaseUrl: string;
};

clearGebotEphemeralLocalStorage();

export function Widget({ apiBaseUrl }: Props) {
  const [open, setOpen] = useState(false);

  const {
    locale,
    setLocale,
    sessionId,
    setSessionId,
    sessionToken,
    setSessionToken,
    updateSessionAuth,
    applySessionToken,
    detectLocale,
  } = useSession();

  const { geoConsent, geoCountry, setGeoCountry, isChatLocked, onGeoConsentPick, reopenGeolocationConsent } =
    useGeolocation({
      apiBaseUrl,
      sessionId,
      locale,
      onSessionToken: applySessionToken,
    });

  const chat = useChatStream({
    apiBaseUrl,
    locale,
    setLocale,
    detectLocale,
    sessionId,
    setSessionId,
    sessionToken,
    setSessionToken,
    updateSessionAuth,
    applySessionToken,
    geoConsent,
    geoCountry,
    setGeoCountry,
    isChatLocked,
  });

  const onboardingProps = {
    isChatLocked,
    showQuickReplies: chat.showQuickReplies,
    audience: chat.audience,
    busy: chat.busy,
    showThemeReplies: chat.showThemeReplies,
    theme: chat.theme,
    themeLabel: chat.themeLabel,
    onGeoConsentPick,
    onQuickReplyPick: chat.onQuickReplyPick,
    onThemeReplyPick: chat.onThemeReplyPick,
  };

  return (
    <div
      className={cn(
        "fixed z-[2147483647] text-[#1A2B4B]",
        "bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))]",
        open && "right-[max(0.75rem,env(safe-area-inset-right))] sm:right-auto",
      )}
      style={{ fontFamily: "Roboto, system-ui, sans-serif" }}
    >
      <WidgetLauncher
        open={open}
        closedLogo={chatbotClosedLogo}
        openLogo={chatbotOpenLogo}
        onToggle={() => setOpen((v) => !v)}
        onOpenFromTooltip={() => setOpen(true)}
      />

      {open && (
        <div
          className={cn(
            "gebot-panel absolute bottom-[calc(2.75rem+env(safe-area-inset-bottom,0px))] left-0 sm:bottom-14",
            "flex flex-col overflow-hidden",
            "rounded-xl shadow-2xl border backdrop-blur bg-white sm:rounded-2xl",
          )}
          style={{ borderColor: "rgba(20,102,172,0.35)" }}
        >
          <ChatHeader audience={chat.audience} onClose={() => setOpen(false)} />

          <div
            ref={chat.listRef}
            className="min-h-0 flex-1 space-y-2 overflow-auto px-2.5 py-2 sm:space-y-2.5 sm:px-3 sm:py-2.5"
          >
            <OnboardingFlow section="consent" {...onboardingProps} />
            <MessageList
              latestUserRef={chat.latestUserRef}
              latestAssistantRef={chat.latestAssistantRef}
              msgs={chat.msgs}
              busy={chat.busy}
              isChatLocked={isChatLocked}
              onFeedback={chat.handleSubmitFeedback}
            />
            <OnboardingFlow section="replies" {...onboardingProps} />
          </div>

          <Composer
            busy={chat.busy}
            backendStatus={chat.backendStatus}
            handoff={chat.handoff}
            input={chat.input}
            setInput={chat.setInput}
            canSend={chat.canSend}
            isChatLocked={isChatLocked}
            onSend={chat.onSend}
            audience={chat.audience}
            theme={chat.theme}
            themeLabel={chat.themeLabel}
            themeKeys={chat.themeKeys}
            footerEditMode={chat.footerEditMode}
            toggleFooterEditMode={chat.toggleFooterEditMode}
            onProfileChangePick={chat.onProfileChangePick}
            onDomainChangePick={chat.onDomainChangePick}
            onReopenGeolocationConsent={reopenGeolocationConsent}
          />
        </div>
      )}
    </div>
  );
}
