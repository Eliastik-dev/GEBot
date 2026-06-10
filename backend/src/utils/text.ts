import { NO_CONTEXT_FALLBACK, NO_MATCH_USAGE_FALLBACK } from "../config/constants.js";
import type { Locale, StoredMessage, Audience } from "../types/index.js";

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function normalizeText(value: string): string {
  return decodeHtmlEntities(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}


export function normalizeKey(value: string): string {
  return normalizeText(value).replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

/** Question factuelle (couleurs, teinte, disponibilité…) plutôt qu'une demande de recommandation pure. */
export function isInformationalProductQuestion(query: string): boolean {
  const q = normalizeText(query);
  return (
    /\b(existe|existe t il|disponible|couleur|couleurs|teint|teinter|teintable|peut on|peut on le|est ce que|est ce qu|est ce|combien|quelle taille|quelle couleur|plusieurs|variante|version|gamme|reference|jaunir|jaunissement|premium|qualite|resiste|resistant|fongicide|durable|odeur|incolore|transparent)\b/.test(
      q,
    ) || (/\?\s*$/.test(query.trim()) && /\b(le|la|les|ce|cette|produit|email|silicone|mastic|il|un)\b/.test(q))
  );
}


export function extractFluid(raw: string): string | null {
  const m = normalizeText(raw);
  // Check specific/compound fluids first to avoid "chauffage à eau" → "eau"
  if (/\b(chauffage|radiateur|circuit\s+chauffage|caloporteur)\b/.test(m)) return "chauffage";
  if (/\b(fioul|huile|oil)\b/.test(m)) return "huile";
  if (/\b(gaz|gas)\b/.test(m)) return "gaz";
  // For "eau": skip if context is about building surfaces (rain infiltration into tiles is not a pipe fluid)
  const isSurfaceContext = /\b(carrelage|terrasse|facade|dalle|toiture|toit|mur|pierre|brique)\b/.test(m);
  const isPlumbingWater = /\b(tuyau|canalisation|raccord|robinet|conduit|evacuation|egout|wc|sanitaire|potable)\b/.test(m);
  if (/\b(eaux|eau|water|woda|potable|usee|usees|evacuation|egout|drain|sewer|wc\b|sanitaire)\b/.test(m)) {
    if (isSurfaceContext && !isPlumbingWater) return null;
    return "eau";
  }
  return null;
}


export function toAudienceLabel(audience: Audience): string {
  return audience === "professional" ? "professionnel" : "particulier";
}


export function isFluidClarificationPrompt(message: string): boolean {
  const m = normalizeText(message);
  return (
    m.includes("fluide") ||
    m.includes("medium") ||
    m.includes("eau, gaz") ||
    m.includes("milieu au contact du joint") ||
    m.includes("plusieurs familles produits")
  );
}


export function resolveClarificationContext(
  currentMessage: string,
  historyMessages: StoredMessage[],
): { effectiveQuestion: string; fluid: string } | null {
  const fluid = extractFluid(currentMessage);
  if (!fluid) return null;

  let clarificationIdx = -1;
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const row = historyMessages[i];
    if (row?.role === "assistant" && isFluidClarificationPrompt(row.content)) {
      clarificationIdx = i;
      break;
    }
  }
  if (clarificationIdx < 0) return null;

  for (let i = clarificationIdx - 1; i >= 0; i--) {
    const row = historyMessages[i];
    if (row?.role === "user" && !extractFluid(row.content)) {
      return {
        effectiveQuestion: `${row.content} (fluide: ${fluid})`,
        fluid,
      };
    }
  }
  return null;
}


export function buildNoContextFallback(locale: Locale, effectiveQuestion: string, fluid: string | null): string {
  const q = normalizeText(effectiveQuestion);
  if (locale === "fr" && fluid === "eau" && q.includes("silicone") && q.includes("evier")) {
    return "Je ne trouve pas de silicone specifique pour evier de cuisine destine a l'eau dans mes fiches techniques GEB";
  }
  if (locale === "en") {
    return "Sorry, I cannot find a GEB technical sheet that exactly matches this usage.";
  }
  if (locale === "nl") {
    return "Sorry, ik kan geen specifieke GEB-technische fiche voor deze toepassing vinden.";
  }
  if (locale === "pl") {
    return "Przepraszam, nie moge znalezc konkretnej karty technicznej GEB dla tego zastosowania.";
  }
  return NO_MATCH_USAGE_FALLBACK;
}


export function getGenericNoAnswerFallback(locale: Locale): string {
  if (locale === "en") return "Sorry, I cannot find this technical information in the available GEB sheets.";
  if (locale === "nl") return "Sorry, ik kan deze technische informatie niet vinden in de beschikbare GEB-fiches.";
  if (locale === "pl") return "Przepraszam, nie moge znalezc tej informacji technicznej w dostepnych kartach GEB.";
  return NO_CONTEXT_FALLBACK;
}

export function toHistoryPrompt(messages: StoredMessage[]): string {
  return messages
    .map((row) => `${row.role === "user" ? "Utilisateur" : "Assistant"}: ${row.content}`)
    .join("\n");
}

/** True when the session already has at least one saved assistant reply (multi-turn). */
export function hasOngoingConversation(messages: StoredMessage[]): boolean {
  return messages.some((row) => row.role === "assistant" && row.content.trim().length > 0);
}
