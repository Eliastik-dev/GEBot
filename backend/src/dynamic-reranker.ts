/**
 * Dynamic Reranker
 *
 * Replaces hardcoded boosts in applyHybridLexiconRerank with intent-aware
 * scoring that dynamically weights results based on extracted metadata.
 */

import type { ExtractedMetadata, Intent } from "./intent-extractor.js";
import type { ProductTheme } from "./types/index.js";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ScoredNode<T> {
  node: T;
  sortKey: number;
  idx: number;
}

// ── Intent-specific boost coefficients ─────────────────────────────────────────

type BoostRule = {
  keywords: string[];
  coefficient: number;
};

const INTENT_BOOST_RULES: Record<Intent, BoostRule[]> = {
  leak_repair: [
    { keywords: ["fuite", "colmat", "reparation", "etancheite", "patch", "bande"], coefficient: 0.15 },
    { keywords: ["ft", "tds", "fiche technique"], coefficient: 0.10 },
    { keywords: ["fds", "sds", "securite", "safety"], coefficient: 0.08 },
  ],
  inaccessible_leak: [
    { keywords: ["resine", "resin", "anaerobie", "anaerobique", "liquide"], coefficient: 0.25 },
    { keywords: ["raccord", "filete", "filetage", "inaccessible", "etroit"], coefficient: 0.15 },
    { keywords: ["ft", "tds", "fiche technique"], coefficient: 0.10 },
  ],
  sealing_assembly: [
    { keywords: ["raccord", "filete", "joint", "ptfe", "ruban", "filasse", "etancheite"], coefficient: 0.15 },
    { keywords: ["resine", "liquide", "thread"], coefficient: 0.10 },
  ],
  pipe_repair: [
    { keywords: ["reparation", "tube", "canalisation", "bande", "epoxy", "renfort"], coefficient: 0.15 },
    { keywords: ["colmat", "patch", "soudure", "brasure"], coefficient: 0.10 },
    { keywords: ["ft", "tds", "fiche technique"], coefficient: 0.10 },
  ],
  silicone_application: [
    { keywords: ["silicone", "mastic", "sanitaire", "joint"], coefficient: 0.15 },
    { keywords: ["evier", "douche", "baignoire", "carrelage"], coefficient: 0.08 },
  ],
  installation_lubrication: [
    { keywords: ["graisse", "lubrifiant", "montage", "assemblage", "vaseline"], coefficient: 0.15 },
    { keywords: ["raccord", "manchon", "evacuation"], coefficient: 0.08 },
  ],
  bypass_issue: [
    { keywords: ["bypass", "derivation", "contournement"], coefficient: 0.20 },
  ],
  product_info: [
    { keywords: ["ft", "tds", "fiche technique", "fiche produit"], coefficient: 0.12 },
  ],
  general_technical: [],
  reseller_query: [],
  unknown: [],
};

// ── Fluid-based boost ──────────────────────────────────────────────────────────

const FLUID_BOOST_KEYWORDS: Record<string, string[]> = {
  eau: ["eau", "potable", "usee", "evacuation", "sanitaire", "water"],
  gaz: ["gaz", "gas", "gpl"],
  chauffage: ["chauffage", "heating", "fioul", "caloporteur", "desembouant", "nettoyant", "boue", "radiateur", "neutralisant", "inhibiteur", "g3", "g70"],
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getNodeTextForScoring(item: unknown): string {
  const wrap = item as {
    node?: { text?: string; getContent?: (mode?: string) => string; metadata?: Record<string, unknown> };
    text?: string;
  };
  const meta = wrap.node?.metadata ?? {};
  const title = String(meta.title ?? "");
  const slug = String(meta.slug ?? "");
  let body = "";
  if (typeof wrap.node?.getContent === "function") {
    try {
      body = wrap.node.getContent("NONE") ?? "";
    } catch {
      body = "";
    }
  } else if (typeof wrap.node?.text === "string") {
    body = wrap.node.text;
  } else if (typeof wrap.text === "string") {
    body = wrap.text;
  }
  const sheet = String(meta.sheet_type ?? "");
  return normalizeText(`${title} ${slug} ${sheet} ${body.slice(0, 4000)}`);
}

function getNodeSheetType(item: unknown): string {
  const metadata = (item as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
  return String(metadata.sheet_type ?? "").toLowerCase();
}

function getNodeTheme(item: unknown): string {
  const metadata = (item as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
  return String(metadata.theme ?? "").toLowerCase();
}

function getNodeTitleSlug(item: unknown): string {
  const metadata = (item as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
  return normalizeText(`${metadata.title ?? ""} ${metadata.slug ?? ""}`);
}

const EXHAUST_QUERY_PATTERN =
  /\b(echappement|pot[\s-]?d['']?echappement|silencieux|catalyseur|collecteur)\b/i;

const AUTOMOTIVE_QUERY_PATTERN =
  /\b(echappement|pot[\s-]?d['']?echappement|catalyseur|collecteur|ligne?\s+d['']?echappement|silencieux|moteur|carter|vehicule|automobile|auto)\b/i;

const EXHAUST_PRODUCT_KEYWORDS = [
  "echappement",
  "montage echappement",
  "reparation echappement",
  "collex",
  "haute temperature",
  "900",
  "1100",
  "pot echappement",
  "silencieux",
];

const EXHAUST_IRRELEVANT_KEYWORDS = [
  "demarre moteur",
  "rodoir",
  "soupape",
  "brasure",
  "retouche email",
  "hampton",
  "degraissant bruleur",
  "startex",
  "pare-brise",
  "pare brise",
];

const PLUMBING_PRODUCT_KEYWORDS = [
  "eau potable",
  "sanitaire",
  "robinet",
  "evier",
  "bonde",
  "wc",
  "canalisation",
  "cuivre etain",
  "filasse",
  "ptfe",
  "raccord filete",
];

export function isAutomotiveExhaustContext(...texts: string[]): boolean {
  const combined = normalizeText(texts.join(" "));
  return EXHAUST_QUERY_PATTERN.test(combined);
}

export function hasExhaustProductInNodes(nodes: unknown[]): boolean {
  return nodes.some((node) => getNodeTitleSlug(node).includes("echappement"));
}

// ── Dynamic scoring function ───────────────────────────────────────────────────

function computeIntentBoost(text: string, metadata: ExtractedMetadata, userQuery: string): number {
  let boost = 0;

  const rules = INTENT_BOOST_RULES[metadata.intent] ?? [];
  for (const rule of rules) {
    const hits = rule.keywords.filter((kw) => text.includes(normalizeText(kw)));
    if (hits.length > 0) {
      boost += rule.coefficient * (hits.length / rule.keywords.length);
    }
  }

  // Fluid-specific boost (skip for automotive exhaust — "eau potable" must not win over exhaust sealants)
  const automotiveContext = isAutomotiveExhaustContext(userQuery);
  if (metadata.fluid && !(automotiveContext && metadata.fluid === "eau")) {
    const fluidKeywords = FLUID_BOOST_KEYWORDS[metadata.fluid] ?? [];
    const fluidHits = fluidKeywords.filter((kw) => text.includes(normalizeText(kw)));
    if (fluidHits.length > 0) {
      boost += 0.06 * (fluidHits.length / fluidKeywords.length);
    }
  }

  // Material match boost
  if (metadata.material && text.includes(normalizeText(metadata.material))) {
    boost += 0.08;
  }

  // Synonym injection boost
  for (const syn of metadata.synonyms) {
    if (text.includes(normalizeText(syn))) {
      boost += 0.02;
    }
  }

  // Extra boost for surface-sealing products when context is building/tiles
  const isSurfaceContext = metadata.material && /carrelage|terrasse|balcon|dalle|beton|pierre|facade|mur|brique/.test(metadata.material);
  if (isSurfaceContext && metadata.intent === "sealing_assembly") {
    const surfaceProductKeywords = ["exthane", "acrybat", "mastic", "acrylique", "joint", "fissure", "terrasse", "carrelage", "facade"];
    const surfaceHits = surfaceProductKeywords.filter((kw) => text.includes(kw));
    if (surfaceHits.length > 0) {
      boost += 0.12 * (surfaceHits.length / surfaceProductKeywords.length);
    }
    if (text.includes("exthane")) boost += 0.18;
  }

  return boost;
}

function computeSheetTypeBoost(sheetType: string, metadata: ExtractedMetadata): number {
  const isLeakLike = ["leak_repair", "pipe_repair", "inaccessible_leak"].includes(metadata.intent);
  const isFaqLike = metadata.intent === "general_technical" || metadata.intent === "product_info";

  if (sheetType === "faq") {
    return isFaqLike ? 0.22 : 0.1;
  }
  if (sheetType === "ft" || sheetType === "tds") {
    return isLeakLike ? 0.08 : 0.04;
  }
  if (sheetType === "fds" || sheetType === "sds") {
    return isLeakLike ? 0.06 : 0.02;
  }
  return 0;
}

function computeExhaustUseCaseBoost(titleSlug: string, userQuery: string, searchQuery: string): number {
  if (!isAutomotiveExhaustContext(userQuery, searchQuery)) return 0;

  let boost = 0;
  if (titleSlug.includes("echappement")) {
    boost += 0.55;
  }
  if (titleSlug.includes("montage echappement")) {
    boost += 0.35;
  }
  if (titleSlug.includes("reparation echappement") || (titleSlug.includes("mastic") && titleSlug.includes("echappement"))) {
    boost += 0.25;
  }
  return boost;
}

function computeThemeBoost(
  titleSlug: string,
  text: string,
  nodeTheme: string,
  theme: ProductTheme | null | undefined,
  userQuery: string,
  searchQuery: string,
  softThemeFilter = false,
  explicitProductSlugs: string[] = [],
): number {
  let boost = 0;
  const exhaustContext = isAutomotiveExhaustContext(userQuery, searchQuery);
  const automotiveContext = theme === "automobile" || AUTOMOTIVE_QUERY_PATTERN.test(normalizeText(`${userQuery} ${searchQuery}`));

  if (
    explicitProductSlugs.length > 0 &&
    explicitProductSlugs.some((slug) => {
      const normSlug = normalizeText(slug.replace(/-/g, " "));
      return text.includes(normSlug) || titleSlug.includes(normSlug);
    })
  ) {
    boost += 0.28;
  }

  if (theme && nodeTheme === theme) {
    boost += 0.12;
  } else if (theme && nodeTheme && nodeTheme !== theme) {
    boost -= softThemeFilter ? 0.03 : 0.18;
  }

  if (exhaustContext) {
    const exhaustHits = EXHAUST_PRODUCT_KEYWORDS.filter((kw) => text.includes(normalizeText(kw)));
    if (exhaustHits.length > 0) {
      boost += 0.22 * (exhaustHits.length / EXHAUST_PRODUCT_KEYWORDS.length);
    }
    boost += computeExhaustUseCaseBoost(titleSlug, userQuery, searchQuery);
  } else if (automotiveContext) {
    if (text.includes("collex") || text.includes("automobile") || text.includes("vehicule")) {
      boost += 0.08;
    }
  }

  return boost;
}

function computeDemotionPenalty(
  text: string,
  metadata: ExtractedMetadata,
  userQuery: string,
  searchQuery: string,
  theme: ProductTheme | null | undefined,
): number {
  let penalty = 0;

  // Demote "déboucheur" results for sealing/fitting queries
  if (text.includes("debouch") && metadata.intent !== "general_technical") {
    const sealingIntents: Intent[] = ["sealing_assembly", "inaccessible_leak", "leak_repair"];
    if (sealingIntents.includes(metadata.intent)) {
      penalty += 0.25;
    }
  }

  // Demote sink-related results when user asks about pipes
  if (text.includes("evier") || text.includes("sink")) {
    const pipeIntents: Intent[] = ["leak_repair", "pipe_repair"];
    if (pipeIntents.includes(metadata.intent) && !/evier|sink|lavabo|spoelbak/i.test(normalizeText(userQuery))) {
      penalty += 0.15;
    }
  }

  // Demote plumbing-only products for building/surface contexts (e.g. tile crack)
  const isSurfaceContext = metadata.material && /carrelage|terrasse|balcon|dalle|beton|pierre|facade|mur|brique/.test(metadata.material);
  if (isSurfaceContext) {
    const plumbingOnlySignals = ["eau potable", "raccord", "filete", "ptfe", "pvc", "tuyau", "canalisation"];
    const plumbingHits = plumbingOnlySignals.filter((kw) => text.includes(kw));
    if (plumbingHits.length >= 2) {
      penalty += 0.20;
    }
    const queryNorm = normalizeText(userQuery);
    const zincRoofContext = /\b(zinc|zinguerie|gouttiere|toiture|toiturol)\b/.test(queryNorm);
    if (!zincRoofContext && (text.includes("ms zinc") || text.includes("toiturol"))) {
      penalty += 0.22;
    }
    if (text.includes("silicone sanitaire") || (text.includes("sanitaire") && text.includes("silicone"))) {
      penalty += 0.18;
    }
  }

  const automotiveContext = theme === "automobile" || isAutomotiveExhaustContext(userQuery, searchQuery);
  if (automotiveContext) {
    const plumbingHits = PLUMBING_PRODUCT_KEYWORDS.filter((kw) => text.includes(normalizeText(kw)));
    if (plumbingHits.length > 0) {
      penalty += 0.22 * Math.min(plumbingHits.length / 2, 1);
    }
    if (text.includes("eau potable") || text.includes("potable")) {
      penalty += 0.35;
    }
    if (isAutomotiveExhaustContext(userQuery, searchQuery)) {
      const irrelevantHits = EXHAUST_IRRELEVANT_KEYWORDS.filter((kw) => text.includes(normalizeText(kw)));
      if (irrelevantHits.length > 0) {
        penalty += 0.45 * Math.min(irrelevantHits.length / 2, 1);
      }
      if (text.includes("demarre moteur") || text.includes("startex")) {
        penalty += 0.55;
      }
      if (text.includes("rodoir") || (text.includes("soupape") && !text.includes("echappement"))) {
        penalty += 0.40;
      }
    } else {
      if (text.includes("soupape") && !text.includes("echappement")) {
        penalty += 0.15;
      }
      if (text.includes("demarre moteur") || text.includes("degraissant bruleur")) {
        penalty += 0.12;
      }
    }
  }

  return penalty;
}

function computeLiteThemeBoost(
  nodeTheme: string,
  theme: ProductTheme | null | undefined,
  softThemeFilter = false,
): number {
  if (!theme) return 0;
  if (nodeTheme === theme) return 0.1;
  if (nodeTheme && nodeTheme !== theme) return softThemeFilter ? -0.02 : -0.12;
  return 0;
}

function computeLiteDemotionPenalty(text: string, metadata: ExtractedMetadata, userQuery: string): number {
  let penalty = 0;

  if (text.includes("debouch") && metadata.intent !== "general_technical") {
    const sealingIntents: Intent[] = ["sealing_assembly", "inaccessible_leak", "leak_repair"];
    if (sealingIntents.includes(metadata.intent)) penalty += 0.2;
  }

  if (text.includes("evier") || text.includes("sink")) {
    const pipeIntents: Intent[] = ["leak_repair", "pipe_repair"];
    if (pipeIntents.includes(metadata.intent) && !/evier|sink|lavabo|spoelbak/i.test(normalizeText(userQuery))) {
      penalty += 0.12;
    }
  }

  const isSurfaceContext =
    metadata.material && /carrelage|terrasse|dalle|beton|pierre|facade|mur|brique/.test(metadata.material);
  if (isSurfaceContext) {
    const plumbingOnlySignals = ["eau potable", "raccord", "filete", "ptfe", "pvc", "tuyau", "canalisation"];
    const plumbingHits = plumbingOnlySignals.filter((kw) => text.includes(kw));
    if (plumbingHits.length >= 2) penalty += 0.15;
  }

  return penalty;
}

export type DynamicRerankOptions = {
  /** Phase 4: intent + sheet-type scoring only; no automotive/exhaust scenario patches. */
  lite?: boolean;
  /** Session theme is a soft boost (explicit product targeted) — reduce cross-theme demotion. */
  softThemeFilter?: boolean;
  /** Slugs from explicit catalogue citation — boost matching nodes regardless of theme. */
  explicitProductSlugs?: string[];
};

/**
 * Dynamic reranker that replaces the old hardcoded applyHybridLexiconRerank.
 * Uses extracted metadata + intent to score and reorder retrieval results.
 */
export function dynamicRerank<T>(
  nodes: T[],
  userQuery: string,
  searchQuery: string,
  metadata: ExtractedMetadata,
  theme?: ProductTheme | null,
  options?: DynamicRerankOptions,
): T[] {
  if (nodes.length <= 1) return [...nodes];

  const lite = options?.lite ?? false;
  const softThemeFilter = options?.softThemeFilter ?? false;
  const explicitProductSlugs = options?.explicitProductSlugs ?? [];

  const scored: ScoredNode<T>[] = nodes.map((node, idx) => {
    const vectorScore = typeof (node as { score?: number }).score === "number"
      ? (node as { score?: number }).score!
      : 0;
    const text = getNodeTextForScoring(node);
    const titleSlug = getNodeTitleSlug(node);
    const sheetType = getNodeSheetType(node);
    const nodeTheme = getNodeTheme(node);

    const intentBoost = computeIntentBoost(text, metadata, userQuery);
    const themeBoost = lite
      ? computeLiteThemeBoost(nodeTheme, theme, softThemeFilter)
      : computeThemeBoost(
          titleSlug,
          text,
          nodeTheme,
          theme,
          userQuery,
          searchQuery,
          softThemeFilter,
          explicitProductSlugs,
        );
    const sheetBoost = computeSheetTypeBoost(sheetType, metadata);
    const penalty = lite
      ? computeLiteDemotionPenalty(text, metadata, userQuery)
      : computeDemotionPenalty(text, metadata, userQuery, searchQuery, theme);

    const sortKey = vectorScore + intentBoost + themeBoost + sheetBoost - penalty;

    return { node, sortKey, idx };
  });

  scored.sort((a, b) => (b.sortKey !== a.sortKey ? b.sortKey - a.sortKey : a.idx - b.idx));
  return scored.map((s) => s.node);
}

/**
 * Build an enriched search query by injecting synonyms and technical terms
 * from the extracted metadata. Replaces the old buildSearchQuery.
 */
export function buildEnrichedSearchQuery(
  baseQuestion: string,
  metadata: ExtractedMetadata,
  options?: { lite?: boolean },
): string {
  const lite = options?.lite ?? false;
  const terms = new Set<string>();

  // Add synonyms from intent classification
  for (const syn of metadata.synonyms) {
    terms.add(syn);
  }

  // Add fluid context
  if (metadata.fluid) terms.add(metadata.fluid);

  // Add material
  if (metadata.material) terms.add(metadata.material);

  // Add diameter context
  if (metadata.diameter) terms.add(`${metadata.diameter}mm`);

  // Add intent-specific expansions
  if (metadata.intent === "inaccessible_leak") {
    if (/\bpiscine\b/i.test(baseQuestion)) {
      terms.add("colmateur");
      terms.add("micro-fuite");
      terms.add("canalisation enterrée");
    } else {
      terms.add("résine d'étanchéité");
      terms.add("raccord fileté");
      terms.add("sans filasse");
      terms.add("liquide");
    }
  }

  const isDescaling = /\b(detartr|descal|calcaire|tartre|detartrans|g6[0-3])\b/i.test(baseQuestion);
  if (/\b(gourde|bouteille\s+de\s+boire|bouteille\s+isotherme)\b/i.test(baseQuestion)) {
    return baseQuestion;
  }
  if (!isDescaling && (metadata.intent === "leak_repair" || metadata.intent === "pipe_repair")) {
    terms.add("colmatage");
    terms.add("réparation");
    terms.add("fiche technique");
  }

  // Surface-sealing context: add building-relevant terms instead of pipe terms
  const isSurfaceContext = metadata.material && /carrelage|terrasse|dalle|beton|pierre|facade|mur|brique/.test(metadata.material);
  if (metadata.intent === "sealing_assembly" && isSurfaceContext) {
    terms.add("mastic");
    terms.add("acrylique");
    terms.add("joint");
    terms.add("fissure");
  }

  if (!lite && metadata.intent === "sealing_assembly" && isAutomotiveExhaustContext(baseQuestion)) {
    terms.add("pate montage echappement");
    terms.add("mastic reparation echappement");
    terms.add("collex");
    terms.add("haute temperature");
  }

  if (terms.size === 0) return baseQuestion;

  const expansion = Array.from(terms).join(" ");
  return `${baseQuestion} ${expansion}`.trim();
}
