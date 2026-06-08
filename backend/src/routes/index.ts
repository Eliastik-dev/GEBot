import type { Express } from "express";
import { getBuildInfo } from "../config/build-info.js";
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import { postChat, type ChatDeps } from "../controllers/chat.controller.js";
import { getGeolocation } from "../controllers/geolocation.controller.js";
import { postFeedback } from "../controllers/feedback.controller.js";
import { countProductKnowledge } from "../services/product-knowledge.service.js";
import { productKnowledgeLocale } from "../services/product-router.service.js";

export function registerRoutes(app: Express, chatDeps: ChatDeps): void {
  app.get("/api/geolocation", getGeolocation);
  app.post("/api/chat", (req, res) => postChat(req, res, chatDeps));
  app.post("/api/feedback", postFeedback);
  app.get("/health", async (_req, res) => {
    const build = getBuildInfo();
    let supabaseOk = false;
    let productKnowledgeFr: number | null = null;
    try {
      const { error } = await supabase.from("chat_sessions").select("session_id").limit(1);
      supabaseOk = !error;
      if (env.PRODUCT_KNOWLEDGE_ENABLED) {
        productKnowledgeFr = await countProductKnowledge(productKnowledgeLocale("fr"));
      }
    } catch {
      supabaseOk = false;
    }
    res.json({
      ok: true,
      commit: build.commit,
      builtAt: build.builtAt,
      supabase: supabaseOk,
      productKnowledgeFr,
      productKnowledgeEnabled: env.PRODUCT_KNOWLEDGE_ENABLED,
    });
  });
}
