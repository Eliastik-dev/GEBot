import React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../utils.js";

type Props = {
  feedback: number | null | undefined;
  onFeedback: (feedback: 1 | -1) => void;
};

export function FeedbackButtons({ feedback, onFeedback }: Props) {
  const { t } = useTranslation();

  return (
    <div className="mt-1 flex gap-1">
      <button
        type="button"
        title={t("feedbackHelpful")}
        className={cn(
          "rounded-md px-1.5 py-0.5 text-xs transition-colors",
          feedback === 1
            ? "bg-green-100 text-green-700"
            : "text-[#1A2B4B]/40 hover:bg-green-50 hover:text-green-600",
        )}
        onClick={() => void onFeedback(1)}
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
          feedback === -1
            ? "bg-red-100 text-red-700"
            : "text-[#1A2B4B]/40 hover:bg-red-50 hover:text-red-600",
        )}
        onClick={() => void onFeedback(-1)}
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="inline h-3.5 w-3.5 rotate-180">
          <path d="M2 10.5a1.5 1.5 0 113 0v6a1.5 1.5 0 01-3 0v-6zM6 10.333v5.43a2 2 0 001.106 1.79l.05.025A4 4 0 008.943 18h5.416a2 2 0 001.962-1.608l1.2-6A2 2 0 0015.56 8H12V4a2 2 0 00-2-2 1 1 0 00-1 1v.667a4 4 0 01-.8 2.4L6.8 7.933a4 4 0 00-.8 2.4z" />
        </svg>
      </button>
    </div>
  );
}
