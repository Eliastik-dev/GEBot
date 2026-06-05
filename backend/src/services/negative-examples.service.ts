/**
 * Few-shot warnings from thumbs-down feedback — avoid repeating known bad retrievals.
 */

import { Mistral } from "@mistralai/mistralai";
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import type { Locale } from "../types/index.js";
import { feedbackEmbeddingText } from "../utils/conversation-context.js";

export type NegativeExample = {
  userQuery: string;
  productSlugs: string[];
  retrievalPath: string | null;
  recommendedProduct: string | null;
};

type FeedbackRow = {
  user_query: string | null;
  search_query: string | null;
  product_slugs: string[] | null;
  retrieval_path: string | null;
  recommended_product: string | null;
  locale: string | null;
};

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

let embedClient: Mistral | null = null;

function getEmbedClient(): Mistral {
  if (!embedClient) embedClient = new Mistral({ apiKey: env.MISTRAL_API_KEY });
  return embedClient;
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const client = getEmbedClient();
  const { data } = await client.embeddings.create({
    model: "mistral-embed",
    inputs: texts,
  });
  return data.map((row) => row.embedding ?? []);
}

async function loadNegativeExamples(limit: number): Promise<FeedbackRow[]> {
  const { data, error } = await supabase
    .from("retrieval_feedback_events")
    .select("user_query, search_query, product_slugs, retrieval_path, recommended_product, locale")
    .eq("feedback", -1)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (/retrieval_feedback_events/i.test(error.message) || error.code === "42P01") return [];
    throw error;
  }

  return ((data ?? []) as FeedbackRow[]).filter((row) => feedbackEmbeddingText(row).length > 12);
}

/**
 * Semantic search over recent thumbs-down; used to steer the model away from past misroutes.
 */
export async function findSimilarNegativeFeedback(
  intentQuery: string,
  locale: Locale,
  limit = 2,
): Promise<NegativeExample[]> {
  const query = intentQuery.trim();
  if (!query) return [];

  const candidates = await loadNegativeExamples(100);
  const localeFiltered = candidates.filter((row) => !row.locale || row.locale === locale);
  const pool = localeFiltered.length > 0 ? localeFiltered : candidates;
  if (pool.length === 0) return [];

  try {
    const poolTexts = pool.map((row) => feedbackEmbeddingText(row));
    const vectors = await embedTexts([query, ...poolTexts]);
    const queryVec = vectors[0];
    if (!queryVec) return [];

    const scored = pool
      .map((row, idx) => ({
        row,
        score: cosineSimilarity(queryVec, vectors[idx + 1] ?? []),
      }))
      .filter((item) => item.score > 0.42)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(({ row }) => ({
      userQuery: feedbackEmbeddingText(row).slice(0, 2_500),
      productSlugs: Array.isArray(row.product_slugs) ? row.product_slugs.map(String) : [],
      retrievalPath: row.retrieval_path ?? null,
      recommendedProduct: row.recommended_product ?? null,
    }));
  } catch (error) {
    console.warn("[negative-examples] embedding search failed, skipping warnings", error);
    return [];
  }
}
