import type { Audience } from "../../../types/index.js";
import type { ProductKnowledgeRow } from "../../../types/product-knowledge.js";
import { isThemeUncertaintyMessage } from "../../../utils/locale.js";
import {
  isExplicitProductLookupQuery,
  resolveDirectCitedProduct,
  resolveDirectTechnicalSheetProduct,
} from "../../../utils/product-mention.js";
import { lookupCatalogProductsByCitation } from "./citations.js";
import {
  fetchByExplicitProductMention,
  fetchExplicitCatalogProducts,
  searchProductKnowledge,
} from "./search.js";

/**
 * Catalogue-wide lookup for explicit fiche technique / FDS requests (any product, no theme/tag filter).
 */
export async function lookupExplicitCatalogProductForSheet(input: {
  locale: "fr" | "nl" | "pl";
  userQuery: string;
  contextQuery?: string;
  audience?: Audience | null;
}): Promise<ProductKnowledgeRow | null> {
  if (!isExplicitProductLookupQuery(input.userQuery)) return null;

  const texts = [input.userQuery, input.contextQuery].filter(Boolean) as string[];

  const byMention = await fetchByExplicitProductMention(input.locale, texts);
  const mentionCandidates = byMention;
  const fromMention = resolveDirectTechnicalSheetProduct(
    input.userQuery,
    input.contextQuery ?? "",
    mentionCandidates,
  );
  if (fromMention) return fromMention;

  const products = await searchProductKnowledge({
    locale: input.locale,
    theme: null,
    tags: [],
    userQuery: input.userQuery,
    ...(input.contextQuery ? { query: input.contextQuery } : {}),
    limit: 8,
    audience: input.audience ?? null,
  });

  return resolveDirectTechnicalSheetProduct(input.userQuery, input.contextQuery ?? "", products);
}

/** Deterministic MODE 2 when the user cites a catalogue product by name (any profile/theme). */
export async function lookupCitedCatalogProductForRecommendation(input: {
  locale: "fr" | "nl" | "pl";
  userQuery: string;
  audience?: Audience | null;
}): Promise<ProductKnowledgeRow | null> {
  if (isExplicitProductLookupQuery(input.userQuery)) return null;
  if (isThemeUncertaintyMessage(input.userQuery)) return null;

  const byExplicitPattern = await fetchExplicitCatalogProducts(input.locale, input.userQuery);
  if (byExplicitPattern.length > 0) return byExplicitPattern[0] ?? null;
  const fromPattern = resolveDirectCitedProduct(input.userQuery, byExplicitPattern);
  if (fromPattern) return fromPattern;

  const products = await lookupCatalogProductsByCitation({
    locale: input.locale,
    userQuery: input.userQuery,
    audience: input.audience ?? null,
    limit: 5,
  });
  const fromCitation = resolveDirectCitedProduct(input.userQuery, products);
  if (fromCitation) return fromCitation;

  const broader = await searchProductKnowledge({
    locale: input.locale,
    theme: null,
    tags: [],
    userQuery: input.userQuery,
    limit: 6,
    audience: null,
  });
  return resolveDirectCitedProduct(input.userQuery, broader);
}
