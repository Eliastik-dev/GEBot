/**
 * Build multi-turn conversation text for feedback storage and few-shot retrieval.
 */

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
  const sq = row.search_query?.trim() ?? "";
  const uq = row.user_query?.trim() ?? "";
  if (sq.length >= 24) return sq;
  if (uq.length >= 24) return uq;
  return sq || uq;
}
