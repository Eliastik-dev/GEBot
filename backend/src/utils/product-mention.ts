import type { ProductKnowledgeRow } from "../types/product-knowledge.js";
import { isThemeUncertaintyMessage } from "./locale.js";
import { decodeHtmlEntities } from "./text.js";
export const EXPLICIT_PRODUCT_MATCH_MIN = 40;
/** Score needed to reorder results purely by product-name match (avoids weak partial hits). */
export const EXPLICIT_PRODUCT_NAME_PRIORITY_MIN = 48;

const MENTION_STOP_WORDS = new Set([
  "je",
  "veux",
  "voudrais",
  "souhaite",
  "besoin",
  "donnez",
  "donne",
  "moi",
  "merci",
  "pour",
  "fiche",
  "technique",
  "produit",
  "produits",
  "la",
  "le",
  "les",
  "du",
  "de",
  "des",
  "un",
  "une",
  "d",
  "l",
  "au",
  "aux",
  "chez",
  "geb",
  "gebetanche",
  "fds",
  "ft",
  "tds",
  "pdf",
  "document",
  "documentation",
  "telecharger",
  "telecharge",
  "avoir",
  "trouver",
  "trouve",
  "cherche",
  "chercher",
  "recherche",
  "quelle",
  "quel",
  "quels",
  "quelles",
  "envoyer",
  "envoie",
  "application",
  "applications",
  "utilisation",
  "professionnel",
  "particulier",
  "domaine",
  "probleme",
  "situe",
  "sais",
  "sait",
  "connait",
  "connais",
  "connaisse",
  "idee",
]);

const SHORT_MENTION_TOKENS = new Set(["abs", "pvc", "ppr", "pe", "pp", "dn", "ms", "rt1", "60"]);

/** Catalogue family names users cite directly (deboucheur, G110, Gebsoplast…). */
const CATALOG_PRODUCT_FAMILY_RE =
  /\b(inhibiteur|desembou|desembouant|deboucheur|debouch|detartrant|detartrans|colmateur|colmatant|gebsoplast|collex|ms[\s-]?zinc|toiturol|silicone|chrono|gebetanche|filasse|ptfe|collafeu|propfeu|acrybat|geborizon|startex|ontstopper|udrazniacz|lekdichter)\b/;

export function normalizeProductMentionText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** G-series and hyphenated catalogue references cited in user queries. */
export function extractCatalogProductCodes(text: string): string[] {
  const q = normalizeProductMentionText(text);
  const codes = new Set<string>();
  for (const match of q.matchAll(/\bg[-\s]?(\d+)\b/g)) {
    codes.add(`g${match[1]}`);
  }
  if (/\bms[\s-]?zinc\b/.test(q)) codes.add("ms-zinc");
  if (/\bdetartrans\b/.test(q)) codes.add("detartrans");
  return [...codes];
}

export function isExplicitProductLookupQuery(text: string): boolean {
  const q = normalizeProductMentionText(text);
  if (
    /\b(fiche\s+technique|fiche\s+produit|fiche\s+de\s+donnees|fds|ft\b|tds|documentation\s+technique)\b/.test(q)
  ) {
    return true;
  }
  if (/\b(je\s+veux|donnez[- ]?moi|j['']ai\s+besoin|merci\s+de)\b/.test(q) && /\b(fiche|fds|produit|pdf)\b/.test(q)) {
    return true;
  }
  if (/\b(lien|url|pdf|telecharg|envoy|envoi|acced|acces)\b/.test(q) && /\b(fiche|fds|ft\b|tds|technique|pdf)\b/.test(q)) {
    return true;
  }
  return false;
}

/** Strip lookup boilerplate and return the cited product phrase, if any. */
export function extractExplicitProductMention(text: string): string | null {
  const q = normalizeProductMentionText(decodeHtmlEntities(text));
  if (!isExplicitProductLookupQuery(q)) return null;

  let mention = q
    .replace(/\b(je\s+veux|je\s+voudrais|je\s+souhaite|donnez[- ]?moi|j['']ai\s+besoin\s+de|merci\s+de)\b/g, " ")
    .replace(/\b(la|le|les|du|de|des|un|une|d|l|au|aux|chez|geb|gebetanche)\b/g, " ")
    .replace(/\b(fiche\s+technique|fiche\s+produit|fds|ft\b|tds|pdf|document|documentation)\b/g, " ")
    .replace(/\b(pour|application|applications|utilisation)\b[\s\S]*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (mention.length < 2) return null;

  const tokens = tokenizeProductMention(mention);
  if (tokens.length === 0) return null;
  return tokens.join(" ");
}

function tokenizeProductMention(mention: string): string[] {
  const q = normalizeProductMentionText(mention);
  const tokens: string[] = [];

  for (const code of extractCatalogProductCodes(q)) {
    tokens.push(code);
  }

  for (const raw of q.split(/[^a-z0-9]+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (MENTION_STOP_WORDS.has(token)) continue;
    if (token.length < 3 && !SHORT_MENTION_TOKENS.has(token)) continue;
    if (!tokens.includes(token)) tokens.push(token);
  }

  return tokens;
}

/** Search terms derived from an explicit product mention (for Supabase ilike). */
export function extractProductSearchTerms(texts: string[]): string[] {
  const terms = new Set<string>();

  for (const text of texts) {
    const mention = extractExplicitProductMention(text);
    const sources = mention ? [mention, text] : [text];

    for (const source of sources) {
      const q = normalizeProductMentionText(decodeHtmlEntities(source));
      for (const code of extractCatalogProductCodes(q)) {
        terms.add(code);
      }

      const tokens = tokenizeProductMention(q);
      for (const token of tokens) {
        terms.add(token);
      }

      if (tokens.length >= 2) {
        terms.add(tokens.slice(0, 3).join("-"));
        terms.add(tokens.slice(0, 2).join("-"));
      }

      const slugLike = q.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      if (slugLike.length >= 4) terms.add(slugLike);
    }
  }

  return [...terms].filter((term) => sanitizeIlikeSearchTerm(term) !== null);
}

/** Product-like phrases after articles (la bande réparation, le ms zinc, etc.). */
export function extractProductPhraseCandidates(text: string): string[] {
  const q = normalizeProductMentionText(decodeHtmlEntities(text));
  const phrases = new Set<string>();

  for (const m of q.matchAll(
    /\b(?:la|le|les|du|de|des|un|une|avec|pour|sur|chez)\s+((?:[a-z0-9][a-z0-9-]*\s+){0,5}[a-z0-9][a-z0-9-]*)/g,
  )) {
    const phrase = (m[1] ?? "").trim();
    if (phrase.length < 4) continue;
    if ([...MENTION_STOP_WORDS].some((w) => phrase === w)) continue;
    phrases.add(phrase);
  }

  const stripped = q
    .replace(/\b(est ce que|est ce qu|peut on|puis je|je peux|comment|pourquoi|quelle|quel|quels|quelles)\b/g, " ")
    .replace(/\b(fuite|fuites|canalisation|tuyau|tuyaux|pvc|abs|pehd|pression|reparer|reparation|avec|pour|sur|sous|gravitaire)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const strippedTokens = tokenizeProductMention(stripped);
  const productishTokens = strippedTokens.filter((token) => !MENTION_STOP_WORDS.has(token));
  if (
    stripped.length >= 4 &&
    productishTokens.length >= 1 &&
    !/[,;:!?]/.test(stripped) &&
    stripped.split(/\s+/).length <= 5
  ) {
    phrases.add(stripped);
  }

  return [...phrases];
}

/** Safe term for PostgREST `.or(canonical_name.ilike.%term%)` filters — rejects sentences and punctuation. */
export function sanitizeIlikeSearchTerm(term: string): string | null {
  const t = term.trim().replace(/\s+/g, " ");
  if (t.length < 2 || t.length > 48) return null;
  if (/[,;()%\\]/.test(t)) return null;
  const words = t.split(/\s+/);
  if (words.length > 4) return null;
  const norm = normalizeProductMentionText(t);
  if (words.length >= 3 && /\b(merci|non|puis|acheter|revendeur|magasin)\b/.test(norm)) return null;
  return t.replace(/[%_]/g, "");
}

/** All terms used to fuzzy-search the catalogue — no product whitelist. */
export function collectCatalogSearchTerms(text: string): string[] {
  if (isThemeUncertaintyMessage(text)) return [];
  const terms = new Set<string>();
  for (const t of extractProductSearchTerms([text])) terms.add(t);
  for (const t of extractCitedProductSearchTerms(text)) terms.add(t);
  for (const phrase of extractProductPhraseCandidates(text)) {
    terms.add(phrase);
    terms.add(phrase.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""));
    for (const token of tokenizeProductMention(phrase)) {
      if (token.length >= 3 || SHORT_MENTION_TOKENS.has(token)) terms.add(token);
    }
    const parts = phrase.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      terms.add(parts.slice(0, 2).join("-"));
      terms.add(parts.slice(0, 3).join("-"));
    }
  }
  for (const code of extractCatalogProductCodes(text)) terms.add(code);
  return [...terms].filter((term) => sanitizeIlikeSearchTerm(term) !== null);
}

/** Heuristic: user may be naming a catalogue product (sync — DB match confirms via detectCatalogProductCitations). */
export function mentionsLikelyProductPhrase(text: string): boolean {
  if (isThemeUncertaintyMessage(text)) return false;
  if (extractCatalogProductCodes(text).length > 0) return true;
  const q = normalizeProductMentionText(text);
  if (CATALOG_PRODUCT_FAMILY_RE.test(q)) return true;
  if (/\b(avec|pour|sur)\s+(la|le|les|un|une)\s+\w{3,}/.test(q)) return true;
  if (/\b(fiche\s+technique|fiche\s+produit|fds|ft\b|tds)\b/.test(q)) return true;
  return collectCatalogSearchTerms(text).length >= 2;
}

/** True when retrieval should treat session theme as a soft boost, not a hard SQL/vector filter. */
export function isExplicitProductTargeted(texts: string[]): boolean {
  for (const raw of texts) {
    const text = raw?.trim();
    if (!text) continue;
    if (mentionsLikelyProductPhrase(text)) return true;
    if (extractCatalogProductCodes(text).length > 0) return true;
    if (isExplicitProductLookupQuery(text)) return true;
  }
  return false;
}

function productText(product: ProductKnowledgeRow): { title: string; slug: string; slugSpaced: string } {
  const title = normalizeProductMentionText(decodeHtmlEntities(product.canonical_name));
  const slug = normalizeProductMentionText(product.slug);
  return { title, slug, slugSpaced: slug.replace(/-/g, " ") };
}

const MENTION_TOKEN_SYNONYMS: Record<string, string[]> = {
  deboucheur: ["debouch", "ontstopper", "udrazniacz"],
  debouch: ["deboucheur", "ontstopper", "udrazniacz"],
  universel: ["universeel", "uniwersalny"],
  professionnel: ["professioneel", "profesjonalny"],
  odeur: ["geur", "odeurs"],
};

function mentionTokensForMatch(token: string): string[] {
  const variants = new Set<string>([token, ...(MENTION_TOKEN_SYNONYMS[token] ?? [])]);
  return [...variants];
}

function productMentionTokenMatches(token: string, title: string, slug: string): boolean {
  for (const variant of mentionTokensForMatch(token)) {
    if (slug.includes(variant)) return true;
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(title)) return true;
  }
  return false;
}

/** How strongly a catalogue row matches an explicit product citation in the query. */
export function computeExplicitProductMatchScore(product: ProductKnowledgeRow, texts: string[]): number {
  const { title, slug, slugSpaced } = productText(product);
  let best = 0;

  for (const raw of texts) {
    const mention = extractExplicitProductMention(raw);
    const candidates = mention ? [mention, normalizeProductMentionText(raw)] : [normalizeProductMentionText(raw)];

    for (const text of candidates) {
      if (!text || text.length < 2) continue;

      const slugForm = text.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      if (slugForm.length >= 6 && slug === slugForm) {
        best = Math.max(best, 78);
      } else if (slugForm.length >= 6 && slug.startsWith(slugForm)) {
        best = Math.max(best, 72);
      } else if (slugForm.length >= 4 && slug.includes(slugForm)) {
        best = Math.max(best, 62);
      } else if (slugForm.length >= 4 && slug.length >= 10 && slugForm.includes(slug)) {
        best = Math.max(best, 58);
      }
      if (text.length >= 4 && (slugSpaced.includes(text) || title.includes(text))) {
        best = Math.max(best, 58);
      }

      const tokens = tokenizeProductMention(text);
      if (tokens.length > 0) {
        let matched = 0;
        for (const token of tokens) {
          if (productMentionTokenMatches(token, title, slug)) matched += 1;
        }
        const joined = tokens.join(" ");
        if (joined.length >= 8 && (title.includes(joined) || slugSpaced.includes(joined))) {
          best = Math.max(best, 62);
        }
        const ratio = matched / tokens.length;
        if (ratio >= 0.85 && matched >= 2) best = Math.max(best, 55);
        else if (ratio >= 0.66 && matched >= 2) best = Math.max(best, 48);
        else if (matched >= 1 && tokens.length === 1 && tokens[0]!.length >= 7) {
          best = Math.max(best, 45);
        } else if (matched >= 1) best = Math.max(best, 30 + matched * 8);
        if (tokens.length >= 2 && matched < tokens.length && slug.split("-").length <= 2) {
          best = Math.min(best, 36);
        }
      }

      for (const code of extractCatalogProductCodes(text)) {
        if (matchesCatalogCodeTerm(slug, product.canonical_name, code)) best = Math.max(best, 50);
      }

      if (/\b60\b/.test(text) && /\bchrono\b/.test(text)) {
        if (slug.includes("chrono") || title.includes("60min")) {
          best = Math.max(best, 56);
        } else if (slug.includes("silicone")) {
          best = Math.min(best, 12);
        }
      }
    }
  }

  return best;
}

export function productHasStrongExplicitMatch(product: ProductKnowledgeRow, texts: string[]): boolean {
  return computeExplicitProductMatchScore(product, texts) >= EXPLICIT_PRODUCT_MATCH_MIN;
}

/** True when the user question clearly targets this catalogue name (used for top-result priority). */
export function productHasNamePriority(product: ProductKnowledgeRow, texts: string[]): boolean {
  return computeExplicitProductMatchScore(product, texts) >= EXPLICIT_PRODUCT_NAME_PRIORITY_MIN;
}

/** Best catalogue match when the user explicitly asks for a technical sheet / FDS. */
export function resolveDirectTechnicalSheetProduct(
  userQuery: string,
  contextQuery: string,
  products: ProductKnowledgeRow[],
): ProductKnowledgeRow | null {
  if (!isExplicitProductLookupQuery(userQuery) || products.length === 0) return null;

  const texts = [userQuery, contextQuery].filter(Boolean);
  let best: { product: ProductKnowledgeRow; score: number } | null = null;

  for (const product of products) {
    if (!product.ft_url && !product.fds_url) continue;
    const score = computeExplicitProductMatchScore(product, texts);
    if (score < EXPLICIT_PRODUCT_MATCH_MIN) continue;
    if (!best || score > best.score) best = { product, score };
  }

  return best?.product ?? null;
}

/** User asks whether a cited catalogue product fits their case (yes/no, compatibilité). */
export function isProductCompatibilityAsk(text: string): boolean {
  return isFactualProductQuestion(text) && mentionsLikelyProductPhrase(text);
}

/** Yes/no, compatibilité, limites d'usage — not an open-ended product recommendation. */
export function isFactualProductQuestion(text: string): boolean {
  const q = normalizeProductMentionText(text);
  return (
    /\b(peut|peut on|est ce|est il|compatible|utilisable|utiliser|conviend|conven|admissible|ok pour|conforme|adapte)\b/.test(
      q,
    ) ||
    /\b(existe|disponible|couleur|teint|jaunir|resiste|durable|odeur|incolore|transparent)\b/.test(q) ||
    (/\?\s*$/.test(text.trim()) && /\b(le|la|les|ce|cette|produit|il|un)\b/.test(q))
  );
}

/** @deprecated Prefer detectCatalogProductCitations() — sync heuristic only. */
export function hasNamedProductCitation(text: string): boolean {
  return mentionsLikelyProductPhrase(text);
}

/** Search terms when the user cites a product by code/name (without fiche technique). */
export function extractCitedProductSearchTerms(text: string): string[] {
  const terms = new Set<string>();
  const q = normalizeProductMentionText(decodeHtmlEntities(text));
  for (const code of extractCatalogProductCodes(q)) {
    terms.add(code);
  }
  for (const raw of q.split(/[^a-z0-9]+/)) {
    const token = raw.trim();
    if (!token || MENTION_STOP_WORDS.has(token)) continue;
    if (token.length < 3 && !SHORT_MENTION_TOKENS.has(token)) continue;
    terms.add(token);
  }
  if (terms.size >= 2) {
    const ordered = [...terms];
    terms.add(ordered.slice(0, 3).join("-"));
    terms.add(ordered.slice(0, 2).join("-"));
  }
  const slugLike = q.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (slugLike.length >= 4) terms.add(slugLike);
  return [...terms].filter((term) => term.length >= 2);
}

export function formatNamedProductCitationPrompt(text: string, resolvedProductName?: string | null): string {
  if (!mentionsLikelyProductPhrase(text) && !resolvedProductName) return "";
  const codes = extractCatalogProductCodes(text);
  const productHint = resolvedProductName
    ? ` **${resolvedProductName.trim()}**`
    : codes.length > 0
      ? ` le(s) produit(s) catalogue ${codes.map((c) => c.toUpperCase()).join(", ")}`
      : " un produit GEB identifié dans le catalogue";
  if (isFactualProductQuestion(text)) {
    return `\nCITATION_PRODUIT: L'utilisateur pose une question factuelle sur${productHint}. MODE 1 : répondez oui/non ou la limite exacte en citant FT/FDS. Ne recommandez PAS un autre SKU si la question porte sur le produit cité. Interdit d'affirmer qu'aucune fiche GEB ne couvre ce cas si les extraits FT/FDS sont présents.`;
  }
  return `\nCITATION_PRODUIT: Contexte centré sur${productHint}. Répondez sur CE produit (usage, compatibilité, limites). Interdit d'affirmer qu'il est absent du catalogue si un bloc ou une FT le décrit.`;
}

/** Best catalogue match when the user cites a product by name (not a fiche technique request). */
export function resolveDirectCitedProduct(
  userQuery: string,
  products: ProductKnowledgeRow[],
): ProductKnowledgeRow | null {
  if (isExplicitProductLookupQuery(userQuery) || products.length === 0) {
    return null;
  }

  let best: { product: ProductKnowledgeRow; score: number } | null = null;
  for (const product of products) {
    const score = computeExplicitProductMatchScore(product, [userQuery]);
    if (score < EXPLICIT_PRODUCT_NAME_PRIORITY_MIN) continue;
    if (!best || score > best.score) best = { product, score };
  }
  return best?.product ?? null;
}

/** Avoid G10 matching G110 (and similar prefix collisions) in slug/name search. */
export function matchesCatalogCodeTerm(slug: string, canonicalName: string, term: string): boolean {
  if (!/^g\d+$/.test(term)) return true;
  const slugNorm = normalizeProductMentionText(slug);
  const titleNorm = normalizeProductMentionText(decodeHtmlEntities(canonicalName)).replace(/\s+/g, "-");
  const re = new RegExp(`(^|-)${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-|$)`);
  return re.test(slugNorm) || re.test(titleNorm);
}
