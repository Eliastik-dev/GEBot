/**
 * GEB-only brand policy — never promote competitor trademarks in assistant output.
 */

import type { Locale } from "../types/index.js";
import { normalizeText } from "./text.js";

/** Non-GEB brands often cited in sealing / plumbing / building (FR/EU market). */
const COMPETITOR_BRAND_RE =
  /\b(sika|mapei|mapesil|kerakoll|bostik|rubson|henkel|loctite|3m\b|wurth|würth|fischer\b|hilti|den\s+braven|ottoseal|casco|weber\b|knauf|araldite|sicaflex|sofix|resiblock|wd[\s-]?40|nitrites|blue\s+diamant|ct1\b|grip\s+flex|afix|ceys|soudal|sader|zwaluw|tremco|illbruck)\b/i;

export function containsCompetitorBrandMention(text: string): boolean {
  return COMPETITOR_BRAND_RE.test(normalizeText(text));
}

function sentenceHasCompetitor(sentence: string): boolean {
  const n = normalizeText(sentence);
  return COMPETITOR_BRAND_RE.test(n);
}

const REDACTION_FOOTER: Record<string, string> = {
  fr: "Je ne peux recommander que des produits **GEB** issus du catalogue officiel — pas de marque concurrente.",
  en: "I can only recommend **GEB** products from the official catalogue — not competitor brands.",
  nl: "Ik kan alleen **GEB**-producten uit de officiële catalogus aanbevelen — geen concurrenten.",
  pl: "Mogę polecić wyłącznie produkty **GEB** z oficjalnego katalogu — bez marek konkurencyjnych.",
};

/**
 * Remove sentences that name competitor brands; append a short GEB-only reminder if needed.
 */
export function sanitizeCompetitorBrandMentions(answer: string, locale: Locale): string {
  if (!containsCompetitorBrandMention(answer)) return answer;

  const parts = answer.split(/(?<=[.!?])\s+|\n{2,}/);
  const kept: string[] = [];
  let removed = false;

  for (const part of parts) {
    const chunk = part.trim();
    if (!chunk) continue;
    if (sentenceHasCompetitor(chunk)) {
      removed = true;
      continue;
    }
    kept.push(chunk);
  }

  let out = kept.join("\n\n").trim();
  if (!out) {
    out =
      locale === "en"
        ? "I can only advise on GEB catalogue products. Please describe your application (fluid, material, access) so I can check the matching GEB technical sheet."
        : locale === "nl"
          ? "Ik kan alleen GEB-catalogusproducten adviseren. Beschrijf uw toepassing zodat ik de passende GEB-fiche kan raadplegen."
          : locale === "pl"
            ? "Mogę doradzać wyłącznie w zakresie produktów GEB z katalogu. Opisz zastosowanie, abym mógł dobrać kartę techniczną GEB."
            : "Je ne peux conseiller que des produits **GEB** du catalogue. Précisez votre application (fluide, support, accès) pour que je m’appuie sur la fiche technique GEB adaptée.";
  } else if (removed) {
    const footer = REDACTION_FOOTER[locale] ?? REDACTION_FOOTER.fr!;
    if (!out.includes(footer.slice(0, 20))) {
      out = `${out}\n\n${footer}`;
    }
  }
  return out;
}

export const GEB_ONLY_BRAND_RULE_PROMPT = `**GEB-ONLY BRANDS (mandatory):**
- Recommend, cite, compare, or suggest ONLY products from the **GEB** catalogue present in context (Gebétanche, Gebsoplast, Propfeu, Collex, etc.).
- NEVER name or endorse competitor brands (e.g. Sika, Mapei, Kerakoll, Bostik, Henkel, Loctite, 3M, Würth, Soudal, Weber, Knauf, WD-40, etc.) — even as alternatives, equivalents, or "you could also use…".
- If the user names a competitor product, do NOT validate it; say you only advise on GEB SKUs and redirect to the closest **GEB** product from context, or Consumer Service / Lab if none fits.
- Manufacturer of the user's equipment (tap brand, bottle brand) may be mentioned only for orientation — never a sealing competitor brand as solution.`;
