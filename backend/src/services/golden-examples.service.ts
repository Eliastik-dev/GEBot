/**
 * Dynamic few-shot prompting from validated (thumbs-up) retrieval feedback.
 */

import { Mistral } from "@mistralai/mistralai";
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import type { Locale } from "../types/index.js";
import { feedbackEmbeddingText } from "../utils/conversation-context.js";

export type GoldenExample = {
  userQuery: string;
  assistantReply: string;
};

type FeedbackRow = {
  user_query: string | null;
  search_query: string | null;
  assistant_reply: string | null;
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

async function loadPositiveExamples(locale: Locale, limit: number): Promise<FeedbackRow[]> {
  const { data, error } = await supabase
    .from("retrieval_feedback_events")
    .select("user_query, search_query, assistant_reply, locale")
    .eq("feedback", 1)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (/retrieval_feedback_events/i.test(error.message) || error.code === "42P01") return [];
    throw error;
  }

  return ((data ?? []) as FeedbackRow[]).filter(
    (row) =>
      feedbackEmbeddingText(row).length > 12 &&
      typeof row.assistant_reply === "string" &&
      row.assistant_reply.trim().length > 0,
  );
}

/**
 * Semantic search over recent thumbs-up interactions; returns top matches for few-shot prompting.
 */
export async function findSimilarGoldenExamples(
  intentQuery: string,
  locale: Locale,
  limit = 2,
): Promise<GoldenExample[]> {
  const query = intentQuery.trim();
  if (!query) return [];

  const candidates = await loadPositiveExamples(locale, 80);
  const localeFiltered = candidates.filter((row) => !row.locale || row.locale === locale);
  const pool = localeFiltered.length > 0 ? localeFiltered : candidates;
  if (pool.length === 0) return [];

  try {
    const texts = [query, ...pool.map((row) => feedbackEmbeddingText(row))];
    const vectors = await embedTexts(texts);
    const queryVec = vectors[0];
    if (!queryVec) return [];

    const scored = pool
      .map((row, idx) => ({
        row,
        score: cosineSimilarity(queryVec, vectors[idx + 1] ?? []),
      }))
      .filter((item) => item.score > 0.35)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(({ row }) => ({
      userQuery: feedbackEmbeddingText(row).slice(0, 2_500),
      assistantReply: row.assistant_reply!.trim().slice(0, 2_500),
    }));
  } catch (error) {
    console.warn("[golden-examples] embedding search failed, skipping few-shot", error);
    return [];
  }
}
