import React from "react";
import { useTranslation } from "react-i18next";
import { sanitizeTel } from "../../utils/safeUrl.js";
import type { Audience, FooterEditMode, Handoff, ProductTheme } from "../types.js";
import { cn } from "../utils.js";

type Props = {
  busy: boolean;
  backendStatus: "searching" | "generating" | null;
  handoff: Handoff | null;
  input: string;
  setInput: (value: string) => void;
  canSend: boolean;
  isChatLocked: boolean;
  onSend: () => void;
  audience: Audience;
  theme: ProductTheme;
  themeLabel: (key: Exclude<ProductTheme, null>) => string;
  themeKeys: readonly Exclude<ProductTheme, null>[];
  footerEditMode: FooterEditMode;
  toggleFooterEditMode: (mode: Exclude<FooterEditMode, null>) => void;
  onProfileChangePick: (picked: Exclude<Audience, null>) => void;
  onDomainChangePick: (picked: Exclude<ProductTheme, null>) => void;
  onReopenGeolocationConsent: () => void;
};

export function Composer({
  busy,
  backendStatus,
  handoff,
  input,
  setInput,
  canSend,
  isChatLocked,
  onSend,
  audience,
  theme,
  themeLabel,
  themeKeys,
  footerEditMode,
  toggleFooterEditMode,
  onProfileChangePick,
  onDomainChangePick,
  onReopenGeolocationConsent,
}: Props) {
  const { t } = useTranslation();

  return (
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
          onClick={() => void onSend()}
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
            {themeKeys.map((key) => (
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
            onClick={onReopenGeolocationConsent}
          >
            {t("updateLocationPreference")}
          </button>
        </div>
      )}
    </div>
  );
}
