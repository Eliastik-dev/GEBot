/**
 * Phase 3: Persist user feedback with retrieval context for catalog improvement.
 */

import { supabase } from "../config/supabase.js";
import type { ExtractedMetadata } from "../modules/retrieval/intent-extractor.js";
import type { ResponseContextSnapshot } from "../types/retrieval-feedback.js";
import { extractRecommendedProduct } from "../utils/amazon.js";
import { fireAndForget } from "../utils/async.js";
import { extractOriginalUserQuestionFromTranscript } from "../utils/feedback-correction.js";
import {
  buildConversationTranscript,
  lastUserTurnContent,
  type ConversationTurn,
} from "../utils/conversation-context.js";

type ChatMessageRow = {
  id: string;
  session_id: string;
  role: string;
  content: string;
  user_feedback: number | null;
  judge_score: number | null;
  intent: string | null;
  metadata_extracted: ExtractedMetadata | null;
  response_context: ResponseContextSnapshot | null;
  created_at: string;
};

function normalizeSlugToken(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function slugMatchesRecommended(slug: string, recommended: string): boolean {
  const slugNorm = normalizeSlugToken(slug);
  const recNorm = normalizeSlugToken(recommended);
  if (!slugNorm || !recNorm) return false;
  return slugNorm.includes(recNorm) || recNorm.includes(slugNorm) || recNorm.split("-").every((part) => part.length > 2 && slugNorm.includes(part));
}

export function detectRetrievalMismatch(
  recommendedProduct: string | null,
  productSlugs: string[],
): boolean {
  if (!recommendedProduct || productSlugs.length === 0) return false;
  return !productSlugs.some((slug) => slugMatchesRecommended(slug, recommendedProduct));
}

async function loadAssistantMessage(messageId: string, sessionId: string): Promise<ChatMessageRow | null> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("id, session_id, role, content, user_feedback, judge_score, intent, metadata_extracted, response_context, created_at")
    .eq("id", messageId)
    .eq("session_id", sessionId)
    .eq("role", "assistant")
    .maybeSingle();

  if (error) throw error;
  return (data as ChatMessageRow | null) ?? null;
}

/** Full session turns before the rated assistant message (not only the last user line). */
async function loadConversationContextBefore(
  sessionId: string,
  beforeCreatedAt: string,
): Promise<{ transcript: string; lastUserTurn: string | null }> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .lt("created_at", beforeCreatedAt)
    .order("created_at", { ascending: true })
    .limit(24);

  if (error || !data?.length) {
    const { data: lastUser } = await supabase
      .from("chat_messages")
      .select("content")
      .eq("session_id", sessionId)
      .eq("role", "user")
      .lt("created_at", beforeCreatedAt)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const content = (lastUser as { content?: string } | null)?.content?.trim() ?? null;
    return { transcript: content ? `user: ${content}` : "", lastUserTurn: content };
  }

  const turns = data as ConversationTurn[];
  return {
    transcript: buildConversationTranscript(turns),
    lastUserTurn: lastUserTurnContent(turns),
  };
}

async function loadSessionMeta(sessionId: string): Promise<{ theme: string | null; locale: string | null }> {
  const { data, error } = await supabase
    .from("chat_sessions")
    .select("theme, locale")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (error) return { theme: null, locale: null };
  const row = data as { theme?: string; locale?: string } | null;
  return { theme: row?.theme ?? null, locale: row?.locale ?? null };
}

export async function recordRetrievalFeedback(
  messageId: string,
  sessionId: string,
  feedback: -1 | 0 | 1,
): Promise<void> {
  const assistant = await loadAssistantMessage(messageId, sessionId);
  if (!assistant) {
    console.warn("[retrieval-feedback] assistant message not found", { messageId, sessionId });
    return;
  }

  const ctx = assistant.response_context ?? {};
  const productSlugs = Array.isArray(ctx.product_slugs) ? ctx.product_slugs.map(String) : [];
  const useCaseTags = Array.isArray(ctx.use_case_tags) ? ctx.use_case_tags.map(String) : [];
  const recommendedProduct = extractRecommendedProduct(assistant.content);
  const retrievalMismatch = detectRetrievalMismatch(recommendedProduct, productSlugs);

  const conversation = await loadConversationContextBefore(sessionId, assistant.created_at);
  const trainingQuery =
    (typeof ctx.training_query === "string" && ctx.training_query.trim()) ||
    (typeof ctx.query_for_retrieval === "string" && ctx.query_for_retrieval.trim()) ||
    extractOriginalUserQuestionFromTranscript(conversation.transcript) ||
    conversation.lastUserTurn ||
    null;
  const userQuery =
    trainingQuery ||
    (typeof ctx.conversation_transcript === "string" && ctx.conversation_transcript.trim()) ||
    conversation.transcript ||
    (typeof ctx.query_for_retrieval === "string" ? ctx.query_for_retrieval : null) ||
    null;
  const sessionMeta = await loadSessionMeta(sessionId);
  const meta = assistant.metadata_extracted;

  const row = {
    message_id: messageId,
    session_id: sessionId,
    feedback,
    locale: sessionMeta.locale,
    theme: sessionMeta.theme,
    user_query: userQuery,
    assistant_reply: assistant.content.slice(0, 12_000),
    search_query: trainingQuery ?? ctx.search_query ?? null,
    intent: assistant.intent,
    retrieval_path: ctx.retrieval_path ?? null,
    product_slugs: productSlugs,
    use_case_tags: useCaseTags,
    recommended_product: recommendedProduct,
    judge_score: assistant.judge_score,
    metadata_extracted: meta,
    retrieval_mismatch: retrievalMismatch,
    notes: retrievalMismatch
      ? "Recommended product name does not match any slug in retrieval context"
      : null,
  };

  const { error } = await supabase.from("retrieval_feedback_events").insert(row);

  if (error) {
    const msg = error.message ?? "";
    if (/retrieval_feedback_events/i.test(msg) || error.code === "42P01" || error.code === "PGRST205") {
      console.warn("[retrieval-feedback] table not found — apply migration 20260519_retrieval_feedback.sql");
      return;
    }
    throw error;
  }

  console.log("[retrieval-feedback] recorded", {
    messageId,
    feedback,
    retrieval_path: ctx.retrieval_path,
    product_slugs: productSlugs,
    recommended_product: recommendedProduct,
    retrieval_mismatch: retrievalMismatch,
    judge_score: assistant.judge_score,
  });
}

export function scheduleRetrievalFeedback(
  messageId: string,
  sessionId: string,
  feedback: -1 | 0 | 1,
): void {
  fireAndForget(recordRetrievalFeedback(messageId, sessionId, feedback), "retrieval-feedback.record");
}

export type FeedbackExportRow = {
  created_at: string;
  feedback: number;
  user_query: string | null;
  recommended_product: string | null;
  product_slugs: string[];
  retrieval_path: string | null;
  retrieval_mismatch: boolean;
  judge_score: number | null;
  intent: string | null;
  theme: string | null;
};

export async function exportNegativeFeedback(limit = 50): Promise<FeedbackExportRow[]> {
  const { data, error } = await supabase
    .from("retrieval_feedback_events")
    .select(
      "created_at, feedback, user_query, recommended_product, product_slugs, retrieval_path, retrieval_mismatch, judge_score, intent, theme",
    )
    .eq("feedback", -1)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (/retrieval_feedback_events/i.test(error.message) || error.code === "42P01") return [];
    throw error;
  }

  return ((data ?? []) as FeedbackExportRow[]).map((row) => ({
    ...row,
    product_slugs: Array.isArray(row.product_slugs) ? row.product_slugs.map(String) : [],
  }));
}
