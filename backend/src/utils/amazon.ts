import { RESELLER_DIRECTORY_URL } from "../config/constants.js";
import { getAmazonLinksByLocale } from "../config/amazon-links-store.js";
import { env } from "../config/env.js";
import type { Locale, RecommendationDetails } from "../types/index.js";
import { normalizeKey, normalizeText, decodeHtmlEntities } from "./text.js";

/** Slugs catalogue → préfixe de désignation dans le fichier Amazon (clé normalisée). */
const SLUG_TO_AMAZON_KEY_PREFIX: Record<string, string> = {
  "silicone-60min-chrono": "silicone 60 mn chrono",
  "gebsicone-w3": "silicone 60 mn chrono",
};

export function getAmazonDefaultUrl(locale: Locale, productName?: string | null): string {
  const base = locale === "nl" ? "https://www.amazon.nl/s?k=" : "https://www.amazon.fr/s?k=";
  const raw = decodeHtmlEntities((productName ?? "").trim());
  const keyword = raw ? (/\bgeb\b/i.test(raw) ? raw : `GEB ${raw}`) : "GEB";
  return `${base}${encodeURIComponent(keyword)}`;
}

function expandSearchTokens(tokens: string[]): string[] {
  const out = new Set(tokens);
  if (tokens.includes("silicone") && (tokens.includes("bain") || tokens.includes("cuisine") || tokens.includes("sanitaire"))) {
    out.add("sanitaire");
    out.add("gebsicone");
  }
  if (tokens.includes("bain") || tokens.includes("cuisine")) {
    out.add("sanitaire");
  }
  return [...out];
}

function findAmazonUrlByKeyPrefix(locale: Locale, keyPrefix: string): string | null {
  const normalizedPrefix = normalizeKey(keyPrefix);
  if (!normalizedPrefix) return null;
  const searchLocales: Array<"fr" | "nl"> = locale === "nl" ? ["nl", "fr"] : ["fr", "nl"];
  for (const localKey of searchLocales) {
    const matches = Object.entries(getAmazonLinksByLocale()[localKey]).filter(
      ([key]) => !key.startsWith("ref_geb:") && key.startsWith(normalizedPrefix),
    );
    if (matches.length === 0) continue;
    const preferred =
      matches.find(([key]) => key.includes("blanc")) ??
      matches.find(([key]) => key.includes("translucide")) ??
      matches[0];
    if (preferred) return preferred[1];
  }
  return null;
}

function findAmazonUrlBySlug(locale: Locale, slug: string): string | null {
  const prefix = SLUG_TO_AMAZON_KEY_PREFIX[slug];
  if (prefix) {
    const byPrefix = findAmazonUrlByKeyPrefix(locale, prefix);
    if (byPrefix) return byPrefix;
  }
  return findBestAmazonLinkBySlug(locale, slug);
}


export function tokenizeForMatch(value: string): string[] {
  const stopWords = new Set([
    "geb",
    "lot",
    "de",
    "pour",
    "avec",
    "sans",
    "et",
    "ml",
    "g",
    "kg",
    "cartouche",
    "tube",
    "pot",
    "blister",
    "pool",
  ]);
  return normalizeKey(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !stopWords.has(token));
}


export function getDiscriminativeTokens(tokens: string[]): string[] {
  const generic = new Set([
    "colle",
    "pvc",
    "gel",
    "evacuation",
    "pression",
    "eau",
    "potable",
    "tube",
    "tuyau",
    "joint",
    "canalisation",
    "produit",
    "geb",
  ]);
  return tokens.filter((token) => token.length >= 4 && !generic.has(token));
}


export function findBestAmazonLinkByName(locale: Locale, productName: string): string | null {
  const searchLocales: Array<"fr" | "nl"> = locale === "nl" ? ["nl", "fr"] : ["fr", "nl"];
  const searchTokens = tokenizeForMatch(decodeHtmlEntities(productName));
  if (searchTokens.length === 0) return null;
  const expandedTokens = expandSearchTokens(searchTokens);
  const discriminativeTokens = getDiscriminativeTokens(expandedTokens);

  let best: { url: string; score: number } | null = null;
  for (const localKey of searchLocales) {
    const entries = Object.entries(getAmazonLinksByLocale()[localKey]);
    for (const [key, url] of entries) {
      if (key.startsWith("ref_geb:")) continue;
      const candidateTokens = tokenizeForMatch(key);
      if (candidateTokens.length === 0) continue;
      if (discriminativeTokens.length > 0) {
        const hasDiscriminative = discriminativeTokens.some((token) => candidateTokens.includes(token));
        if (!hasDiscriminative) continue;
      }
      const common = expandedTokens.filter((token) => candidateTokens.includes(token)).length;
      if (common === 0) continue;
      const discriminativeCommon =
        discriminativeTokens.length > 0
          ? discriminativeTokens.filter((token) => candidateTokens.includes(token)).length
          : 0;
      const coverage = common / expandedTokens.length;
      const precision = common / candidateTokens.length;
      const discriminativeCoverage =
        discriminativeTokens.length > 0 ? discriminativeCommon / discriminativeTokens.length : 0;
      const score =
        discriminativeTokens.length > 0
          ? discriminativeCoverage * 0.75 + coverage * 0.15 + precision * 0.1
          : coverage * 0.7 + precision * 0.3;
      const singleStrongTokenMatch =
        searchTokens.length === 1 && common === 1 && searchTokens[0]!.length >= 5 && score >= 0.2;
      const regularMatch =
        (discriminativeTokens.length > 0 && discriminativeCommon >= 2 && score >= 0.32) ||
        (discriminativeTokens.length > 0 && discriminativeCommon >= 1 && score >= 0.45) ||
        (common >= 2 && score >= 0.55);
      if ((regularMatch || singleStrongTokenMatch) && (!best || score > best.score)) {
        best = { url, score };
      }
    }
    if (best) return best.url;
  }
  return null;
}


export function findBestAmazonLinkBySlug(locale: Locale, slug: string): string | null {
  const searchLocales: Array<"fr" | "nl"> = locale === "nl" ? ["nl", "fr"] : ["fr", "nl"];
  const slugTokens = normalizeKey(slug)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
  if (slugTokens.length === 0) return null;
  const discriminativeTokens = getDiscriminativeTokens(slugTokens);

  let best: { url: string; score: number } | null = null;
  for (const localKey of searchLocales) {
    const entries = Object.entries(getAmazonLinksByLocale()[localKey]);
    for (const [key, url] of entries) {
      if (key.startsWith("ref_geb:")) continue;
      const candidateTokens = tokenizeForMatch(key);
      if (candidateTokens.length === 0) continue;
      if (discriminativeTokens.length > 0) {
        const hasDiscriminative = discriminativeTokens.some((token) => candidateTokens.includes(token));
        if (!hasDiscriminative) continue;
      }
      const common = slugTokens.filter((token) => candidateTokens.includes(token)).length;
      if (common === 0) continue;
      const discriminativeCommon =
        discriminativeTokens.length > 0
          ? discriminativeTokens.filter((token) => candidateTokens.includes(token)).length
          : 0;
      const coverage = common / slugTokens.length;
      const precision = common / candidateTokens.length;
      const discriminativeCoverage =
        discriminativeTokens.length > 0 ? discriminativeCommon / discriminativeTokens.length : 0;
      const score =
        discriminativeTokens.length > 0
          ? discriminativeCoverage * 0.8 + coverage * 0.1 + precision * 0.1
          : coverage * 0.75 + precision * 0.25;
      const matchPasses =
        (discriminativeTokens.length > 0 && discriminativeCommon >= 1 && score >= 0.45) ||
        (coverage >= 0.5 && score >= 0.45);
      if (matchPasses && (!best || score > best.score)) {
        best = { url, score };
      }
    }
    if (best) return best.url;
  }
  return null;
}


export function parseAmazonProductMap(): Record<string, string> {
  const raw = env.AMAZON_PRODUCT_URL_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.entries(parsed).reduce<Record<string, string>>((acc, [key, url]) => {
      if (typeof url !== "string") return acc;
      const normalizedKey = normalizeKey(key);
      if (!normalizedKey) return acc;
      acc[normalizedKey] = url;
      return acc;
    }, {});
  } catch (error) {
    console.warn("[startup] Invalid AMAZON_PRODUCT_URL_MAP JSON:", error);
    return {};
  }
}

const amazonProductMap = parseAmazonProductMap();


export function extractRecommendedRef(answer: string): string | null {
  const patterns = [
    /r[ée]f(?:erence)?(?:\s*geb)?\s*[:#.\-]?\s*([0-9 ]{3,})/i,
    /\br[ée]f\.?\s*geb\s*[:#.\-]?\s*([0-9 ]{3,})/i,
    /\bgeb\s*(?:ref|reference)?\s*[:#.\-]?\s*([0-9 ]{3,})/i,
  ];
  for (const pattern of patterns) {
    const match = answer.match(pattern);
    if (!match?.[1]) continue;
    const digits = match[1].replace(/\s+/g, "");
    if (digits) return digits;
  }
  return null;
}


export function isComparisonModeAnswer(answer: string): boolean {
  return (
    /###\s*🔍?\s*Options Comparées/i.test(answer) ||
    /###\s*Compared Options/i.test(answer) ||
    /###\s*Porównywane opcje/i.test(answer) ||
    /###\s*Vergelijkte opties/i.test(answer)
  );
}

function extractComparisonOptionProducts(answer: string): string[] {
  const products: string[] = [];
  const optionPattern = /####\s*Option\s+[A-C]\s*[—–-]\s*\*\*([^*]+)\*\*/gi;
  for (const match of answer.matchAll(optionPattern)) {
    const label = cleanRecommendedProductLabel(match[1]?.trim() ?? "");
    if (label) products.push(label);
  }
  return products;
}

export function extractRecommendedProduct(answer: string): string | null {
  if (isComparisonModeAnswer(answer)) {
    const comparisonProducts = extractComparisonOptionProducts(answer);
    if (comparisonProducts.length > 0) return comparisonProducts[0]!;
  }
  const headingMatch = answer.match(/Produit Recommandé\s*:\s*\*\*([^*]+)\*\*/i);
  if (headingMatch?.[1]) return decodeHtmlEntities(headingMatch[1].trim());
  const plainHeadingMatch = answer.match(/Produit Recommandé\s*:\s*([^\n\r*][^\n\r]+)/i);
  if (plainHeadingMatch?.[1]) return decodeHtmlEntities(plainHeadingMatch[1].trim());
  const fallback = answer.match(/recommended product\s*:\s*\*\*([^*]+)\*\*/i);
  if (fallback?.[1]) return decodeHtmlEntities(fallback[1].trim());
  const plainFallback = answer.match(/recommended product\s*:\s*([^\n\r*][^\n\r]+)/i);
  if (plainFallback?.[1]) return decodeHtmlEntities(plainFallback[1].trim());
  return extractBoldCatalogProductName(answer);
}

/** MODE 1 answers that name a product in bold without the MODE 2 heading block. */
export function extractBoldCatalogProductName(answer: string): string | null {
  for (const match of answer.matchAll(/\*\*([^*]{3,80})\*\*/g)) {
    const label = cleanRecommendedProductLabel(match[1]?.trim() ?? "");
    if (label) return label;
  }
  return null;
}


export function isNonProductLabel(value: string | null): boolean {
  if (!value) return true;
  const normalized = normalizeText(value);
  return (
    normalized.includes("je ne trouve pas cette information technique") ||
    normalized.includes("non precise dans la fiche") ||
    normalized.includes("i cannot find this technical information") ||
    normalized.includes("sorry") ||
    normalized.includes("aucune") ||
    normalized.includes("aucun produit") ||
    normalized.includes("pas de produit") ||
    normalized.includes("no suitable product") ||
    normalized.includes("no product in context") ||
    normalized.includes("produit adapte dans le contexte") ||
    normalized.includes("produit recommande indisponible")
  );
}

/** True when the assistant named a real catalogue product (not a placeholder). */
export function hasValidRecommendedProduct(answer: string): boolean {
  if (isComparisonModeAnswer(answer)) {
    return extractComparisonOptionProducts(answer).length > 0;
  }
  return cleanRecommendedProductLabel(extractRecommendedProduct(answer)) !== null;
}


export function cleanRecommendedProductLabel(productName: string | null): string | null {
  if (!productName) return null;
  const cleaned = decodeHtmlEntities(productName)
    .replace(/\(.*?r[ée]f\..*?\)/gi, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return isNonProductLabel(cleaned) ? null : cleaned;
}


export function getBestNodeForProduct(nodes: unknown[], extractedProduct: string | null): Record<string, unknown> | null {
  let best: { metadata: Record<string, unknown>; score: number } | null = null;
  const extractedTokens = extractedProduct ? tokenizeForMatch(extractedProduct) : [];
  for (const item of nodes) {
    const metadata = (item as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
    const title = typeof metadata.title === "string" ? metadata.title : "";
    const slug = typeof metadata.slug === "string" ? metadata.slug : "";
    const titleTokens = tokenizeForMatch(title);
    const slugTokens = tokenizeForMatch(slug.replace(/-/g, " "));
    let score = 0;
    if (extractedTokens.length > 0) {
      const titleCommon = extractedTokens.filter((token) => titleTokens.includes(token)).length;
      const slugCommon = extractedTokens.filter((token) => slugTokens.includes(token)).length;
      score = titleCommon * 2 + slugCommon;
    } else {
      score = titleTokens.length > 0 ? 1 : 0;
    }
    if (!best || score > best.score) {
      best = { metadata, score };
    }
  }
  return best?.metadata ?? null;
}


export function getProductHintFromNodes(nodes: unknown[], extractedProduct: string | null): string | null {
  const metadata = getBestNodeForProduct(nodes, extractedProduct);
  if (!metadata) return null;
  const title = typeof metadata.title === "string" ? metadata.title.trim() : "";
  if (!title) return null;
  return cleanRecommendedProductLabel(
    decodeHtmlEntities(title)
      .replace(/[®*]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}


export function getProductSlugHintFromNodes(nodes: unknown[], extractedProduct: string | null): string | null {
  const metadata = getBestNodeForProduct(nodes, extractedProduct);
  if (!metadata) return null;
  const slug = typeof metadata.slug === "string" ? metadata.slug.trim() : "";
  return slug || null;
}


export function resolveAmazonRecommendation(
  answer: string,
  locale: Locale,
  productHint?: string | null,
  productSlugHint?: string | null,
): RecommendationDetails {
  const productName = extractRecommendedProduct(answer);
  const cleanedName = cleanRecommendedProductLabel(productName) ?? cleanRecommendedProductLabel(productHint ?? null);
  const reference = extractRecommendedRef(answer);
  const localesToTry: Array<"fr" | "nl"> = locale === "nl" ? ["nl", "fr"] : ["fr", "nl"];
  if (reference) {
    for (const localeKey of localesToTry) {
      const url = getAmazonLinksByLocale()[localeKey][`ref_geb:${reference}`];
      if (url) return { productName: cleanedName, amazonUrl: url };
    }
  }
  if (!cleanedName) return { productName: null, amazonUrl: getAmazonDefaultUrl(locale, null) };
  const normalizedName = normalizeKey(cleanedName);
  if (amazonProductMap[normalizedName]) {
    return { productName: cleanedName, amazonUrl: amazonProductMap[normalizedName] };
  }
  for (const localeKey of localesToTry) {
    const url = getAmazonLinksByLocale()[localeKey][normalizedName];
    if (url) return { productName: cleanedName, amazonUrl: url };
  }
  for (const [mappedName, url] of Object.entries(amazonProductMap)) {
    if (normalizedName.includes(mappedName) || mappedName.includes(normalizedName)) {
      return { productName: cleanedName, amazonUrl: url };
    }
  }
  if (productSlugHint) {
    const slugMatch = findAmazonUrlBySlug(locale, productSlugHint);
    if (slugMatch) {
      return { productName: cleanedName, amazonUrl: slugMatch };
    }
  }
  const fuzzyMatch = findBestAmazonLinkByName(locale, cleanedName);
  if (fuzzyMatch) {
    return { productName: cleanedName, amazonUrl: fuzzyMatch };
  }
  return { productName: cleanedName, amazonUrl: getAmazonDefaultUrl(locale, cleanedName) };
}


export function buildAmazonSection(
  locale: Locale,
  recommendation: RecommendationDetails,
  options?: { includeResellerLink?: boolean },
): string {
  const includeResellerLink = options?.includeResellerLink ?? locale !== "pl";
  const labelByLocale: Record<Locale, string> = {
    fr: "Acheter sur Amazon",
    en: "Buy on Amazon",
    nl: "Koop op Amazon",
    pl: "Kup na Amazon",
  };
  const resellerLabelByLocale: Record<Locale, string> = {
    fr: "Trouver un revendeur",
    en: "Find a reseller",
    nl: "Vind een wederverkoper",
    pl: "Znajdz dystrybutora",
  };
  const headingByLocale: Record<Locale, string> = {
    fr: "### 🛒 Disponibilité",
    en: "### 🛒 Availability",
    nl: "### 🛒 Beschikbaarheid",
    pl: "### 🛒 Dostepnosc",
  };
  const lines = [`- [${labelByLocale[locale]}](${recommendation.amazonUrl})`];
  if (includeResellerLink) {
    lines.push(`- 📍 [${resellerLabelByLocale[locale]}](${RESELLER_DIRECTORY_URL})`);
  }
  return `${headingByLocale[locale]}\n${lines.join("\n")}`;
}


export function hasAmazonSection(answer: string): boolean {
  const normalized = normalizeText(answer);
  return (
    normalized.includes("disponibilite") ||
    normalized.includes("availability") ||
    normalized.includes("beschikbaarheid") ||
    normalized.includes("achat prioritaire") ||
    normalized.includes("buy on amazon") ||
    normalized.includes("acheter sur amazon")
  );
}


export function hasFallbackAmazonSearchUrl(answer: string): boolean {
  return /https?:\/\/www\.amazon\.(?:fr|nl)\/s\?k=geb/i.test(answer);
}


export function removeAmazonSections(answer: string): string {
  const lines = answer.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const normalized = normalizeText(line);
    const trimmed = line.trim();
    const startsAmazonSection =
      /^#{1,4}\s*🛒/.test(trimmed) ||
      /^🛒/.test(trimmed) ||
      normalized.includes("disponibilite") ||
      normalized.includes("availability") ||
      normalized.includes("beschikbaarheid") ||
      normalized.includes("achat prioritaire") ||
      normalized.includes("acheter sur amazon") ||
      normalized.includes("primary purchase option") ||
      normalized.includes("primaire aankoopoptie") ||
      normalized.includes("priorytetowa opcja zakupu") ||
      /amazon\.(fr|nl|de|com)\//.test(normalized) ||
      normalized.includes("trouver un revendeur") ||
      normalized.includes("find a reseller");
    const startsOtherSection = /^#{1,4}\s/.test(trimmed) && !startsAmazonSection;
    if (startsAmazonSection) {
      skipping = true;
      continue;
    }
    if (skipping && startsOtherSection) {
      skipping = false;
    }
    if (skipping && trimmed === "") {
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

