/**
 * Few-shot warnings from thumbs-down feedback — avoid repeating known bad retrievals.
 */

import type { Locale } from "../types/index.js";
import { resolveFeedbackRetrievalContext } from "./feedback-retrieval.service.js";

export type NegativeExample = {
  userQuery: string;
  productSlugs: string[];
  retrievalPath: string | null;
  recommendedProduct: string | null;
};

/** @deprecated Prefer resolveFeedbackRetrievalContext — kept for direct callers. */
export async function findSimilarNegativeFeedback(
  intentQuery: string,
  locale: Locale,
  limit = 2,
): Promise<NegativeExample[]> {
  const ctx = await resolveFeedbackRetrievalContext(intentQuery, locale);
  return ctx.negativeExamples.slice(0, limit);
}
