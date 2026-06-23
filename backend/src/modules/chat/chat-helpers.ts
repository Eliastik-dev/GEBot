import type { Audience, ProductTheme } from "../../types/index.js";
import { ANSWER_CACHE_VERSION } from "../../config/constants.js";

export function nodeSlugFromRetrievalItem(item: unknown): string {
  const metadata = (item as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
  return String(metadata.slug ?? "");
}

export function filterRetrievalNodesByFeedbackPenalties(
  nodes: unknown[],
  penalizeSlugs: string[],
  hardPenalizeSlugsList: string[] = [],
): unknown[] {
  if (nodes.length === 0) return nodes;

  if (hardPenalizeSlugsList.length > 0) {
    const withoutHard = nodes.filter((item) => {
      const slug = nodeSlugFromRetrievalItem(item);
      if (!slug) return true;
      return !hardPenalizeSlugsList.some((target) => slug.includes(target) || target.includes(slug));
    });
    if (withoutHard.length > 0) return withoutHard;
  }

  if (penalizeSlugs.length === 0) return nodes;
  const filtered = nodes.filter((item) => {
    const slug = nodeSlugFromRetrievalItem(item);
    if (!slug) return true;
    return !penalizeSlugs.some((target) => slug.includes(target) || target.includes(slug));
  });
  return filtered.length > 0 ? filtered : nodes;
}

export function buildAnswerCacheKey(
  locale: string,
  audience: Audience | null,
  theme: ProductTheme | null | undefined,
  queryForRetrieval: string,
  penaltySlugs: string[] = [],
  boostSlugs: string[] = [],
): string {
  const penaltyKey =
    penaltySlugs.length > 0 ? penaltySlugs.slice().sort().join("|") : "none";
  const boostKey = boostSlugs.length > 0 ? boostSlugs.slice().sort().join("|") : "none";
  return `${ANSWER_CACHE_VERSION}|${locale}|${audience}|${theme ?? "none"}|${queryForRetrieval.toLowerCase()}|pen:${penaltyKey}|boost:${boostKey}`;
}
