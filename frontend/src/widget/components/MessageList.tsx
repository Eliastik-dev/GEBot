import React from "react";
import { SafeMarkdown } from "../../components/SafeMarkdown.js";
import type { ChatMsg } from "../types.js";
import { cn } from "../utils.js";
import { FeedbackButtons } from "./FeedbackButtons.js";

type Props = {
  latestUserRef: React.RefObject<HTMLDivElement | null>;
  latestAssistantRef: React.RefObject<HTMLDivElement | null>;
  msgs: ChatMsg[];
  busy: boolean;
  isChatLocked: boolean;
  onFeedback: (msgIdx: number, feedback: 1 | -1) => void;
};

export function MessageList({
  latestUserRef,
  latestAssistantRef,
  msgs,
  busy,
  isChatLocked,
  onFeedback,
}: Props) {
  if (isChatLocked) return null;

  return (
    <>
      {msgs.map((m, idx) => {
        const isUser = m.role === "user";
        const isLastUser = isUser && idx === msgs.length - 2;
        const isLastAssistant = !isUser && idx === msgs.length - 1;
        const showFeedback = !isUser && m.content && m.messageId && !busy;
        return (
          <div
            key={idx}
            ref={isLastUser ? latestUserRef : isLastAssistant ? latestAssistantRef : undefined}
            className={cn("flex flex-col", isUser ? "items-end" : "items-start")}
          >
            <div
              className={cn(
                "max-w-[92%] rounded-xl px-2.5 py-1.5 text-xs leading-relaxed sm:max-w-[88%] sm:rounded-2xl sm:px-3 sm:py-2 sm:text-sm",
                isUser ? "bg-[#1466AC] text-white" : "bg-[#1A2B4B]/5 border text-[#1A2B4B]",
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
              <FeedbackButtons
                feedback={m.feedback}
                onFeedback={(feedback) => void onFeedback(idx, feedback)}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
