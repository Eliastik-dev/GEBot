import type { Request, Response } from "express";
import type { ChatDeps, ValidatedChatBody } from "./chat.types.js";
import type { Audience, Locale } from "../../types/index.js";

/** Shared mutable state for one chat turn (postChat try-block). */
export interface ChatPipelineBindings {
  completed: boolean;
  req: Request;
  res: Response;
  deps: ChatDeps;
  startedAt: number;
  body: ValidatedChatBody;
  message: string;
  locale: Locale;
  profileFromMetadata: Audience | null;
  sessionId: string;
  geoConsentFromBody?: boolean | undefined;
  geoCountryFromBody: string | null;
  [key: string]: any;
}
