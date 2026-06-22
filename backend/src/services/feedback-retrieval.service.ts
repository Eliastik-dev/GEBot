/**
 * Use thumbs-up / thumbs-down feedback to steer catalog routing and LLM prompting.
 * Cross-session: past 👎/👍 in retrieval_feedback_events (embedding + lexical match).
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

const POSITIVE_SIMILARITY_MIN = 0.26;
const NEGATIVE_SIMILARITY_MIN = 0.24;
/** Cross-session 👎: lower bar than one-shot routing penalty. */
const CROSS_SESSION_EMBED_MIN = 0.2;
const CROSS_SESSION_LEXICAL_MIN = 0.28;
const CROSS_SESSION_LEXICAL_MIN_TOKENS = 2;
const FEEDBACK_POOL_LIMIT = 120;

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

/** Token overlap for cross-session matching when embeddings are unavailable or weak. */
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

function isCrossSessionNegativeMatch(embedScore: number, lexicalScore: number): boolean {
  return embedScore >= CROSS_SESSION_EMBED_MIN || lexicalScore >= CROSS_SESSION_LEXICAL_MIN;
}

function isCrossSessionPositiveMatch(embedScore: number, lexicalScore: number): boolean {
  return embedScore >= CROSS_SESSION_EMBED_MIN || lexicalScore >= CROSS_SESSION_LEXICAL_MIN;
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

function mergeCrossSessionNegativeHits(
  scored: ScoredFeedbackRow[],
  embedScores: number[],
  poolOffset: number,
): ScoredFeedbackRow[] {
  const merged = new Map<string, ScoredFeedbackRow>();
  for (let i = 0; i < scored.length; i++) {
    const item = scored[i]!;
    item.embedScore = embedScores[poolOffset + i] ?? 0;
    const key = feedbackEmbeddingText(item.row).slice(0, 200);
    if (!isCrossSessionNegativeMatch(item.embedScore, item.lexicalScore)) continue;
    const prev = merged.get(key);
    if (!prev || item.embedScore + item.lexicalScore > prev.embedScore + prev.lexicalScore) {
      merged.set(key, item);
    }
  }
  return [...merged.values()].sort(
    (a, b) => b.embedScore + b.lexicalScore - (a.embedScore + a.lexicalScore),
  );
}

function mergeCrossSessionPositiveHits(
  scored: ScoredFeedbackRow[],
  embedScores: number[],
): ScoredFeedbackRow[] {
  const merged = new Map<string, ScoredFeedbackRow>();
  for (let i = 0; i < scored.length; i++) {
    const item = scored[i]!;
    item.embedScore = embedScores[i] ?? 0;
    const key = feedbackEmbeddingText(item.row).slice(0, 200);
    if (!isCrossSessionPositiveMatch(item.embedScore, item.lexicalScore)) continue;
    const prev = merged.get(key);
    if (!prev || item.embedScore + item.lexicalScore > prev.embedScore + prev.lexicalScore) {
      merged.set(key, item);
    }
  }
  return [...merged.values()].sort(
    (a, b) => b.embedScore + b.lexicalScore - (a.embedScore + a.lexicalScore),
  );
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

function buildGoldenExamples(
  crossSessionPositiveHits: ScoredFeedbackRow[],
  positiveHits: Array<{ row: FeedbackRow; score: number }>,
): GoldenExample[] {
  const examples: GoldenExample[] = [];

  for (const { row } of crossSessionPositiveHits) {
    if (typeof row.assistant_reply !== "string" || !row.assistant_reply.trim()) continue;
    examples.push({
      userQuery: feedbackEmbeddingText(row).slice(0, 2_500),
      assistantReply: row.assistant_reply.trim().slice(0, 2_500),
    });
    if (examples.length >= 2) return examples;
  }

  for (const { row } of positiveHits) {
    if (typeof row.assistant_reply !== "string" || !row.assistant_reply.trim()) continue;
    examples.push({
      userQuery: feedbackEmbeddingText(row).slice(0, 2_500),
      assistantReply: row.assistant_reply.trim().slice(0, 2_500),
    });
    if (examples.length >= 2) return examples;
  }

  return examples;
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
  if (!query) return emptyContext([], []);

  const embedQuery = query.slice(0, EMBED_MAX_CHARS);

  const [sessionPenalties, sessionBoosts, positiveRows, negativeRows] = await Promise.all([
    sessionId ? loadSessionDislikedSlugs(sessionId) : Promise.resolve([]),
    sessionId ? loadSessionLikedSlugs(sessionId) : Promise.resolve([]),
    loadFeedbackRows(1, FEEDBACK_POOL_LIMIT),
    loadFeedbackRows(-1, FEEDBACK_POOL_LIMIT),
  ]);

  const penalizeSlugs = new Set<string>();
  const boostSlugs = new Set<string>();
  const crossSessionPenalizeSlugs = new Set<string>();
  const crossSessionBoostSlugs = new Set<string>();
  let goldenExamples: GoldenExample[] = [];
  let negativeExamples: NegativeExample[] = [];

  const positivePool = filterByLocale(positiveRows, locale);
  const negativePool = filterByLocale(negativeRows, locale);

  if (positivePool.length === 0 && negativePool.length === 0) {
    return emptyContext(sessionPenalties, sessionBoosts);
  }

  const lexicalNegativeScored = scoreFeedbackPool(embedQuery, negativePool);
  const lexicalPositiveScored = scoreFeedbackPool(embedQuery, positivePool);

  try {
    const allRows = [...positivePool, ...negativePool];
    const vectors = await embedTexts([embedQuery, ...allRows.map((row) => feedbackEmbeddingText(row))]);
    const queryVec = vectors[0];
    if (!queryVec?.length) {
      applyLexicalCrossSessionNegativeFallback(embedQuery, negativePool, crossSessionPenalizeSlugs, negativeExamples);
      applyLexicalCrossSessionPositiveFallback(embedQuery, positivePool, crossSessionBoostSlugs, goldenExamples);
      return {
        ...emptyContext(sessionPenalties, sessionBoosts),
        crossSessionPenalizeSlugs: [...crossSessionPenalizeSlugs],
        crossSessionBoostSlugs: [...crossSessionBoostSlugs],
        goldenExamples,
        negativeExamples,
      };
    }

    const positiveEmbedScores = positivePool.map((_, idx) => cosineSimilarity(queryVec, vectors[idx + 1] ?? []));
    const negativeEmbedScores = negativePool.map((_, idx) =>
      cosineSimilarity(queryVec, vectors[positivePool.length + idx + 1] ?? []),
    );

    const positiveHits = positivePool
      .map((row, idx) => ({
        row,
        score: positiveEmbedScores[idx] ?? 0,
      }))
      .filter((item) => item.score >= POSITIVE_SIMILARITY_MIN)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const negativeHits = negativePool
      .map((row, idx) => ({
        row,
        score: negativeEmbedScores[idx] ?? 0,
      }))
      .filter((item) => item.score >= NEGATIVE_SIMILARITY_MIN)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const crossSessionNegativeHits = mergeCrossSessionNegativeHits(
      lexicalNegativeScored,
      negativeEmbedScores,
      0,
    ).slice(0, 5);

    const crossSessionPositiveHits = mergeCrossSessionPositiveHits(
      lexicalPositiveScored,
      positiveEmbedScores,
    ).slice(0, 5);

    goldenExamples = buildGoldenExamples(crossSessionPositiveHits, positiveHits);

    const negativeExampleRows =
      crossSessionNegativeHits.length > 0
        ? crossSessionNegativeHits
        : negativeHits.map(({ row, score }) => ({
            row,
            embedScore: score,
            lexicalScore: lexicalFeedbackSimilarity(embedQuery, feedbackEmbeddingText(row)),
          }));

    negativeExamples = negativeExampleRows.slice(0, 2).map(({ row }) => ({
      userQuery: feedbackEmbeddingText(row).slice(0, 2_500),
      productSlugs: collectFeedbackProductSlugsFromRow(row),
      retrievalPath: row.retrieval_path ?? null,
      recommendedProduct: row.recommended_product ?? null,
    }));

    for (const { row } of positiveHits) {
      for (const slug of collectFeedbackProductSlugsFromRow(row)) {
        boostSlugs.add(slug);
      }
    }
    for (const { row } of negativeHits) {
      for (const slug of collectFeedbackProductSlugsFromRow(row)) {
        penalizeSlugs.add(slug);
      }
    }
    for (const { row } of crossSessionNegativeHits) {
      for (const slug of collectFeedbackProductSlugsFromRow(row)) {
        crossSessionPenalizeSlugs.add(slug);
      }
    }
    for (const { row } of crossSessionPositiveHits) {
      for (const slug of collectFeedbackProductSlugsFromRow(row)) {
        crossSessionBoostSlugs.add(slug);
      }
    }
  } catch (error) {
    console.warn("[feedback-retrieval] embedding search failed, lexical cross-session fallback", error);
    applyLexicalCrossSessionNegativeFallback(embedQuery, negativePool, crossSessionPenalizeSlugs, negativeExamples);
    applyLexicalCrossSessionPositiveFallback(embedQuery, positivePool, crossSessionBoostSlugs, goldenExamples);
  }

  if (crossSessionPenalizeSlugs.size === 0 && negativePool.length > 0) {
    applyLexicalCrossSessionNegativeFallback(embedQuery, negativePool, crossSessionPenalizeSlugs, negativeExamples);
  }
  if (crossSessionBoostSlugs.size === 0 && positivePool.length > 0) {
    applyLexicalCrossSessionPositiveFallback(embedQuery, positivePool, crossSessionBoostSlugs, goldenExamples);
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
