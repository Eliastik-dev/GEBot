/**
 * Build multi-turn conversation text for feedback storage and few-shot retrieval.
 */

import type { StoredMessage } from "../types/index.js";
import {
  cleanRecommendedProductLabel,
  extractBoldCatalogProductName,
  extractRecommendedProduct,
} from "./amazon.js";
import { hasOngoingConversation, isInformationalProductQuestion, normalizeText } from "./text.js";

export type ConversationTurn = { role: string; content: string };

export function buildConversationTranscript(
  turns: ConversationTurn[],
  options?: { maxChars?: number; maxTurns?: number },
): string {
  const maxTurns = options?.maxTurns ?? 22;
  const maxChars = options?.maxChars ?? 8_000;
  const slice = turns
    .slice(-maxTurns)
    .map((t) => ({ role: t.role, content: t.content.trim() }))
    .filter((t) => t.content.length > 0);
  let text = slice.map((t) => `${t.role}: ${t.content}`).join("\n");
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars);
    const firstNl = text.indexOf("\n");
    if (firstNl > 0 && firstNl < 120) text = text.slice(firstNl + 1);
  }
  return text;
}

export function lastUserTurnContent(turns: ConversationTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === "user") return turns[i]!.content.trim();
  }
  return null;
}

/** Best text for semantic match against stored feedback (enriched search > full transcript). */
export function feedbackEmbeddingText(row: {
  search_query?: string | null;
  user_query?: string | null;
}): string {
  const uq = row.user_query?.trim() ?? "";
  const sq = row.search_query?.trim() ?? "";
  if (uq.length >= 20 && uq.length >= sq.length) return uq;
  if (sq.length >= 24) return sq;
  return uq || sq;
}

/** Last catalogue product named in an assistant reply this session (MODE 2 heading or MODE 1 bold name). */
export function getLastDiscussedProductFromHistory(messages: StoredMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (row?.role !== "assistant") continue;
    const fromMode2 = cleanRecommendedProductLabel(extractRecommendedProduct(row.content));
    if (fromMode2) return fromMode2;
    const fromBold = cleanRecommendedProductLabel(extractBoldCatalogProductName(row.content));
    if (fromBold) return fromBold;
    const fromCtx = row.response_context?.recommended_product?.trim();
    if (fromCtx) {
      const cleaned = cleanRecommendedProductLabel(fromCtx);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

/** @deprecated Use getLastDiscussedProductFromHistory — MODE 1 answers also name products in bold. */
export function getLastRecommendedProductFromHistory(messages: StoredMessage[]): string | null {
  return getLastDiscussedProductFromHistory(messages);
}

/** Slug from the last assistant turn that discussed a catalogue product. */
export function getLastDiscussedProductSlugFromHistory(messages: StoredMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (row?.role !== "assistant") continue;
    const slugs = row.response_context?.product_slugs;
    if (Array.isArray(slugs) && slugs.length > 0) {
      const slug = String(slugs[0] ?? "").trim();
      if (slug.length > 2) return slug;
    }
  }
  return null;
}

/** User asks where to buy the product already discussed in this session. */
export function isPurchaseAvailabilityQuestion(query: string): boolean {
  const q = normalizeText(query);
  if (/\b(ou|où)\s+(acheter|trouver|commander|le\s+trouver)\b/.test(q)) return true;
  if (/\b(acheter|commander)\s+(ce|le|la|du|de\s+la)\s+(produit|meme)\b/.test(q)) return true;
  if (/\b(disponib|en\s+stock|magasin|amazon|revendeur)\b/.test(q) && /\b(produit|acheter|trouver)\b/.test(q)) {
    return true;
  }
  return false;
}

/**
 * User is asking about a product already recommended — answer in MODE 1, do not replay the full fiche.
 */
export function isProductFollowUpQuestion(query: string, historyMessages: StoredMessage[]): boolean {
  if (!hasOngoingConversation(historyMessages)) return false;
  if (!getLastDiscussedProductFromHistory(historyMessages)) return false;

  if (isPurchaseAvailabilityQuestion(query)) return true;

  if (isInformationalProductQuestion(query)) return true;

  const q = normalizeText(query);

  const followUpSignals =
    /\b(jaunir|jaunissement|jaune|premium|qualite|meilleur|resiste|resistant|durable|garanti|fongicide|antimoisissure|odeur|seche|secher|temps de sechage|couleur|blanc|transparent|incolore|sans acide|acetique|cartouche|pistolet|format|tube|carton)\b/.test(
      q,
    ) ||
    /\b(est ce|c est|s agit il|compatible|convient il|peut on l|utiliser pour|utilisable|toujours le meme|ce produit|celui ci|celui la|le meme|deja conseille|que vous avez|que tu as|dont vous parlez)\b/.test(
      q,
    ) ||
    /\b(pourquoi|comment|combien de temps|quelle difference|comparer)\b/.test(q);

  const isNewRecommendationRequest =
    /\b(recommand|conseill|suggere|propose|quelle? (colle|mastic|silicone|produit)|quel (colle|mastic|silicone|produit)|cherche|besoin d)\b/.test(
      q,
    ) && !/\b(ce produit|celui ci|le meme|deja)\b/.test(q);

  return followUpSignals && !isNewRecommendationRequest;
}
