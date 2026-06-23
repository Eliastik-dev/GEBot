import type { Audience, ProductTheme } from "../../types/index.js";
import { ANSWER_CACHE_VERSION, PROMPT_MAX_CONTEXT_CHARS, PROMPT_MAX_CONTEXT_NODES } from "../../config/constants.js";
import { capContextNodes } from "../../services/rag.service.js";

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

function retrievalNodeText(item: unknown): string {
  const wrap = item as { node?: { text?: string }; text?: string };
  if (typeof wrap.node?.text === "string") return wrap.node.text;
  if (typeof wrap.text === "string") return wrap.text;
  return "";
}

function truncateRetrievalNodeText(item: unknown, maxChars: number): unknown {
  const text = retrievalNodeText(item);
  if (text.length <= maxChars) return item;
  const truncated = `${text.slice(0, maxChars).trimEnd()}…`;
  const wrap = item as { node?: { text?: string }; text?: string };
  if (wrap.node) {
    return { ...(item as object), node: { ...wrap.node, text: truncated } };
  }
  if (typeof wrap.text === "string") {
    return { ...(item as object), text: truncated };
  }
  return item;
}

/** Cap node count and total text size before sending context to the LLM. */
export function compactRetrievalNodesForPrompt(
  nodes: unknown[],
  maxNodes = PROMPT_MAX_CONTEXT_NODES,
  maxTotalChars = PROMPT_MAX_CONTEXT_CHARS,
): unknown[] {
  const capped = capContextNodes(nodes, maxNodes);
  if (capped.length === 0) return capped;
  const perNodeBudget = Math.max(320, Math.floor(maxTotalChars / capped.length));
  let remaining = maxTotalChars;
  const compacted: unknown[] = [];
  for (const node of capped) {
    if (remaining <= 0) break;
    const budget = Math.min(perNodeBudget, remaining);
    const next = truncateRetrievalNodeText(node, budget);
    compacted.push(next);
    remaining -= Math.min(retrievalNodeText(next).length, budget);
  }
  return compacted;
}
