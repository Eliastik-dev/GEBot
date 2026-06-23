import React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../utils.js";

type Props = {
  open: boolean;
  closedLogo: string;
  openLogo: string;
  onToggle: () => void;
  onOpenFromTooltip: () => void;
};

export function WidgetLauncher({ open, closedLogo, openLogo, onToggle, onOpenFromTooltip }: Props) {
  const { t } = useTranslation();

  return (
    <>
      {!open && (
        <button
          type="button"
          className={cn(
            "mb-1.5 max-w-[min(calc(100vw-5rem),14rem)] rounded-full bg-white px-2.5 py-1.5",
            "text-[11px] leading-snug shadow-md sm:text-xs",
            "cursor-pointer hover:brightness-95 active:brightness-90 transition",
          )}
          style={{ border: "1px solid rgba(20,102,172,0.35)" }}
          onClick={onOpenFromTooltip}
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
        onClick={onToggle}
        aria-label={open ? t("close") : t("openChatAria")}
      >
        <img
          src={open ? openLogo : closedLogo}
          alt=""
          aria-hidden="true"
          className={open ? "h-6 w-6 object-contain sm:h-7 sm:w-7" : "h-7 w-full object-contain sm:h-8"}
        />
      </button>
    </>
  );
}
