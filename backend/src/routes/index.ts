import type { Express } from "express";
import { getBuildInfo } from "../config/build-info.js";
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import { postChat, type ChatDeps } from "../controllers/chat.controller.js";
import { getGeolocation } from "../controllers/geolocation.controller.js";
import { postFeedback } from "../controllers/feedback.controller.js";
import {
  countProductKnowledge,
  getProductKnowledgeBySlug,
  lookupExplicitCatalogProductForSheet,
} from "../services/product-knowledge.service.js";
import { productKnowledgeLocale } from "../services/product-router.service.js";

/** Bump when retrieval behaviour changes — compare with /health on the VM after deploy. */
export const RETRIEVAL_FEATURES_VERSION = "2026-06-08-direct-sheet-citation";

export function registerRoutes(app: Express, chatDeps: ChatDeps): void {
  app.get("/api/geolocation", getGeolocation);
  app.post("/api/chat", (req, res) => postChat(req, res, chatDeps));
  app.post("/api/feedback", postFeedback);
  app.get("/health", async (_req, res) => {
    const build = getBuildInfo();
    const pkLocale = productKnowledgeLocale("fr");
    let supabaseOk = false;
    let productKnowledgeFr: number | null = null;
    let g110InCatalog = false;
    let g110SheetLookup: string | null = null;
    try {
      const { error } = await supabase.from("chat_sessions").select("session_id").limit(1);
      supabaseOk = !error;
      if (env.PRODUCT_KNOWLEDGE_ENABLED) {
        productKnowledgeFr = await countProductKnowledge(pkLocale);
        if (productKnowledgeFr > 0) {
          const g110 = await getProductKnowledgeBySlug("g110-inhibiteur-universel", pkLocale);
          g110InCatalog = Boolean(g110);
          const sheetHit = await lookupExplicitCatalogProductForSheet({
            locale: pkLocale,
            userQuery: "fiche technique du g110 inhibiteur universel",
            contextQuery: "fiche technique du g110 inhibiteur universel",
            audience: "professional",
          });
          g110SheetLookup = sheetHit?.slug ?? null;
        }
      }
    } catch {
      supabaseOk = false;
    }
    const catalogReady =
      env.PRODUCT_KNOWLEDGE_ENABLED && productKnowledgeFr !== null && productKnowledgeFr > 0;
    res.json({
      ok: true,
      commit: build.commit,
      builtAt: build.builtAt,
      port: env.PORT,
      supabase: supabaseOk,
      productKnowledgeFr,
      productKnowledgeEnabled: env.PRODUCT_KNOWLEDGE_ENABLED,
      catalogReady,
      retrieval: {
        version: RETRIEVAL_FEATURES_VERSION,
        g110InCatalog,
        g110SheetLookup,
      },
    });
  });
}
