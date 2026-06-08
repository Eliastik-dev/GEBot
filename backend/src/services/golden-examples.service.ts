/**
 * Dynamic few-shot prompting from validated (thumbs-up) retrieval feedback.
 */

import type { Locale } from "../types/index.js";
import { resolveFeedbackRetrievalContext } from "./feedback-retrieval.service.js";

export type GoldenExample = {
  userQuery: string;
  assistantReply: string;
};

/** @deprecated Prefer resolveFeedbackRetrievalContext — kept for direct callers. */
export async function findSimilarGoldenExamples(
  intentQuery: string,
  locale: Locale,
  limit = 2,
): Promise<GoldenExample[]> {
  const ctx = await resolveFeedbackRetrievalContext(intentQuery, locale);
  return ctx.goldenExamples.slice(0, limit);
}
