/**
 * Boucle testeur : dislike → utilisateur indique le bon produit → like → apprentissage cross-session.
 */

import type { StoredMessage } from "../types/index.js";
import { isProfileOnlyMessage, isThemeOnlyMessage, isThemeUncertaintyMessage } from "./locale.js";
import { mentionsLikelyProductPhrase } from "./product-mention.js";
import { isYesNoAnswer } from "./response.js";

export type StoredMessageWithFeedback = StoredMessage & {
  id?: string;
  user_feedback?: number | null;
};

export type FeedbackProductCorrectionContext = {
  /** Question initiale à indexer pour le feedback (pas le seul nom de produit). */
  trainingQuery: string;
  dislikedProductSlugs: string[];
};

function isSubstantiveUserTurn(content: string): boolean {
  const q = content.trim();
  if (q.length < 8) return false;
  if (isYesNoAnswer(q)) return false;
  if (isProfileOnlyMessage(q)) return false;
  if (isThemeOnlyMessage(q)) return false;
  return true;
}

/** Première question utilisateur utile dans la session (hors onboarding). */
export function findFirstSubstantiveUserQuestion(messages: StoredMessage[]): string | null {
  for (const row of messages) {
    if (row.role !== "user") continue;
    const content = row.content.trim();
    if (isSubstantiveUserTurn(content)) return content;
  }
  return null;
}

/** Extrait la 1re question user d'un transcript `user: …\\nassistant: …`. */
export function extractOriginalUserQuestionFromTranscript(transcript: string): string | null {
  for (const line of transcript.split("\n")) {
    const match = line.match(/^user:\s*(.+)$/i);
    if (!match?.[1]) continue;
    const content = match[1].trim();
    if (isSubstantiveUserTurn(content)) return content;
  }
  return null;
}

/**
 * Tour immédiatement après un 👎 : l'utilisateur cite le produit attendu.
 * Ex. mauvaise reco → dislike → « je pensais à Exthane colle et joint ».
 */
export function resolveFeedbackProductCorrectionContext(
  historyMessages: StoredMessageWithFeedback[],
  currentMessage: string,
): FeedbackProductCorrectionContext | null {
  if (historyMessages.length < 2) return null;

  const lastRow = historyMessages[historyMessages.length - 1];
  if (lastRow?.role !== "user" || lastRow.content.trim() !== currentMessage.trim()) {
    return null;
  }

  const dislikedAssistant = historyMessages[historyMessages.length - 2];
  if (dislikedAssistant?.role !== "assistant" || dislikedAssistant.user_feedback !== -1) {
    return null;
  }

  const ctx = dislikedAssistant.response_context ?? {};
  const trainingQuery =
    (typeof ctx.query_for_retrieval === "string" && ctx.query_for_retrieval.trim()) ||
    findFirstSubstantiveUserQuestion(historyMessages.slice(0, -2)) ||
    currentMessage.trim();

  const dislikedProductSlugs = Array.isArray(ctx.product_slugs)
    ? ctx.product_slugs.map(String).filter((s) => s.length > 2)
    : [];

  return { trainingQuery, dislikedProductSlugs };
}

/** Message court citant un produit → ne pas diluer avec tout l'historique pour le matching catalogue. */
export function resolveProductCitationQuery(currentMessage: string, enrichedQuery: string): string {
  const msg = currentMessage.trim();
  if (isThemeUncertaintyMessage(msg)) return msg;
  if (msg.length > 0 && msg.length <= 100 && mentionsLikelyProductPhrase(msg)) {
    return msg;
  }
  return enrichedQuery.trim() || msg;
}

/** User turns only — avoids false catalogue hits from assistant onboarding prompts (« domaine », etc.). */
export function buildUserCitationScanText(history: StoredMessage[], message: string): string {
  const parts = history
    .filter((row) => row.role === "user")
    .map((row) => row.content.trim())
    .filter(Boolean);
  const current = message.trim();
  if (current) parts.push(current);
  return parts.join("\n");
}
