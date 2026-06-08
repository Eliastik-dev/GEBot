import type { ProductKnowledgeRow } from "../types/product-knowledge.js";
import { decodeHtmlEntities } from "./text.js";
export const EXPLICIT_PRODUCT_MATCH_MIN = 40;

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
  "envoyer",
  "envoie",
  "application",
  "applications",
  "utilisation",
  "professionnel",
  "particulier",
]);

const SHORT_MENTION_TOKENS = new Set(["abs", "pvc", "ppr", "pe", "pp", "dn", "ms", "rt1", "60"]);

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

  return [...terms].filter((term) => term.length >= 2);
}

function productText(product: ProductKnowledgeRow): { title: string; slug: string; slugSpaced: string } {
  const title = normalizeProductMentionText(decodeHtmlEntities(product.canonical_name));
  const slug = normalizeProductMentionText(product.slug);
  return { title, slug, slugSpaced: slug.replace(/-/g, " ") };
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
      if (slugForm.length >= 4 && slug.includes(slugForm)) {
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
          if (title.includes(token) || slug.includes(token)) matched += 1;
        }
        const ratio = matched / tokens.length;
        if (ratio >= 0.85 && matched >= 2) best = Math.max(best, 55);
        else if (ratio >= 0.66 && matched >= 2) best = Math.max(best, 48);
        else if (matched >= 1 && tokens.length === 1) best = Math.max(best, 45);
        else if (matched >= 1) best = Math.max(best, 30 + matched * 8);
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

export function hasNamedProductCitation(text: string): boolean {
  if (extractCatalogProductCodes(text).length > 0) return true;
  const q = normalizeProductMentionText(text);
  return (
    /\b(inhibiteur|desembou|gebsoplast|collex|ms[\s-]?zinc|toiturol|silicone|chrono)\b/.test(q) &&
    /\b(g\d+|univ|universel)\b/.test(q)
  );
}

/** Search terms when the user cites a product by code/name (without fiche technique). */
export function extractCitedProductSearchTerms(text: string): string[] {
  if (!hasNamedProductCitation(text)) return [];
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

export function formatNamedProductCitationPrompt(text: string): string {
  const codes = extractCatalogProductCodes(text);
  if (codes.length === 0) return "";
  const list = codes.map((c) => c.toUpperCase()).join(", ");
  return `\nCITATION_PRODUIT: L'utilisateur cite explicitement le(s) produit(s) catalogue ${list}. Les blocs correspondants sont en tête du contexte. Répondez sur ce(s) produit(s) avec les faits de la fiche (usage, compatibilité, limites). Interdit d'affirmer qu'ils sont absents du catalogue GEB si un bloc les décrit.`;
}

/** Avoid G10 matching G110 (and similar prefix collisions) in slug/name search. */
export function matchesCatalogCodeTerm(slug: string, canonicalName: string, term: string): boolean {
  if (!/^g\d+$/.test(term)) return true;
  const slugNorm = normalizeProductMentionText(slug);
  const titleNorm = normalizeProductMentionText(decodeHtmlEntities(canonicalName)).replace(/\s+/g, "-");
  const re = new RegExp(`(^|-)${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-|$)`);
  return re.test(slugNorm) || re.test(titleNorm);
}
