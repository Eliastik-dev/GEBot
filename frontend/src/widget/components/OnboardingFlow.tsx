import React from "react";
import { useTranslation } from "react-i18next";
import { THEME_KEYS } from "../constants.js";
import type { Audience, GeolocationConsent, ProductTheme } from "../types.js";
import { cn } from "../utils.js";

type BaseProps = {
  isChatLocked: boolean;
  showQuickReplies: boolean;
  audience: Audience;
  busy: boolean;
  showThemeReplies: boolean;
  theme: ProductTheme;
  themeLabel: (key: Exclude<ProductTheme, null>) => string;
  onGeoConsentPick: (consent: GeolocationConsent) => void;
  onQuickReplyPick: (picked: Exclude<Audience, null>) => void;
  onThemeReplyPick: (picked: Exclude<ProductTheme, null>) => void;
};

type Props = BaseProps & {
  section: "consent" | "replies";
};

export function OnboardingFlow({
  section,
  isChatLocked,
  onGeoConsentPick,
  showQuickReplies,
  audience,
  busy,
  onQuickReplyPick,
  showThemeReplies,
  theme,
  themeLabel,
  onThemeReplyPick,
}: Props) {
  const { t } = useTranslation();

  if (section === "consent") {
    if (!isChatLocked) return null;
    return (
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
    );
  }

  if (isChatLocked) return null;

  return (
    <>
      {showQuickReplies && !audience && !busy && (
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

      {showThemeReplies && audience && !theme && !busy && (
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
    </>
  );
}
