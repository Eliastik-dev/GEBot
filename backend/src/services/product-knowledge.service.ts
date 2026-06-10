import { supabase } from "../config/supabase.js";
import type { Audience, ProductTheme } from "../types/index.js";
import type { ProductKnowledgeRow, UpsertProductKnowledgeInput } from "../types/product-knowledge.js";
import {
  asksMetalThreadPasteJoint,
  asksThreadedMetalSealing,
  jointPasteSearchNameTerms,
  parseJointServiceFluid,
  userRejectsPiscineProduct,
} from "../utils/joint-paste.js";
import { hasInaccessibleThreadedJointForResinContext } from "../utils/diagnostic-rules.js";
import {
  feedbackSlugScoreDelta,
  type FeedbackSlugAdjustments,
} from "./feedback-retrieval.service.js";
import { catalogAudienceVisibleForSession, inferCatalogProductAudience } from "./product-theme.service.js";
import { decodeHtmlEntities } from "../utils/text.js";
import {
  computeExplicitProductMatchScore,
  EXPLICIT_PRODUCT_MATCH_MIN,
  extractCatalogProductCodes,
  extractCitedProductSearchTerms,
  extractProductSearchTerms,
  hasNamedProductCitation,
  isExplicitProductLookupQuery,
  matchesCatalogCodeTerm,
  EXPLICIT_PRODUCT_NAME_PRIORITY_MIN,
  productHasStrongExplicitMatch,
  resolveDirectCitedProduct,
  resolveDirectTechnicalSheetProduct,
} from "../utils/product-mention.js";

/** Retry catalog SQL without session theme when themed filter returns too few rows. */
export const PRODUCT_KNOWLEDGE_THEME_FALLBACK_MIN = 3;

export type ProductKnowledgeSearchInput = {
  locale: "fr" | "nl" | "pl";
  theme?: ProductTheme | null;
  tags?: string[];
  material?: string | null;
  fluid?: string | null;
  query?: string;
  /** Requête enrichie (synonymes, thème, fluide) — utilisée en plus de `query` pour le scoring. */
  searchQuery?: string;
  /** Message utilisateur brut (avant expansion LLM) — prioritaire pour citation produit explicite. */
  userQuery?: string;
  limit?: number;
  /** Filtrer les fiches « grand public » pour les sessions pro. */
  audience?: Audience | null;
  /** Boost / penalize slugs from user thumbs-up/down feedback. */
  feedbackAdjustments?: FeedbackSlugAdjustments;
};

function combineRetrievalText(input: ProductKnowledgeSearchInput): string {
  return [input.userQuery, input.query, input.searchQuery].filter(Boolean).join("\n").trim();
}

function explicitMatchTexts(input: ProductKnowledgeSearchInput): string[] {
  return [input.userQuery, input.query, input.searchQuery].filter(Boolean) as string[];
}

/** Produit cité explicitement par l'utilisateur (hors top tags/thème). */
const EXPLICIT_CATALOG_PRODUCT_PATTERNS: Array<{ pattern: RegExp; slug: string }> = [
  { pattern: /\bpool\s*[\*\s]?\s*colmateur\b/i, slug: "pool-colmateur-de-fuites" },
  { pattern: /\bcolmateur\s+(de\s+)?fuites?\b/i, slug: "pool-colmateur-de-fuites" },
  { pattern: /\bpool\s*[\*\s]?\s*lekdichter\b/i, slug: "pool-lekdichter" },
  {
    pattern: /\b(?:pool\s*[\*]?\s*)?kit\s+(?:de\s+)?reparation\s+liner\b/i,
    slug: "pool-kit-de-reparation-liner",
  },
  { pattern: /\bkit\s+reparation\s+liner\b/i, slug: "pool-kit-de-reparation-liner" },
  {
    pattern: /\b(?:pool\s*[\*]?\s*)?mastic\s+reparation\s+fuites?\b/i,
    slug: "pool-mastic-reparation-fuites",
  },
  { pattern: /\b(?:pool\s*[\*]?\s*)?mastic\s+piscine\b/i, slug: "pool-mastic-piscine" },
  { pattern: /\bms[\s*-]?zinc\b/i, slug: "ms-zinc" },
  { pattern: /\btoiturol\b/i, slug: "toiturol" },
  { pattern: /\bacrybat\b/i, slug: "acrybat" },
  { pattern: /\bgebetanche\b/i, slug: "gebetanche-eau-potable-rt1-geb" },
  { pattern: /\b(?:deboucheur|debouch|ontstopper)\s+universel\b/i, slug: "ontstopper-universeel" },
  { pattern: /\buniversele\s+ontstopper\b/i, slug: "universele-ontstopper" },
  { pattern: /\b(?:deboucheur|debouch|ontstopper)\s+professionnel\b/i, slug: "ontstopper-professioneel" },
  { pattern: /\budrazniacz\s+uniwersalny\b/i, slug: "udrazniacz-uniwersalny" },
  { pattern: /\b(?:destructeur|destruction)\s+d['']?\s*odeurs?\b/i, slug: "ontstopper-geurverwijderaar" },
];

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}


/** Short tokens that must still match titre/slug (ABS, PVC…) */
const SHORT_QUERY_TOKENS = new Set(["abs", "pvc", "ppr", "pe", "pp", "dn"]);

function scoreProduct(
  product: ProductKnowledgeRow,
  tags: string[],
  material: string | null | undefined,
  fluid: string | null | undefined,
  query: string,
  sessionAudience: Audience | null | undefined,
  sessionTheme: ProductTheme | null | undefined,
  explicitTexts: string[] = [],
): number {
  let score = 0;
  if (sessionTheme && product.theme === sessionTheme) score += 6;
  const productTags = new Set(product.use_case_tags.map((t) => normalizeText(t)));
  for (const tag of tags) {
    if (productTags.has(normalizeText(tag))) score += 3;
  }

  const title = normalizeText(decodeHtmlEntities(product.canonical_name));
  const slug = normalizeText(product.slug.replace(/-/g, " "));
  const q = normalizeText(decodeHtmlEntities(query));

  for (const tag of tags) {
    const term = normalizeText(tag.replace(/_/g, " "));
    if (title.includes(term) || slug.includes(term.replace(/ /g, ""))) score += 4;
  }

  if (tags.includes("echappement")) {
    if (title.includes("echappement") || slug.includes("echappement")) score += 12;
    if (title.includes("demarre moteur") || title.includes("startex")) score -= 10;
    if (title.includes("eau potable") || title.includes("potable")) score -= 8;
  }

  if (tags.includes("eau_potable")) {
    if (title.includes("eau potable") || title.includes("potable")) score += 8;
    if (title.includes("echappement")) score -= 6;
  }

  const piscineContext =
    !userRejectsPiscineProduct(q) &&
    (tags.includes("piscine") || (/\bpiscine\b/.test(q) && !/\beau\s+potable\b/.test(q)));
  if (piscineContext) {
    if (title.includes("pool") || title.includes("piscine") || slug.includes("pool")) score += 6;
  }

  const poolInaccessiblePipeLeak =
    piscineContext &&
    /\b(inaccessible|inacessible|pas\s+d[\s']?acces|enterr|enterre|colmateur|canalisation|tuyau)\b/.test(q) &&
    /\b(fuite|fuit|colmat|perd)\b/.test(q);
  if (poolInaccessiblePipeLeak) {
    if (
      title.includes("colmateur") ||
      slug.includes("colmateur") ||
      slug.includes("lekdichter") ||
      slug.includes("zatykania-wyciek")
    ) {
      score += 38;
    }
    if (slug.includes("mastic") && slug.includes("piscine") && !slug.includes("reparation")) score -= 22;
    if (slug.includes("gebsoblue")) score -= 14;
    if (slug.includes("gebetanche") || slug.includes("resine")) score -= 28;
  }
  if (/\bcolmateur\b/.test(q) && piscineContext) {
    if (title.includes("colmateur") || slug.includes("colmateur") || slug.includes("lekdichter")) score += 45;
    if (slug.includes("mastic-piscine") || title.includes("mastic piscine")) score -= 30;
  }

  const linerKitAsk =
    /\b(kit\s+.*liner|liner.*kit|reparation\s+liner|kit\s+reparation\s+liner)\b/.test(q) ||
    (/\b(je\s+veux|je\s+souhaite|donnez[- ]?moi)\b/.test(q) && /\b(liner|kit)\b/.test(q));
  if (linerKitAsk) {
    if (slug.includes("liner") || title.includes("liner")) score += 42;
    if (slug.includes("detection-fuite") || title.includes("detection")) score -= 18;
    if (slug.includes("mastic") && !slug.includes("liner")) score -= 12;
  }
  if (!piscineContext && (slug.includes("pool-") || slug.startsWith("pool ") || title.startsWith("pool"))) {
    score -= 38;
  }

  if (tags.includes("debouchage")) {
    if (title.includes("debouch") || slug.includes("debouch") || slug.includes("ontstopper")) score += 8;
  }

  const drainOdorContext =
    /\b(odeur|odeurs|sentent|puanteur|mauvais|geur|smell)\b/.test(q) &&
    /\b(canalisation|evacuation|siphon|wc|douche|evier|drain|afvoer)\b/.test(q);
  if (drainOdorContext) {
    if (title.includes("debouch") || slug.includes("debouch") || slug.includes("ontstopper") || title.includes("odeur")) {
      score += 32;
    }
    if (slug.includes("pate-a-joint") || slug.includes("resine") || slug.includes("bande-abrasive") || slug.includes("pistolet")) {
      score -= 24;
    }
  }

  if (/\b(gourde|bouteille\s+de\s+boire|bouteille\s+isotherme)\b/.test(q) && /\b(fuit|fuite|fissure)\b/.test(q)) {
    if (
      slug.includes("gebetanche") ||
      slug.includes("pate-a-joint") ||
      slug.includes("filasse") ||
      slug.includes("ptfe") ||
      slug.includes("resine") ||
      slug.includes("olifan")
    ) {
      score -= 55;
    }
  }

  const descalingContext = /\b(detartr|descal|calcaire|tartre|detartrans|g6[0-3]\b|echangeur)\b/.test(q);
  if (descalingContext) {
    if (title.includes("detartr") || slug.includes("detartr") || slug.includes("g60") || slug.includes("g61")) {
      score += 28;
    }
    if (title.includes("collafeu") || slug.includes("collafeu")) score -= 25;
    if (title.includes("tresse") && slug.includes("propfeu")) score -= 22;
    if (title.includes("desembou") || slug.includes("g3")) score -= 15;
  }

  const heatingInhibitorContext =
    (tags.includes("desembouage") || fluid === "chauffage") &&
    /\b(inhibiteur|desembou|universel|plancher\s+chauffant|radiateur|g110|g10\b|g3\b|g70\b)\b/.test(q);
  if (heatingInhibitorContext) {
    if (slug.includes("g110") || title.includes("g110")) score += 32;
    if (title.includes("inhibiteur universel")) score += 26;
    if (title.includes("inhibiteur")) score += slug.includes("g10") && !slug.includes("g110") ? 10 : 6;
    if (slug.includes("collafeu") || title.includes("collafeu") || title.includes("propfeu")) score -= 45;
    if (title.includes("refractaire") || slug.includes("cheminee")) score -= 35;
    if (/\buniversel\b/.test(q) && (slug.includes("g110") || title.includes("universel"))) score += 18;
  }

  const explicitScore = computeExplicitProductMatchScore(product, explicitTexts);
  if (explicitScore >= EXPLICIT_PRODUCT_NAME_PRIORITY_MIN) score += explicitScore;
  else if (explicitScore >= EXPLICIT_PRODUCT_MATCH_MIN) score += Math.round(explicitScore * 0.35);

  const normMaterial = material ? normalizeText(material) : "";
  if (normMaterial) {
    const mats = product.compatible_materials.map(normalizeText);
    if (mats.some((m) => m.includes(normMaterial) || normMaterial.includes(m))) score += 2;
    const bad = product.incompatible_materials.map(normalizeText);
    if (bad.some((m) => m.includes(normMaterial))) score -= 4;
  }

  const normFluid = fluid ? normalizeText(fluid) : "";
  if (normFluid) {
    const fluids = product.compatible_fluids.map(normalizeText);
    if (fluids.some((f) => f.includes(normFluid) || normFluid.includes(f))) score += 1.5;
    const bad = product.incompatible_fluids.map(normalizeText);
    if (bad.some((f) => f.includes(normFluid))) score -= 3;
  }

  if (q.split(/\s+/).some((word) => {
    if (word.length < 3) return false;
    if (word.length === 3 && !SHORT_QUERY_TOKENS.has(word)) return false;
    return title.includes(word) || slug.includes(word);
  })) {
    score += 1;
  }

  const plumbingGlueContext = /\b(abs|pvc|pehd|multicouche|\bppr\b|polypropylene|colle|coller|canalisation)\b/.test(q);
  if (plumbingGlueContext) {
    const eff = inferCatalogProductAudience(product.canonical_name, product.slug, product.audience ?? "all");
    if (slug.includes("gebsoplast") || title.includes("gebsoplast")) {
      if (sessionAudience === "professional") score += 14;
      else if (sessionAudience === "particulier") score -= 24;
    }
    if (slug.includes("colle-haute-performance") || title.includes("haute performance")) {
      if (sessionAudience === "particulier") score += 14;
      else if (sessionAudience === "professional") score -= 10;
    }
    if (eff === "particulier" && sessionAudience === "professional") {
      score -= 12;
    }
    if (eff === "particulier" && sessionAudience === "particulier") {
      score += 10;
    }
    if (eff === "professional" && sessionAudience === "particulier") {
      score -= 20;
    }
  }

  if (sessionAudience) {
    const line = inferCatalogProductAudience(product.canonical_name, product.slug, product.audience ?? "all");
    if (sessionAudience === "professional" && line === "professional") score += 3;
    if (sessionAudience === "particulier" && line === "particulier") score += 3;
    if (sessionAudience === "professional" && line === "particulier") score -= 8;
    if (sessionAudience === "particulier" && line === "professional") score -= 12;
  }

  const threadedMetalSealing = asksThreadedMetalSealing(query);
  const parsedJointFluid = parseJointServiceFluid(query);
  const metalPasteJoint = asksMetalThreadPasteJoint(query);

  if (threadedMetalSealing) {
    if (slug.includes("resine") && slug.includes("tous-fluides")) score += 22;
    if (slug.includes("gebetanche") && (slug.includes("potable") || title.includes("potable"))) score += 20;
    if (slug.includes("filasse") && slug.includes("rt1")) score += 12;
    if (slug.includes("ptfe") || slug.includes("olifan")) score += 8;
    if (slug.includes("colle-haute") || title.includes("colle pvc") || slug.includes("gebsoplast")) score -= 28;
    if (!piscineContext && (slug.includes("pool") || title.includes("pool"))) score -= 45;

    if (tags.includes("eau_potable") || parsedJointFluid?.category === "eau_potable") {
      if (slug.includes("gebetanche") && slug.includes("potable")) score += 14;
      if (slug.includes("resine") && slug.includes("fluides")) score += 14;
      if (slug.includes("pool")) score -= 35;
    }
    if (hasInaccessibleThreadedJointForResinContext(query) || /\bdifficilement\s+accessible\b/.test(q)) {
      if (slug.includes("resine") && slug.includes("tous-fluides")) score += 12;
      if (slug.includes("filasse")) score -= 8;
    }
  }

  if (metalPasteJoint) {
    const parsedFluid = parseJointServiceFluid(query);
    if (title.includes("gebetanche") || slug.includes("gebetanche")) score += 16;
    if (title.includes("filasse") || slug.includes("filasse")) score += 12;
    if (title.includes("ptfe") || slug.includes("ptfe") || slug.includes("olifan")) score += 10;
    if (slug.includes("pate-a-joint") || title.includes("pate a joint")) score += 12;

    if (slug.includes("gebsoplast") || title.includes("gebsoplast") || title.includes("colle pvc")) score -= 30;
    if (slug.includes("detecteur") || title.includes("detecteur")) score -= 25;
    if (slug.includes("graisse-robinet") || (title.includes("graisse") && !title.includes("gebetanche"))) score -= 20;
    if (title.includes("inhibiteur") || title.includes("desembou") || slug.includes("g3")) score -= 18;
    if (title.includes("collafeu") || slug.includes("collafeu")) score -= 15;

    if (tags.includes("gaz") || parsedFluid?.category === "gaz") {
      if (slug.includes("gaz") || title.includes("gaz")) score += 14;
      if (slug.includes("detecteur")) score -= 30;
      if (slug.includes("graisse-robinet")) score -= 25;
    }
    if (tags.includes("eau_potable") || parsedFluid?.category === "eau_potable") {
      if (title.includes("potable") || slug.includes("potable")) score += 12;
    }
    if (tags.includes("evacuation") || parsedFluid?.category === "evacuation" || parsedFluid?.category === "evacuation_pressurized") {
      if (slug.includes("82") || title.includes("82")) score += 10;
    }
    if (tags.includes("piscine") || parsedFluid?.category === "piscine") {
      if (title.includes("pool") || slug.includes("pool") || title.includes("piscine")) score += 8;
    }
  }

  const siliconeContext = /\b(silicone|mastic\s+sanitaire)\b/.test(q);
  const fastDryAsk = /\b(rapide|plus\s+rapide|sechage|seche|secher|sechage\s+rapide)\b/.test(q);
  const chronoExplicit = /\b(60\s*(?:min|mn)?\s*chrono|silicone\s+60|60\s*chrono|\bchrono\b)/.test(q);

  if (siliconeContext) {
    if (title.includes("graisse") && slug.includes("graisse")) score -= 30;
    if (title.includes("dissolvant") || slug.includes("dissolvant")) score -= 20;
  }

  if (siliconeContext && (fastDryAsk || chronoExplicit)) {
    if (slug.includes("chrono") || title.includes("chrono")) score += 22;
    if (slug.includes("gebsicone-w3") || title.includes("w3")) score += 10;
    const curing = normalizeText(product.curing_time ?? "");
    if (/\b1\s*h\b/.test(curing) && /utilisation|appareils|sanitaire|eau/.test(curing)) score += 8;
    if (chronoExplicit && !slug.includes("chrono") && !title.includes("chrono")) score -= 18;
    if (fastDryAsk && (slug.includes("bain-cuisine") || slug.includes("silicone-bain"))) score -= 10;
  }

  const faucetLeakContext =
    /\b(robinet|mitigeur|mousseur|perlateur|bec\s+verseur)\b/.test(q) &&
    /\b(fuit|fuite|fuyait|coule|goutte|perd|perte|etancheite|colmatage)\b/.test(q);
  if (faucetLeakContext) {
    if (title.includes("filasse") || slug.includes("filasse")) score += 18;
    if (title.includes("ptfe") || slug.includes("ptfe") || slug.includes("olifan")) score += 16;
    if (slug.includes("graisse-robinet") || title.includes("graisse robinet")) score += 12;
    if (title.includes("joint") && (title.includes("robinet") || title.includes("robinetterie"))) score += 10;
    if (title.includes("degraiss") || slug.includes("degraissant") || slug === "suif" || title === "suif") score -= 40;
    if (title.includes("mousse pu") || slug.includes("mousse-pu") || title.includes("nettoyant mousse")) score -= 35;
    if (title.includes("bruleur") && title.includes("degraiss")) score -= 45;
  }

  const gutterZincLeak =
    /\b(gouttiere|gouttieres|descente\s+pluviale|zinguerie)\b/.test(q) &&
    /\b(fissure|fuit|fuite|colmat|etanche)\b/.test(q);
  if (gutterZincLeak) {
    if (slug.includes("ms-zinc") || (title.includes("ms") && title.includes("zinc"))) score += 28;
    if (slug.includes("toiturol")) score += 14;
    if (slug.includes("acrybat")) score += 8;
    if (title.includes("silicone") && title.includes("sanitaire")) score -= 18;
  }
  if (/\bzinc\b/.test(q) && /\b(mastic|etanche|fissure|gouttiere)\b/.test(q)) {
    if (slug.includes("ms-zinc") || title.includes("ms zinc")) score += 20;
  }

  if (product.extraction_version === "1.0") score += 0.5;

  return score;
}

const NAME_KEYWORD_PATTERNS: Array<{ pattern: RegExp; term: string }> = [
  { pattern: /\b(echappement|pot[\s-]?d['']?echappement)\b/i, term: "echappement" },
  { pattern: /\b(silicone|mastic)\b/i, term: "silicone" },
  { pattern: /\b(kit\s+.*liner|liner.*kit|reparation\s+liner|kit\s+reparation\s+liner)\b/i, term: "liner" },
  { pattern: /\b(kit\s+.*liner|liner.*kit|reparation\s+liner|kit\s+reparation\s+liner)\b/i, term: "kit" },
  { pattern: /\b(piscine|pool|bassin)\b/i, term: "pool" },
  { pattern: /\bliner\b/i, term: "liner" },
  { pattern: /\bcolmateur\b/i, term: "colmateur" },
  { pattern: /\bmicro[- ]?fuites?\b/i, term: "colmateur" },
  { pattern: /\b(debouch|deboucheur)\b/i, term: "debouch" },
  { pattern: /\b(desembou|g3\b|g70\b)\b/i, term: "desembou" },
  { pattern: /\b(inhibiteur|g110|g10\b)\b/i, term: "inhibiteur" },
  { pattern: /\b(detartr|descal|calcaire|detartrans)\b/i, term: "detartr" },
  { pattern: /\b(degripp|debloqu|lubrif|graisse)\b/i, term: "degripp" },
  { pattern: /\b(ptfe|filasse|ruban)\b/i, term: "ptfe" },
  { pattern: /\b(robinet|mitigeur|mousseur).*\b(fuit|fuite)\b|\b(fuit|fuite).*\b(robinet|mitigeur|mousseur)\b/i, term: "filasse" },
  { pattern: /\b(colle pvc|gebsoplast)\b/i, term: "gebsoplast" },
  { pattern: /\b(abs|\bpvc\b|pehd|multicouche|polypropylene|\bppr\b)\b/i, term: "gebsoplast" },
  { pattern: /\b(cheminee|refractaire|insert|collafeu)\b/i, term: "refract" },
  { pattern: /\b(60\s*(?:min|mn)?\s*chrono|\bchrono\b)/i, term: "chrono" },
  { pattern: /\b(gouttiere|gouttieres|descente\s+pluviale|zinguerie)\b/i, term: "zinc" },
  { pattern: /\bms[\s*-]?zinc\b/i, term: "ms-zinc" },
  { pattern: /\btoiturol\b/i, term: "toiturol" },
  { pattern: /\b(galvanis|galvageb|galva)\b/i, term: "galv" },
];

function extractNameSearchTerms(
  query: string,
  tags: string[],
  sessionAudience?: Audience | null,
): string[] {
  const terms = new Set<string>();
  const q = normalizeText(query);
  const pasteJoint = asksMetalThreadPasteJoint(query);
  const threadedSealing = asksThreadedMetalSealing(query);

  if (pasteJoint || threadedSealing) {
    const parsed = parseJointServiceFluid(query);
    for (const term of jointPasteSearchNameTerms(parsed?.category ?? null)) {
      terms.add(term);
    }
    if (hasInaccessibleThreadedJointForResinContext(query)) {
      terms.add("resine");
      terms.add("tous");
      terms.add("fluides");
    }
  }

  if (/\buniversel\b/.test(q) && /\b(inhibiteur|desembou|chauffage|plancher|radiateur|g110|g10\b)\b/.test(q)) {
    terms.add("g110");
    terms.add("inhibiteur");
  }
  for (const { pattern, term } of NAME_KEYWORD_PATTERNS) {
    if (!pattern.test(q)) continue;
    if (term === "gebsoplast" && sessionAudience === "particulier") {
      terms.add("colle");
      terms.add("haute");
      continue;
    }
    terms.add(term);
  }
  if (/\b(silicone|mastic)\b/.test(q) && /\b(rapide|sechage|seche|secher|plus\s+rapide)\b/.test(q)) {
    terms.add("chrono");
  }
  if (/\bzinc\b/.test(q)) terms.add("zinc");
  if (/\b(gouttiere|zinguerie)\b/.test(q)) {
    terms.add("zinc");
    terms.add("toiturol");
  }
  for (const code of extractCatalogProductCodes(query)) {
    terms.add(code);
  }
  for (const term of extractProductSearchTerms([query])) {
    terms.add(term);
  }
  for (const tag of tags) {
    if (tag === "toiture") {
      terms.add("toiturol");
      terms.add("zinc");
    }
    if (tag === "echappement" || tag === "montage_auto") terms.add("echappement");
    if (tag === "eau_potable") terms.add("potable");
    if (tag === "piscine") terms.add("pool");
    if (tag === "debouchage") terms.add("debouch");
    if (tag === "silicone_sanitaire") terms.add("silicone");
    if (tag === "plomberie_raccord" && !pasteJoint) {
      terms.add("pvc");
      if (sessionAudience === "particulier") {
        terms.add("colle");
        terms.add("haute");
      } else {
        terms.add("gebsoplast");
      }
    }
  }
  return [...terms];
}

async function fetchByNameTerms(locale: "fr" | "nl" | "pl", terms: string[]): Promise<ProductKnowledgeRow[]> {
  if (terms.length === 0) return [];
  const seen = new Map<string, ProductKnowledgeRow>();

  for (const term of terms) {
    const { data, error } = await supabase
      .from("product_knowledge")
      .select("*")
      .eq("locale", locale)
      .or(`canonical_name.ilike.%${term}%,slug.ilike.%${term}%`)
      .limit(15);
    if (error) {
      if (error.code === "PGRST205") return [];
      throw error;
    }
    for (const row of (data as ProductKnowledgeRow[]) ?? []) {
      if (!matchesCatalogCodeTerm(row.slug, row.canonical_name, term)) continue;
      seen.set(row.slug, row);
    }
  }

  return [...seen.values()];
}

async function fetchByExplicitProductMention(
  locale: "fr" | "nl" | "pl",
  texts: string[],
): Promise<ProductKnowledgeRow[]> {
  const terms = extractProductSearchTerms(texts);
  return fetchByNameTerms(locale, terms);
}

async function fetchExplicitCatalogProducts(
  locale: "fr" | "nl" | "pl",
  combinedText: string,
): Promise<ProductKnowledgeRow[]> {
  const rows: ProductKnowledgeRow[] = [];
  for (const { pattern, slug } of EXPLICIT_CATALOG_PRODUCT_PATTERNS) {
    if (!pattern.test(combinedText)) continue;
    const row = await getProductKnowledgeBySlug(slug, locale);
    if (row) rows.push(row);
  }
  return rows;
}

function needsCrossThemeCatalogSearch(theme: ProductTheme | null | undefined, combinedText: string): boolean {
  if (!theme) return false;
  const q = normalizeText(combinedText);
  return (
    theme === "batiment" &&
    /\b(gouttiere|gouttieres|zinc|zinguerie|descente\s+pluviale|ms[\s*-]?zinc)\b/.test(q)
  );
}

async function fetchCandidates(
  locale: "fr" | "nl" | "pl",
  theme: ProductTheme | null | undefined,
  tags: string[],
): Promise<ProductKnowledgeRow[]> {
  let query = supabase.from("product_knowledge").select("*").eq("locale", locale);

  if (theme) {
    query = query.eq("theme", theme);
  }
  if (tags.length > 0) {
    query = query.overlaps("use_case_tags", tags);
  }

  const { data, error } = await query.limit(50);
  if (error) {
    if (error.code === "PGRST205" || /product_knowledge/i.test(error.message)) return [];
    throw error;
  }
  return (data as ProductKnowledgeRow[]) ?? [];
}

export async function searchProductKnowledge(input: ProductKnowledgeSearchInput): Promise<ProductKnowledgeRow[]> {
  const tags = input.tags ?? [];
  const limit = input.limit ?? 3;
  const queryText = combineRetrievalText(input);
  const explicitTexts = explicitMatchTexts(input);

  const byTags = await fetchCandidates(input.locale, input.theme, tags);
  const needsThemeFallback =
    input.theme != null &&
    byTags.length < PRODUCT_KNOWLEDGE_THEME_FALLBACK_MIN;
  const byTagsNoTheme = needsThemeFallback
    ? await fetchCandidates(input.locale, null, tags)
    : [];
  const byTagsCrossTheme =
    needsCrossThemeCatalogSearch(input.theme, queryText) && input.theme
      ? await fetchCandidates(input.locale, null, tags)
      : [];

  const nameTerms = extractNameSearchTerms(queryText, tags, input.audience);
  const byName = await fetchByNameTerms(input.locale, nameTerms);
  const directProductLookup = explicitTexts.some(isExplicitProductLookupQuery);
  const byExplicitMention = directProductLookup
    ? await fetchByExplicitProductMention(input.locale, explicitTexts)
    : [];
  const byExplicit = await fetchExplicitCatalogProducts(input.locale, queryText);

  const merged = new Map<string, ProductKnowledgeRow>();
  for (const row of [...byExplicit, ...byExplicitMention, ...byTags, ...byTagsNoTheme, ...byTagsCrossTheme, ...byName]) {
    merged.set(row.slug, row);
  }

  let candidates = [...merged.values()].filter(
    (p) =>
      !input.audience ||
      productHasStrongExplicitMatch(p, explicitTexts) ||
      catalogAudienceVisibleForSession(input.audience, p.canonical_name, p.slug, p.audience ?? "all"),
  );

  if (candidates.length === 0 && tags.length > 0) {
    const { data, error } = await supabase
      .from("product_knowledge")
      .select("*")
      .eq("locale", input.locale)
      .limit(80);
    if (error) {
      if (error.code === "PGRST205") return [];
      throw error;
    }
    candidates = ((data as ProductKnowledgeRow[]) ?? []).filter(
      (p) =>
        !input.audience ||
        productHasStrongExplicitMatch(p, explicitTexts) ||
        catalogAudienceVisibleForSession(input.audience, p.canonical_name, p.slug, p.audience ?? "all"),
    );
  }

  if (candidates.length === 0) return [];

  const explicitSlugs = new Set(byExplicit.map((p) => p.slug));

  const scored = candidates
    .map((product) => {
      let score = scoreProduct(
        product,
        tags,
        input.material,
        input.fluid,
        queryText,
        input.audience,
        input.theme,
        explicitTexts,
      );
      if (explicitSlugs.has(product.slug)) score += 50;
      const explicitScore = computeExplicitProductMatchScore(product, explicitTexts);
      score += feedbackSlugScoreDelta(product.slug, input.feedbackAdjustments);
      return { product, score, explicitScore };
    })
    .filter(
      (item) =>
        item.score > 0 ||
        explicitSlugs.has(item.product.slug) ||
        item.explicitScore >= EXPLICIT_PRODUCT_MATCH_MIN,
    )
    .sort((a, b) => {
      const aStrong = a.explicitScore >= EXPLICIT_PRODUCT_NAME_PRIORITY_MIN;
      const bStrong = b.explicitScore >= EXPLICIT_PRODUCT_NAME_PRIORITY_MIN;
      if (bStrong || aStrong) {
        if (b.explicitScore !== a.explicitScore) return b.explicitScore - a.explicitScore;
      }
      return b.score - a.score;
    });

  if (scored.length === 0) return [];

  const strongExplicit = scored.filter((item) => item.explicitScore >= EXPLICIT_PRODUCT_NAME_PRIORITY_MIN);
  if (strongExplicit.length > 0) {
    return strongExplicit.slice(0, limit).map((item) => item.product);
  }

  return scored.slice(0, limit).map((item) => item.product);
}

export async function getProductKnowledgeBySlug(
  slug: string,
  locale: string,
): Promise<ProductKnowledgeRow | null> {
  const { data, error } = await supabase
    .from("product_knowledge")
    .select("*")
    .eq("slug", slug)
    .eq("locale", locale)
    .maybeSingle();

  if (error) {
    if (/product_knowledge/i.test(error.message) || error.code === "42P01") {
      console.warn("[product_knowledge] table not found:", error.message);
      return null;
    }
    throw error;
  }
  return (data as ProductKnowledgeRow | null) ?? null;
}

export async function upsertProductKnowledge(input: UpsertProductKnowledgeInput): Promise<void> {
  const now = new Date().toISOString();
  const row = {
    wp_id: input.wp_id,
    slug: input.slug,
    locale: input.locale,
    canonical_name: input.canonical_name,
    theme: input.theme,
    theme_source: input.theme_source ?? null,
    gamme_officielle: input.gamme_officielle ?? null,
    wp_product_cat_slugs: input.wp_product_cat_slugs ?? [],
    regulatory_scope: "GLOBAL",
    ft_url: input.ft_url,
    fds_url: input.fds_url,
    summary_technical: input.facts.summary_technical,
    advantages: input.facts.advantages,
    compatible_materials: input.facts.compatible_materials,
    incompatible_materials: input.facts.incompatible_materials,
    compatible_fluids: input.facts.compatible_fluids,
    incompatible_fluids: input.facts.incompatible_fluids,
    use_case_tags: input.facts.use_case_tags,
    applications: input.facts.applications,
    max_pressure_bar: input.facts.max_pressure_bar,
    temp_min_c: input.facts.temp_min_c,
    temp_max_c: input.facts.temp_max_c,
    curing_time: input.facts.curing_time,
    supports: input.facts.supports,
    certifications: input.facts.certifications,
    warnings: input.facts.warnings,
    source_ft_hash: input.source_ft_hash,
    extraction_version: input.extraction_version,
    extraction_model: input.extraction_model,
    extracted_at: now,
    updated_at: now,
    audience: inferCatalogProductAudience(input.canonical_name, input.slug, "all"),
  };

  const { error } = await supabase
    .from("product_knowledge")
    .upsert(row, { onConflict: "slug,locale" });

  if (error) {
    if (error.code === "PGRST205" || /product_knowledge/i.test(error.message)) {
      throw new Error(
        "Table public.product_knowledge not found. Apply migration: supabase/migrations/20260519_product_knowledge.sql in the Supabase SQL editor.",
      );
    }
    throw error;
  }
}

export async function countProductKnowledge(locale?: string): Promise<number> {
  let query = supabase.from("product_knowledge").select("id", { count: "exact", head: true });
  if (locale) query = query.eq("locale", locale);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

export async function listProductKnowledgeSlugs(locale: "fr" | "nl" | "pl"): Promise<Set<string>> {
  const { data, error } = await supabase.from("product_knowledge").select("slug").eq("locale", locale);
  if (error) {
    if (error.code === "PGRST205") return new Set();
    throw error;
  }
  return new Set((data ?? []).map((row) => String((row as { slug?: string }).slug ?? "")).filter(Boolean));
}

/**
 * Catalogue-wide lookup for explicit fiche technique / FDS requests (any product, no theme/tag filter).
 */
export async function lookupExplicitCatalogProductForSheet(input: {
  locale: "fr" | "nl" | "pl";
  userQuery: string;
  contextQuery?: string;
  audience?: Audience | null;
}): Promise<ProductKnowledgeRow | null> {
  if (!isExplicitProductLookupQuery(input.userQuery)) return null;

  const texts = [input.userQuery, input.contextQuery].filter(Boolean) as string[];

  const byMention = await fetchByExplicitProductMention(input.locale, texts);
  const mentionCandidates = byMention.filter(
    (p) =>
      !input.audience ||
      catalogAudienceVisibleForSession(input.audience, p.canonical_name, p.slug, p.audience ?? "all"),
  );
  const fromMention = resolveDirectTechnicalSheetProduct(
    input.userQuery,
    input.contextQuery ?? "",
    mentionCandidates,
  );
  if (fromMention) return fromMention;

  const products = await searchProductKnowledge({
    locale: input.locale,
    theme: null,
    tags: [],
    userQuery: input.userQuery,
    ...(input.contextQuery ? { query: input.contextQuery } : {}),
    limit: 8,
    audience: input.audience ?? null,
  });

  return resolveDirectTechnicalSheetProduct(input.userQuery, input.contextQuery ?? "", products);
}

const CITED_PRODUCT_MATCH_MIN = 35;

/** Fetch catalogue rows when the user cites a product by code/name in conversation (e.g. « que pensez-vous du G110 ? »). */
export async function lookupCatalogProductsByCitation(input: {
  locale: "fr" | "nl" | "pl";
  userQuery: string;
  audience?: Audience | null;
  limit?: number;
}): Promise<ProductKnowledgeRow[]> {
  if (!hasNamedProductCitation(input.userQuery)) return [];

  const terms = extractCitedProductSearchTerms(input.userQuery);
  if (terms.length === 0) return [];

  const byName = await fetchByNameTerms(input.locale, terms);
  const codes = extractCatalogProductCodes(input.userQuery);
  const candidates = byName.filter(
    (p) =>
      !input.audience ||
      productHasStrongExplicitMatch(p, [input.userQuery]) ||
      catalogAudienceVisibleForSession(input.audience, p.canonical_name, p.slug, p.audience ?? "all"),
  );

  const scored = candidates
    .map((product) => ({
      product,
      score: computeExplicitProductMatchScore(product, [input.userQuery]),
      codeHit: codes.some((code) => matchesCatalogCodeTerm(product.slug, product.canonical_name, code)),
    }))
    .filter((item) => item.score >= CITED_PRODUCT_MATCH_MIN || item.codeHit)
    .sort((a, b) => Number(b.codeHit) - Number(a.codeHit) || b.score - a.score);

  return scored.slice(0, input.limit ?? 2).map((item) => item.product);
}

/** Deterministic MODE 2 when the user cites a catalogue product by name (any profile/theme). */
export async function lookupCitedCatalogProductForRecommendation(input: {
  locale: "fr" | "nl" | "pl";
  userQuery: string;
  audience?: Audience | null;
}): Promise<ProductKnowledgeRow | null> {
  if (!hasNamedProductCitation(input.userQuery) || isExplicitProductLookupQuery(input.userQuery)) return null;

  const byExplicitPattern = await fetchExplicitCatalogProducts(input.locale, input.userQuery);
  const fromPattern = resolveDirectCitedProduct(input.userQuery, byExplicitPattern);
  if (fromPattern) return fromPattern;

  const products = await lookupCatalogProductsByCitation({
    locale: input.locale,
    userQuery: input.userQuery,
    audience: input.audience ?? null,
    limit: 5,
  });
  const fromCitation = resolveDirectCitedProduct(input.userQuery, products);
  if (fromCitation) return fromCitation;

  const broader = await searchProductKnowledge({
    locale: input.locale,
    theme: null,
    tags: [],
    userQuery: input.userQuery,
    limit: 6,
    audience: null,
  });
  return resolveDirectCitedProduct(input.userQuery, broader);
}
