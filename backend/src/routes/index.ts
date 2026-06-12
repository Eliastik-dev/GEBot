import type { Express, Request, Response } from "express";
import { getBuildInfo } from "../config/build-info.js";
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import { postChat, type ChatDeps } from "../controllers/chat.controller.js";
import { getGeolocation } from "../controllers/geolocation.controller.js";
import { postFeedback } from "../controllers/feedback.controller.js";
import {
  chatRateLimiter,
  feedbackRateLimiter,
  geolocationRateLimiter,
} from "../middleware/security.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { isProduction } from "../utils/http.js";
import { chatBodySchema, feedbackBodySchema, geolocationQuerySchema } from "../validation/schemas.js";
import {
  countProductKnowledge,
  getProductKnowledgeBySlug,
  lookupCitedCatalogProductForRecommendation,
  lookupExplicitCatalogProductForSheet,
} from "../services/product-knowledge.service.js";
import { productKnowledgeLocale } from "../services/product-router.service.js";

/** Bump when retrieval behaviour changes — compare with /health on the VM after deploy. */
export const RETRIEVAL_FEATURES_VERSION = "2026-06-12-cross-catalog-poele-accent";

export function registerRoutes(app: Express, chatDeps: ChatDeps): void {
  app.get(
    "/api/geolocation",
    geolocationRateLimiter,
    validateQuery(geolocationQuerySchema),
    getGeolocation,
  );
  app.post(
    "/api/chat",
    chatRateLimiter,
    validateBody(chatBodySchema),
    (req, res) => postChat(req, res, chatDeps),
  );
  app.post("/api/feedback", feedbackRateLimiter, validateBody(feedbackBodySchema), postFeedback);
  app.get("/health", async (req: Request, res: Response) => {
    const detailToken = typeof req.query.token === "string" ? req.query.token : "";
    const showDetails = !isProduction() || (env.HEALTH_DETAIL_TOKEN !== "" && detailToken === env.HEALTH_DETAIL_TOKEN);
    const build = getBuildInfo();
    const pkLocale = productKnowledgeLocale("fr");
    let supabaseOk = false;
    let productKnowledgeFr: number | null = null;
    let g110InCatalog = false;
    let g110SheetLookup: string | null = null;
    let cremeLustranteInCatalog = false;
    let poeleOpenRecommendationSlug: string | null = null;
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
          const creme = await getProductKnowledgeBySlug("creme-lustrante", pkLocale);
          cremeLustranteInCatalog = Boolean(creme);
          const poeleHit = await lookupCitedCatalogProductForRecommendation({
            locale: pkLocale,
            userQuery: "quel produit pour lustrer et raviver les couleurs d'un poêle à bois",
            audience: "particulier",
          });
          poeleOpenRecommendationSlug = poeleHit?.slug ?? null;
        }
      }
    } catch {
      supabaseOk = false;
    }
    const catalogReady =
      env.PRODUCT_KNOWLEDGE_ENABLED && productKnowledgeFr !== null && productKnowledgeFr > 0;
    if (!showDetails) {
      res.json({ ok: supabaseOk });
      return;
    }
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
        cremeLustranteInCatalog,
        poeleOpenRecommendationSlug,
      },
    });
  });
}
