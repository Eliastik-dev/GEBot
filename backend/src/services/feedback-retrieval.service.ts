/**
 * Use thumbs-up / thumbs-down feedback to steer catalog routing and LLM prompting.
 */

import { Mistral } from "@mistralai/mistralai";
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import type { Locale } from "../types/index.js";
import { feedbackEmbeddingText } from "../utils/conversation-context.js";
import type { GoldenExample } from "./golden-examples.service.js";
import type { NegativeExample } from "./negative-examples.service.js";

export type FeedbackSlugAdjustments = {
  boostSlugs: string[];
  /** Thumbs-up in the current session — stronger boost. */
  sessionBoostSlugs: string[];
  /** Similar past thumbs-down (catalog routing). */
  penalizeSlugs: string[];
  /** Thumbs-down in the current session — stronger penalty. */
  sessionPenalizeSlugs: string[];
};

export type FeedbackRetrievalContext = FeedbackSlugAdjustments & {
  goldenExamples: GoldenExample[];
  negativeExamples: NegativeExample[];
};

type FeedbackRow = {
  user_query: string | null;
  search_query: string | null;
  assistant_reply: string | null;
  product_slugs: string[] | null;
  retrieval_path: string | null;
  recommended_product: string | null;
  locale: string | null;
};

const POSITIVE_SIMILARITY_MIN = 0.26;
const NEGATIVE_SIMILARITY_MIN = 0.24;
const FEEDBACK_POOL_LIMIT = 120;

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

const EMBED_BATCH_SIZE = 8;
const EMBED_MAX_CHARS = 1_200;
const EMBED_MIN_CHARS = 8;

function sanitizeEmbedInput(text: string): string {
  return text
    .slice(0, EMBED_MAX_CHARS)
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const sanitized = texts.map((t) => sanitizeEmbedInput(t));
  const vectors: number[][] = sanitized.map(() => []);
  const pending: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < sanitized.length; i++) {
    const text = sanitized[i]!;
    if (text.length >= EMBED_MIN_CHARS) pending.push({ index: i, text });
  }
  if (pending.length === 0) return vectors;

  const client = getEmbedClient();
  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
    const { data } = await client.embeddings.create({
      model: "mistral-embed",
      inputs: batch.map((item) => item.text),
    });
    for (let j = 0; j < batch.length; j++) {
      vectors[batch[j]!.index] = data[j]?.embedding ?? [];
    }
  }
  return vectors;
}

function normalizeSlugList(slugs: unknown): string[] {
  if (!Array.isArray(slugs)) return [];
  return [...new Set(slugs.map(String).filter((s) => s.length > 2))];
}

function slugMatches(candidateSlug: string, target: string): boolean {
  const c = candidateSlug.toLowerCase();
  const t = target.toLowerCase();
  return c === t || c.includes(t) || t.includes(c);
}

async function loadFeedbackRows(feedback: 1 | -1, limit: number): Promise<FeedbackRow[]> {
  const { data, error } = await supabase
    .from("retrieval_feedback_events")
    .select("user_query, search_query, assistant_reply, product_slugs, retrieval_path, recommended_product, locale")
    .eq("feedback", feedback)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (/retrieval_feedback_events/i.test(error.message) || error.code === "42P01") return [];
    throw error;
  }

  return ((data ?? []) as FeedbackRow[]).filter((row) => feedbackEmbeddingText(row).length > 12);
}

/** Slugs from assistant replies the user liked in the current session — always boost. */
export async function loadSessionLikedSlugs(sessionId: string): Promise<string[]> {
  if (!sessionId.trim()) return [];

  const { data, error } = await supabase
    .from("chat_messages")
    .select("response_context")
    .eq("session_id", sessionId)
    .eq("role", "assistant")
    .eq("user_feedback", 1)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    if (/user_feedback|response_context/i.test(error.message ?? "") || error.code === "42703") return [];
    throw error;
  }

  const slugs = new Set<string>();
  for (const row of data ?? []) {
    const ctx = (row as { response_context?: { product_slugs?: unknown } }).response_context;
    for (const slug of normalizeSlugList(ctx?.product_slugs)) {
      slugs.add(slug);
    }
  }
  return [...slugs];
}

/** Slugs from assistant replies the user disliked in the current session — always penalize. */
export async function loadSessionDislikedSlugs(sessionId: string): Promise<string[]> {
  if (!sessionId.trim()) return [];

  const { data, error } = await supabase
    .from("chat_messages")
    .select("response_context")
    .eq("session_id", sessionId)
    .eq("role", "assistant")
    .eq("user_feedback", -1)
    .order("created_at", { ascending: false })
    .limit(8);

  if (error) {
    if (/user_feedback|response_context/i.test(error.message ?? "") || error.code === "42703") return [];
    throw error;
  }

  const slugs = new Set<string>();
  for (const row of data ?? []) {
    const ctx = (row as { response_context?: { product_slugs?: unknown } }).response_context;
    for (const slug of normalizeSlugList(ctx?.product_slugs)) {
      slugs.add(slug);
    }
  }
  return [...slugs];
}

function filterByLocale(rows: FeedbackRow[], locale: Locale): FeedbackRow[] {
  const localeFiltered = rows.filter((row) => !row.locale || row.locale === locale);
  return localeFiltered.length > 0 ? localeFiltered : rows;
}

/**
 * Single pass over stored feedback: slug boosts/penalties for routing + few-shot hints for the LLM.
 */
export async function resolveFeedbackRetrievalContext(
  intentQuery: string,
  locale: Locale,
  sessionId?: string,
): Promise<FeedbackRetrievalContext> {
  const query = intentQuery.trim();
  const empty: FeedbackRetrievalContext = {
    boostSlugs: [],
    sessionBoostSlugs: [],
    penalizeSlugs: [],
    sessionPenalizeSlugs: [],
    goldenExamples: [],
    negativeExamples: [],
  };
  if (!query) return empty;

  const embedQuery = query.slice(0, EMBED_MAX_CHARS);

  const [sessionPenalties, sessionBoosts, positiveRows, negativeRows] = await Promise.all([
    sessionId ? loadSessionDislikedSlugs(sessionId) : Promise.resolve([]),
    sessionId ? loadSessionLikedSlugs(sessionId) : Promise.resolve([]),
    loadFeedbackRows(1, FEEDBACK_POOL_LIMIT),
    loadFeedbackRows(-1, FEEDBACK_POOL_LIMIT),
  ]);

  const penalizeSlugs = new Set<string>();
  const boostSlugs = new Set<string>();
  let goldenExamples: GoldenExample[] = [];
  let negativeExamples: NegativeExample[] = [];

  const positivePool = filterByLocale(positiveRows, locale);
  const negativePool = filterByLocale(negativeRows, locale);

  if (positivePool.length === 0 && negativePool.length === 0) {
    return {
      boostSlugs: [],
      sessionBoostSlugs: sessionBoosts,
      penalizeSlugs: [],
      sessionPenalizeSlugs: sessionPenalties,
      goldenExamples,
      negativeExamples,
    };
  }

  try {
    const allRows = [...positivePool, ...negativePool];
    const vectors = await embedTexts([embedQuery, ...allRows.map((row) => feedbackEmbeddingText(row))]);
    const queryVec = vectors[0];
    if (!queryVec) {
      return {
        boostSlugs: [],
        sessionBoostSlugs: sessionBoosts,
        penalizeSlugs: [],
        sessionPenalizeSlugs: sessionPenalties,
        goldenExamples,
        negativeExamples,
      };
    }

    const positiveHits = positivePool
      .map((row, idx) => ({
        row,
        score: cosineSimilarity(queryVec, vectors[idx + 1] ?? []),
      }))
      .filter((item) => item.score >= POSITIVE_SIMILARITY_MIN)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const negativeHits = negativePool
      .map((row, idx) => ({
        row,
        score: cosineSimilarity(queryVec, vectors[positivePool.length + idx + 1] ?? []),
      }))
      .filter((item) => item.score >= NEGATIVE_SIMILARITY_MIN)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    goldenExamples = positiveHits
      .filter(({ row }) => typeof row.assistant_reply === "string" && row.assistant_reply.trim().length > 0)
      .slice(0, 2)
      .map(({ row }) => ({
        userQuery: feedbackEmbeddingText(row).slice(0, 2_500),
        assistantReply: row.assistant_reply!.trim().slice(0, 2_500),
      }));

    negativeExamples = negativeHits.slice(0, 2).map(({ row }) => ({
      userQuery: feedbackEmbeddingText(row).slice(0, 2_500),
      productSlugs: normalizeSlugList(row.product_slugs),
      retrievalPath: row.retrieval_path ?? null,
      recommendedProduct: row.recommended_product ?? null,
    }));

    for (const { row } of positiveHits) {
      for (const slug of normalizeSlugList(row.product_slugs)) {
        boostSlugs.add(slug);
      }
    }
    for (const { row } of negativeHits) {
      for (const slug of normalizeSlugList(row.product_slugs)) {
        penalizeSlugs.add(slug);
      }
    }
  } catch (error) {
    console.warn("[feedback-retrieval] embedding search failed, session penalties only", error);
  }

  return {
    boostSlugs: [...boostSlugs],
    sessionBoostSlugs: sessionBoosts,
    penalizeSlugs: [...penalizeSlugs],
    sessionPenalizeSlugs: sessionPenalties,
    goldenExamples,
    negativeExamples,
  };
}

export function feedbackSlugScoreDelta(
  slug: string,
  adjustments: FeedbackSlugAdjustments | undefined,
): number {
  if (!adjustments) return 0;
  let delta = 0;

  for (const target of adjustments.boostSlugs) {
    if (slugMatches(slug, target)) delta += 28;
  }
  for (const target of adjustments.sessionBoostSlugs) {
    if (slugMatches(slug, target)) delta += 38;
  }
  for (const target of adjustments.penalizeSlugs) {
    if (slugMatches(slug, target)) delta -= 48;
  }
  for (const target of adjustments.sessionPenalizeSlugs) {
    if (slugMatches(slug, target)) delta -= 120;
  }

  return delta;
}
