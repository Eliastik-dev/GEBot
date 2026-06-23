import type { Audience, ProductTheme } from "../../../types/index.js";
import type { ProductKnowledgeRow } from "../../../types/product-knowledge.js";
import { catalogAudienceVisibleForSession } from "../../../services/product-theme.service.js";
import { decodeHtmlEntities } from "../../../utils/text.js";
import { isThemeUncertaintyMessage } from "../../../utils/locale.js";
import {
  collectCatalogSearchTerms,
  computeExplicitProductMatchScore,
  extractCatalogProductCodes,
  matchesCatalogCodeTerm,
  productHasNamePriority,
} from "../../../utils/product-mention.js";
import { normalizeText, type CatalogCitationResult } from "./types.js";
import {
  fetchByExplicitProductMention,
  fetchByNameTerms,
  fetchExplicitCatalogProducts,
} from "./search.js";

const CITED_PRODUCT_MATCH_MIN = 35;

function adjustCitationContextScore(
  product: ProductKnowledgeRow,
  text: string,
  baseScore: number,
  sessionAudience?: Audience | null,
  sessionTheme?: ProductTheme | null,
): number {
  const q = normalizeText(text);
  const slug = product.slug.toLowerCase();
  const title = normalizeText(decodeHtmlEntities(product.canonical_name));
  const piscineContext = /\b(piscine|pool|bassin|liner)\b/.test(q);
  const plumbingContext = /\b(canalisation|tuyau|tube|pvc|pehd|plomberie|sanitaire|multicouche)\b/.test(q);
  const rejectsPiscine =
    /\b(pas\s+(de\s+)?piscine|pas\s+pour\s+la\s+piscine|hors\s+piscine|ne\s+cherche\s+pas)\b/.test(q) &&
    /\b(piscine|pool)\b/.test(q);

  let score = baseScore;

  if (slug.startsWith("pool-") || title.includes("pool")) {
    if (!piscineContext || rejectsPiscine) score -= 45;
    if (plumbingContext && !piscineContext) score -= 35;
  }
  if (product.theme === "piscine" && !piscineContext) score -= 30;
  if (product.theme === "plomberie" && plumbingContext) score += 10;
  if (sessionTheme && product.theme === sessionTheme) score += 8;
  if (sessionTheme && product.theme && product.theme !== sessionTheme) score -= 18;
  if (
    sessionAudience &&
    !catalogAudienceVisibleForSession(sessionAudience, product.canonical_name, product.slug, product.audience ?? "all")
  ) {
    score -= 20;
  }

  if (/\bbande\b/.test(q) && /\breparation\b/.test(q)) {
    if (slug === "bande-de-reparation" || (slug.includes("bande") && slug.includes("reparation") && !slug.startsWith("pool-"))) {
      score += 28;
    }
    if (slug.startsWith("pool-") && slug.includes("bande")) score -= 20;
  }

  return score;
}

/**
 * Global catalogue citation resolver — fuzzy match against canonical_name/slug
 * from any user phrasing (no per-product regex whitelist).
 */
export async function detectCatalogProductCitations(input: {
  locale: "fr" | "nl" | "pl";
  text: string;
  audience?: Audience | null;
  limit?: number;
  minScore?: number;
}): Promise<CatalogCitationResult> {
  if (isThemeUncertaintyMessage(input.text)) {
    return { products: [], best: null, bestScore: 0 };
  }
  const texts = [input.text];
  const minScore = input.minScore ?? CITED_PRODUCT_MATCH_MIN;
  const terms = collectCatalogSearchTerms(input.text);

  const byExplicit = await fetchExplicitCatalogProducts(input.locale, input.text);
  const explicitSlugs = new Set(byExplicit.map((p) => p.slug));
  const byName = terms.length > 0 ? await fetchByNameTerms(input.locale, terms) : [];
  const byExplicitMention = await fetchByExplicitProductMention(input.locale, texts);
  const qNorm = normalizeText(input.text);
  const bandeLookup =
    /\bbande\b/.test(qNorm) && /\breparation\b/.test(qNorm)
      ? await fetchByNameTerms(input.locale, [
          "bande-de-reparation",
          "bande de reparation",
          "bande reparation",
        ])
      : [];

  const merged = new Map<string, ProductKnowledgeRow>();
  for (const row of [...byExplicit, ...byExplicitMention, ...byName, ...bandeLookup]) {
    merged.set(row.slug, row);
  }

  const codes = extractCatalogProductCodes(input.text);
  const scored = [...merged.values()]
    .map((product) => {
      const rawScore = computeExplicitProductMatchScore(product, texts);
      const explicitPatternHit = explicitSlugs.has(product.slug);
      const adjusted = adjustCitationContextScore(
        product,
        input.text,
        rawScore + (explicitPatternHit ? 55 : 0),
        input.audience,
        null,
      );
      return {
        product,
        score: adjusted,
        rawScore,
        codeHit: codes.some((code) => matchesCatalogCodeTerm(product.slug, product.canonical_name, code)),
        explicitPatternHit,
      };
    })
    .filter(
      (item) =>
        item.score >= minScore ||
        item.codeHit ||
        item.explicitPatternHit ||
        productHasNamePriority(item.product, texts),
    )
    .sort(
      (a, b) =>
        Number(b.explicitPatternHit) - Number(a.explicitPatternHit) ||
        Number(b.codeHit) - Number(a.codeHit) ||
        b.score - a.score,
    );

  const products = scored.slice(0, input.limit ?? 3).map((item) => item.product);
  const best = scored[0];
  return {
    products,
    best: best?.product ?? null,
    bestScore: best?.score ?? 0,
  };
}

/** Fetch catalogue rows when the user cites a product by code/name in conversation. */
export async function lookupCatalogProductsByCitation(input: {
  locale: "fr" | "nl" | "pl";
  userQuery: string;
  audience?: Audience | null;
  limit?: number;
}): Promise<ProductKnowledgeRow[]> {
  const detected = await detectCatalogProductCitations({
    locale: input.locale,
    text: input.userQuery,
    ...(input.audience != null ? { audience: input.audience } : {}),
    limit: input.limit ?? 2,
  });
  return detected.products;
}
