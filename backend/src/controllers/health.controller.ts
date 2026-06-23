import type { Request, Response } from "express";
import { getBuildInfo } from "../config/build-info.js";
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import { RETRIEVAL_FEATURES_VERSION } from "../config/retrieval.js";
import {
  countProductKnowledge,
  getProductKnowledgeBySlug,
  lookupCitedCatalogProductForRecommendation,
  lookupExplicitCatalogProductForSheet,
} from "../services/product-knowledge.service.js";
import { productKnowledgeLocale } from "../services/product-router.service.js";
import { isProduction } from "../utils/http.js";

const HEALTH_DETAIL_CACHE_MS = 60_000;

let healthDetailCache: { expiresAt: number; body: Record<string, unknown> } | null = null;

function isAuthorizedHealthDetail(req: Request): boolean {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
  if (env.HEALTH_DETAIL_TOKEN) {
    return token === env.HEALTH_DETAIL_TOKEN;
  }
  return !isProduction();
}

/** Public liveness probe — no database I/O. */
export function getHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    version: RETRIEVAL_FEATURES_VERSION,
  });
}

async function buildHealthDetailPayload(): Promise<Record<string, unknown>> {
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

  return {
    status: supabaseOk ? "ok" : "degraded",
    version: RETRIEVAL_FEATURES_VERSION,
    ok: supabaseOk,
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
  };
}

/** Protected diagnostics — live DB/catalog probes (cached 60s). */
export async function getHealthDetail(req: Request, res: Response): Promise<void> {
  if (!isAuthorizedHealthDetail(req)) {
    if (isProduction() && !env.HEALTH_DETAIL_TOKEN) {
      res.status(503).json({ error: "HEALTH_DETAIL_TOKEN is not configured" });
      return;
    }
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const now = Date.now();
  if (healthDetailCache && healthDetailCache.expiresAt > now) {
    res.json(healthDetailCache.body);
    return;
  }

  const body = await buildHealthDetailPayload();
  healthDetailCache = { expiresAt: now + HEALTH_DETAIL_CACHE_MS, body };
  res.json(body);
}
