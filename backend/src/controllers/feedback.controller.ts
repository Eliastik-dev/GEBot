import type { Request, Response } from "express";
import { supabase } from "../config/supabase.js";
import { scheduleRetrievalFeedback } from "../services/retrieval-feedback.service.js";
import { safeErrorPayload } from "../utils/http.js";
import { readSessionTokenFromRequest, verifySessionToken } from "../utils/session-token.js";
import type { feedbackBodySchema } from "../validation/schemas.js";
import type { z } from "zod";

type FeedbackBody = z.infer<typeof feedbackBodySchema>;

export async function postFeedback(req: Request, res: Response) {
    const body = req.body as FeedbackBody;
    const { messageId, sessionId, feedback } = body;
    const sessionToken = readSessionTokenFromRequest(req.header("x-session-token"), body.sessionToken);

    if (!sessionToken || !verifySessionToken(sessionToken, sessionId)) {
      res.status(401).json({ error: "Invalid or expired session token" });
      return;
    }

    try {
      const { error } = await supabase
        .from("chat_messages")
        .update({ user_feedback: feedback })
        .eq("id", messageId)
        .eq("session_id", sessionId);

      if (error) {
        const msg = (error as { message?: string }).message ?? "";
        if (/user_feedback/i.test(msg) || (error as { code?: string }).code === "42703") {
          console.warn("[/api/feedback] user_feedback column not found:", msg);
          res.status(501).json({ error: "Feedback column not yet available — run migration" });
          return;
        }
        throw error;
      }

      console.log("[/api/feedback]", { messageId, sessionId, feedback });
      scheduleRetrievalFeedback(messageId, sessionId, feedback);
      res.json({ ok: true, messageId, feedback });
    } catch (err) {
      console.error("[/api/feedback] error:", err);
      const message = err instanceof Error ? err.message : "Internal error";
      res.status(500).json(safeErrorPayload(message, err));
    }
}
