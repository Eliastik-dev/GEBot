import React from "react";
import { useTranslation } from "react-i18next";
import type { Audience } from "../types.js";
import { cn } from "../utils.js";

type Props = {
  audience: Audience;
  onClose: () => void;
};

export function ChatHeader({ audience, onClose }: Props) {
  const { t } = useTranslation();

  return (
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
        onClick={onClose}
      >
        {t("close")}
      </button>
    </div>
  );
}
