import type { Audience, ProductTheme } from "../../../types/index.js";
import type { ProductKnowledgeRow } from "../../../types/product-knowledge.js";
import type { FeedbackSlugAdjustments } from "../../../services/feedback-retrieval.service.js";

/** Retry catalog SQL without session theme when themed filter returns too few rows. */
export const PRODUCT_KNOWLEDGE_THEME_FALLBACK_MIN = 3;

export type ProductKnowledgeSearchInput = {
  locale: "fr" | "nl" | "pl";
  theme?: ProductTheme | null;
  tags?: string[];
  material?: string | null;
  fluid?: string | null;
  query?: string;
  /** Requête enrichie (synonymes, thème, fluide) — utilisée en plus de `query` pour le scoring. */
  searchQuery?: string;
  /** Message utilisateur brut (avant expansion LLM) — prioritaire pour citation produit explicite. */
  userQuery?: string;
  limit?: number;
  /** Filtrer les fiches « grand public » pour les sessions pro. */
  audience?: Audience | null;
  /** Boost / penalize slugs from user thumbs-up/down feedback. */
  feedbackAdjustments?: FeedbackSlugAdjustments;
};

export type CatalogCitationResult = {
  products: ProductKnowledgeRow[];
  best: ProductKnowledgeRow | null;
  bestScore: number;
  /** True only for explicit brand/code/name citations — not generic plumbing vocabulary. */
  highConfidence: boolean;
};

/** Produit cité explicitement par l'utilisateur (hors top tags/thème). */
export const EXPLICIT_CATALOG_PRODUCT_PATTERNS: Array<{ pattern: RegExp; slug: string }> = [
  { pattern: /\bpool\s*[\*\s]?\s*colmateur\b/i, slug: "pool-colmateur-de-fuites" },
  { pattern: /\bcolmateur\s+(de\s+)?fuites?\b/i, slug: "pool-colmateur-de-fuites" },
  { pattern: /\bpool\s*[\*\s]?\s*lekdichter\b/i, slug: "pool-lekdichter" },
  {
    pattern: /\b(?:pool\s*[\*]?\s*)?kit\s+(?:de\s+)?reparation\s+liner\b/i,
    slug: "pool-kit-de-reparation-liner",
  },
  { pattern: /\bkit\s+reparation\s+liner\b/i, slug: "pool-kit-de-reparation-liner" },
  {
    pattern: /\b(?:pool\s*[\*]?\s*)?mastic\s+reparation\s+fuites?\b/i,
    slug: "pool-mastic-reparation-fuites",
  },
  { pattern: /\b(?:pool\s*[\*]?\s*)?mastic\s+piscine\b/i, slug: "pool-mastic-piscine" },
  { pattern: /\bms[\s*-]?zinc\b/i, slug: "ms-zinc" },
  { pattern: /\btoiturol\b/i, slug: "toiturol" },
  { pattern: /\bacrybat\b/i, slug: "acrybat" },
  { pattern: /\bgebetanche\b/i, slug: "gebetanche-eau-potable-rt1-geb" },
  { pattern: /\b(?:deboucheur|debouch|ontstopper)\s+universel\b/i, slug: "ontstopper-universeel" },
  { pattern: /\buniversele\s+ontstopper\b/i, slug: "universele-ontstopper" },
  { pattern: /\b(?:deboucheur|debouch|ontstopper)\s+professionnel\b/i, slug: "ontstopper-professioneel" },
  { pattern: /\budrazniacz\s+uniwersalny\b/i, slug: "udrazniacz-uniwersalny" },
  { pattern: /\b(?:destructeur|destruction)\s+d['']?\s*odeurs?\b/i, slug: "ontstopper-geurverwijderaar" },
  { pattern: /\b(bande\s+(de\s+)?reparation|bande\s+reparation)\b/i, slug: "bande-de-reparation" },
  { pattern: /\b(ruban\s+(de\s+)?reparation|ruban\s+reparation)\b/i, slug: "bande-de-reparation" },
  {
    pattern:
      /\b(lustr|creme\s+lustrante|raviv\w*\s+(les\s+)?couleur).*\b(poele|cheminee|insert|foyer)\b|\b(poele|cheminee|insert|foyer).*\b(lustr|raviv\w*\s+(les\s+)?couleur|creme\s+lustrante)\b/i,
    slug: "creme-lustrante",
  },
];

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function combineRetrievalText(input: ProductKnowledgeSearchInput): string {
  return [input.userQuery, input.query, input.searchQuery].filter(Boolean).join("\n").trim();
}

export function explicitMatchTexts(input: ProductKnowledgeSearchInput): string[] {
  return [input.userQuery, input.query, input.searchQuery].filter(Boolean) as string[];
}
