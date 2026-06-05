import type { Request, Response } from "express";
import { supabase } from "../config/supabase.js";
import { scheduleRetrievalFeedback } from "../services/retrieval-feedback.service.js";

export async function postFeedback(req: Request, res: Response) {
    const body = req.body as { messageId?: string; sessionId?: string; feedback?: number };
    const messageId = body.messageId?.trim();
    const sessionId = body.sessionId?.trim();
    const feedback = body.feedback;

    if (!messageId || !sessionId) {
      res.status(400).json({ error: "Missing messageId or sessionId" });
      return;
    }
    if (feedback !== 1 && feedback !== -1 && feedback !== 0) {
      res.status(400).json({ error: "feedback must be 1, -1, or 0" });
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
      res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
    }
}
