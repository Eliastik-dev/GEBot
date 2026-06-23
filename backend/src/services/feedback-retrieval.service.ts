/**
 * Use thumbs-up / thumbs-down feedback to steer catalog routing and LLM prompting.
 * Cross-session: recent rows in retrieval_feedback_events (lexical match only — no live embedding API).
 */

import { supabase } from "../config/supabase.js";
import type { Locale } from "../types/index.js";
import { feedbackEmbeddingText } from "../utils/conversation-context.js";

export type GoldenExample = {
  userQuery: string;
  assistantReply: string;
};

export type NegativeExample = {
  userQuery: string;
  productSlugs: string[];
  retrievalPath: string | null;
  recommendedProduct: string | null;
};

export type FeedbackSlugAdjustments = {
  boostSlugs: string[];
  /** Thumbs-up in the current session — stronger boost. */
  sessionBoostSlugs: string[];
  /** Similar past thumbs-down — soft score penalty (legacy / weak match). */
  penalizeSlugs: string[];
  /** Thumbs-down in the current session — hard exclude + strong penalty. */
  sessionPenalizeSlugs: string[];
  /** Past thumbs-down from other sessions — same strength as sessionPenalizeSlugs. */
  crossSessionPenalizeSlugs: string[];
  /** Past thumbs-up from other sessions — same strength as sessionBoostSlugs. */
  crossSessionBoostSlugs: string[];
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

type ScoredFeedbackRow = { row: FeedbackRow; embedScore: number; lexicalScore: number };

/** Cross-session 👎/👍: lexical overlap threshold (no embedding API on chat turn). */
const CROSS_SESSION_LEXICAL_MIN = 0.28;
const CROSS_SESSION_LEXICAL_MIN_TOKENS = 2;
/** Max historical feedback rows loaded per polarity — keeps chat-turn DB work bounded. */
const FEEDBACK_POOL_LIMIT = 20;

const LEXICAL_STOPWORDS = new Set([
  "avec",
  "dans",
  "pour",
  "plus",
  "tout",
  "tous",
  "toute",
  "toutes",
  "cette",
  "celui",
  "celle",
  "comme",
  "chez",
  "elle",
  "elles",
  "nous",
  "vous",
  "they",
  "that",
  "this",
  "what",
  "when",
  "where",
  "which",
  "your",
  "have",
  "been",
  "from",
  "je",
  "tu",
  "il",
  "un",
  "une",
  "des",
  "les",
  "est",
  "son",
  "ses",
  "mon",
  "mes",
  "qui",
  "que",
  "quoi",
  "comment",
  "quel",
  "quelle",
  "quels",
  "quelles",
  "recherche",
  "cherche",
  "besoin",
  "produit",
  "question",
  "particulier",
  "professionnel",
  "plomberie",
  "sanitaire",
  "assistant",
  "user",
]);

function normalizeSlugList(slugs: unknown): string[] {
  if (!Array.isArray(slugs)) return [];
  return [...new Set(slugs.map(String).filter((s) => s.length > 2))];
}

export function recommendedProductToSlugHint(name: string | null | undefined): string | null {
  if (!name?.trim()) return null;
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 2 ? slug : null;
}

/** Slugs from a stored feedback row (retrieval context + product actually recommended). */
export function collectFeedbackProductSlugsFromRow(row: FeedbackRow): string[] {
  const slugs = new Set<string>();
  for (const slug of normalizeSlugList(row.product_slugs)) slugs.add(slug);
  const fromRecommended = recommendedProductToSlugHint(row.recommended_product);
  if (fromRecommended) slugs.add(fromRecommended);
  return [...slugs];
}

/** @deprecated Alias — use collectFeedbackProductSlugsFromRow */
export function collectDislikedSlugsFromFeedbackRow(row: FeedbackRow): string[] {
  return collectFeedbackProductSlugsFromRow(row);
}

/** @deprecated Alias — use collectFeedbackProductSlugsFromRow */
export function collectLikedSlugsFromFeedbackRow(row: FeedbackRow): string[] {
  return collectFeedbackProductSlugsFromRow(row);
}

function slugMatches(candidateSlug: string, target: string): boolean {
  const c = candidateSlug.toLowerCase();
  const t = target.toLowerCase();
  return c === t || c.includes(t) || t.includes(c);
}

function normalizeLexicalText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTokens(text: string): Set<string> {
  return new Set(
    normalizeLexicalText(text)
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !LEXICAL_STOPWORDS.has(token)),
  );
}

/** Token overlap for cross-session matching — no external embedding API. */
export function lexicalFeedbackSimilarity(query: string, feedbackText: string): number {
  const queryTokens = significantTokens(query);
  const feedbackTokens = significantTokens(feedbackText);
  if (queryTokens.size === 0 || feedbackTokens.size === 0) return 0;

  let shared = 0;
  for (const token of queryTokens) {
    if (feedbackTokens.has(token)) shared += 1;
  }
  if (shared < CROSS_SESSION_LEXICAL_MIN_TOKENS) return 0;

  const denominator = Math.min(queryTokens.size, feedbackTokens.size);
  return shared / denominator;
}

function scoreFeedbackPool(query: string, pool: FeedbackRow[]): ScoredFeedbackRow[] {
  return pool.map((row) => {
    const text = feedbackEmbeddingText(row);
    return {
      row,
      embedScore: 0,
      lexicalScore: lexicalFeedbackSimilarity(query, text),
    };
  });
}

function emptyContext(
  sessionPenalties: string[],
  sessionBoosts: string[],
): FeedbackRetrievalContext {
  return {
    boostSlugs: [],
    sessionBoostSlugs: sessionBoosts,
    penalizeSlugs: [],
    sessionPenalizeSlugs: sessionPenalties,
    crossSessionPenalizeSlugs: [],
    crossSessionBoostSlugs: [],
    goldenExamples: [],
    negativeExamples: [],
  };
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

function slugsFromResponseContext(ctx: {
  product_slugs?: unknown;
  recommended_product?: string | null;
} | null | undefined): string[] {
  const slugs = new Set<string>();
  for (const slug of normalizeSlugList(ctx?.product_slugs)) slugs.add(slug);
  const fromRecommended = recommendedProductToSlugHint(ctx?.recommended_product);
  if (fromRecommended) slugs.add(fromRecommended);
  return [...slugs];
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
    for (const slug of slugsFromResponseContext(
      (row as { response_context?: { product_slugs?: unknown; recommended_product?: string } }).response_context,
    )) {
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
    for (const slug of slugsFromResponseContext(
      (row as { response_context?: { product_slugs?: unknown; recommended_product?: string } }).response_context,
    )) {
      slugs.add(slug);
    }
  }
  return [...slugs];
}

function filterByLocale(rows: FeedbackRow[], locale: Locale): FeedbackRow[] {
  const localeFiltered = rows.filter((row) => !row.locale || row.locale === locale);
  return localeFiltered.length > 0 ? localeFiltered : rows;
}

function applyLexicalCrossSessionNegativeFallback(
  query: string,
  negativePool: FeedbackRow[],
  crossSessionPenalizeSlugs: Set<string>,
  negativeExamples: NegativeExample[],
): void {
  const lexicalHits = scoreFeedbackPool(query, negativePool)
    .filter((item) => item.lexicalScore >= CROSS_SESSION_LEXICAL_MIN)
    .sort((a, b) => b.lexicalScore - a.lexicalScore)
    .slice(0, 4);

  for (const { row } of lexicalHits) {
    for (const slug of collectFeedbackProductSlugsFromRow(row)) {
      crossSessionPenalizeSlugs.add(slug);
    }
  }

  if (negativeExamples.length === 0) {
    for (const { row } of lexicalHits.slice(0, 2)) {
      negativeExamples.push({
        userQuery: feedbackEmbeddingText(row).slice(0, 2_500),
        productSlugs: collectFeedbackProductSlugsFromRow(row),
        retrievalPath: row.retrieval_path ?? null,
        recommendedProduct: row.recommended_product ?? null,
      });
    }
  }
}

function applyLexicalCrossSessionPositiveFallback(
  query: string,
  positivePool: FeedbackRow[],
  crossSessionBoostSlugs: Set<string>,
  goldenExamples: GoldenExample[],
): void {
  const lexicalHits = scoreFeedbackPool(query, positivePool)
    .filter((item) => item.lexicalScore >= CROSS_SESSION_LEXICAL_MIN)
    .sort((a, b) => b.lexicalScore - a.lexicalScore)
    .slice(0, 4);

  for (const { row } of lexicalHits) {
    for (const slug of collectFeedbackProductSlugsFromRow(row)) {
      crossSessionBoostSlugs.add(slug);
    }
  }

  if (goldenExamples.length === 0) {
    for (const { row } of lexicalHits.slice(0, 2)) {
      if (typeof row.assistant_reply !== "string" || !row.assistant_reply.trim()) continue;
      goldenExamples.push({
        userQuery: feedbackEmbeddingText(row).slice(0, 2_500),
        assistantReply: row.assistant_reply.trim().slice(0, 2_500),
      });
    }
  }
}

/**
 * Single pass over stored feedback: slug boosts/penalties for routing + few-shot hints for the LLM.
 * Uses session SQL + lexical match on the most recent feedback rows only (no Mistral embed on chat turn).
 */
export async function resolveFeedbackRetrievalContext(
  intentQuery: string,
  locale: Locale,
  sessionId?: string,
): Promise<FeedbackRetrievalContext> {
  const query = intentQuery.trim();
  if (!query) return emptyContext([], []);

  const [sessionPenalties, sessionBoosts, positiveRows, negativeRows] = await Promise.all([
    sessionId ? loadSessionDislikedSlugs(sessionId) : Promise.resolve([]),
    sessionId ? loadSessionLikedSlugs(sessionId) : Promise.resolve([]),
    loadFeedbackRows(1, FEEDBACK_POOL_LIMIT),
    loadFeedbackRows(-1, FEEDBACK_POOL_LIMIT),
  ]);

  const positivePool = filterByLocale(positiveRows, locale);
  const negativePool = filterByLocale(negativeRows, locale);

  if (positivePool.length === 0 && negativePool.length === 0) {
    return emptyContext(sessionPenalties, sessionBoosts);
  }

  const crossSessionPenalizeSlugs = new Set<string>();
  const crossSessionBoostSlugs = new Set<string>();
  const penalizeSlugs = new Set<string>();
  const boostSlugs = new Set<string>();
  const goldenExamples: GoldenExample[] = [];
  const negativeExamples: NegativeExample[] = [];

  applyLexicalCrossSessionNegativeFallback(query, negativePool, crossSessionPenalizeSlugs, negativeExamples);
  applyLexicalCrossSessionPositiveFallback(query, positivePool, crossSessionBoostSlugs, goldenExamples);

  const negativeHits = scoreFeedbackPool(query, negativePool)
    .filter((item) => item.lexicalScore >= CROSS_SESSION_LEXICAL_MIN)
    .sort((a, b) => b.lexicalScore - a.lexicalScore)
    .slice(0, 3);
  for (const { row } of negativeHits) {
    for (const slug of collectFeedbackProductSlugsFromRow(row)) {
      penalizeSlugs.add(slug);
    }
  }

  const positiveHits = scoreFeedbackPool(query, positivePool)
    .filter((item) => item.lexicalScore >= CROSS_SESSION_LEXICAL_MIN)
    .sort((a, b) => b.lexicalScore - a.lexicalScore)
    .slice(0, 3);
  for (const { row } of positiveHits) {
    for (const slug of collectFeedbackProductSlugsFromRow(row)) {
      boostSlugs.add(slug);
    }
  }

  return {
    boostSlugs: [...boostSlugs],
    sessionBoostSlugs: sessionBoosts,
    penalizeSlugs: [...penalizeSlugs],
    sessionPenalizeSlugs: sessionPenalties,
    crossSessionPenalizeSlugs: [...crossSessionPenalizeSlugs],
    crossSessionBoostSlugs: [...crossSessionBoostSlugs],
    goldenExamples,
    negativeExamples,
  };
}

/** Hard-exclude slugs penalized in-session or cross-session (for filters). */
export function hardPenalizeSlugs(adjustments: FeedbackSlugAdjustments | undefined): string[] {
  if (!adjustments) return [];
  return [
    ...new Set([
      ...adjustments.sessionPenalizeSlugs,
      ...adjustments.crossSessionPenalizeSlugs,
    ]),
  ];
}

/** Slugs to prioritize from in-session or cross-session 👍 (for catalogue injection). */
export function hardBoostSlugs(adjustments: FeedbackSlugAdjustments | undefined): string[] {
  if (!adjustments) return [];
  return [
    ...new Set([
      ...adjustments.sessionBoostSlugs,
      ...adjustments.crossSessionBoostSlugs,
    ]),
  ];
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
  for (const target of adjustments.crossSessionBoostSlugs) {
    if (slugMatches(slug, target)) delta += 38;
  }
  for (const target of adjustments.sessionBoostSlugs) {
    if (slugMatches(slug, target)) delta += 38;
  }
  for (const target of adjustments.penalizeSlugs) {
    if (slugMatches(slug, target)) delta -= 48;
  }
  for (const target of adjustments.crossSessionPenalizeSlugs) {
    if (slugMatches(slug, target)) delta -= 120;
  }
  for (const target of adjustments.sessionPenalizeSlugs) {
    if (slugMatches(slug, target)) delta -= 120;
  }

  return delta;
}

/** @deprecated Prefer resolveFeedbackRetrievalContext — kept for direct callers. */
export async function findSimilarGoldenExamples(
  intentQuery: string,
  locale: Locale,
  limit = 2,
): Promise<GoldenExample[]> {
  const ctx = await resolveFeedbackRetrievalContext(intentQuery, locale);
  return ctx.goldenExamples.slice(0, limit);
}

/** @deprecated Prefer resolveFeedbackRetrievalContext — kept for direct callers. */
export async function findSimilarNegativeFeedback(
  intentQuery: string,
  locale: Locale,
  limit = 2,
): Promise<NegativeExample[]> {
  const ctx = await resolveFeedbackRetrievalContext(intentQuery, locale);
  return ctx.negativeExamples.slice(0, limit);
}
