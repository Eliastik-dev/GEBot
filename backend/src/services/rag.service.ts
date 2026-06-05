import { storageContextFromDefaults, VectorStoreIndex } from "llamaindex";
import { SupabaseVectorStore } from "@llamaindex/supabase";
import { env } from "../config/env.js";
import { GEO_TIMEOUT_MS, RESELLER_CACHE_TTL_MS, RESELLER_DIRECTORY_URL } from "../config/constants.js";
import type { Locale, ProductTheme, Reseller, StoredMessage } from "../types/index.js";
import { hasDescalingContext, hasInaccessibleThreadedJointForResinContext, isJointSealingAssemblyWithoutLeak, isPersonalDrinkwareOutOfCatalog, isPurePipeLeakDamageTurn, isThinRetrievalQuery, userTurnRelevantToLeakRepairThread, hasObviousLeakOrPipeDamageIntent, isThreadedJointOrLiquidSealingTopic } from "../utils/diagnostic-rules.js";
import { isProfileOnlyMessage, isThemeOnlyMessage } from "../utils/locale.js";
import { normalizeText } from "../utils/text.js";
import { withTimeout } from "../utils/async.js";

const PROBLEM_LEXEME_RE =
  /\b(fuite|leak|lek|wyciek|trou|hole|gat|otwor|casse|fissure|crack|rupture|perce|burst|colmate|colmater|bouch|debouch|clog|obstru|repair|reparer|fix|patch)\b/i;

const DIAGNOSTIC_QUERY_EXPANSIONS = [
  "reparation",
  "réparation",
  "repair",
  "etancheite",
  "étanchéité",
  "sealing",
  "waterproofing",
  "colmatage",
  "patch",
  "ruban",
  "bande",
  "PVC",
  "pression",
  "pressure",
  "debouchage",
  "débouchage",
  "unclog",
];

const RESINE_INACCESSIBLE_QUERY_BOOST = [
  "resine",
  "etancheite",
  "tous fluides",
  "raccord filete",
  "sans filasse",
  "liquide",
];

let resellerCache: { value: Reseller[]; expiresAt: number } | null = null;

export async function buildQueryEngine() {
  const vectorStore = new SupabaseVectorStore({
    supabaseUrl: env.SUPABASE_URL,
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY,
    table: env.SUPABASE_TABLE,
  });
  const _storageContext = await storageContextFromDefaults({ vectorStore });
  const index = await VectorStoreIndex.fromVectorStore(vectorStore);
  return { index, vectorStore };
}


export function buildSearchQuery(baseQuestion: string, fluid: string | null): string {
  const normalized = normalizeText(baseQuestion);
  const terms = new Set<string>();
  if (normalized.includes("silicone")) terms.add("silicone");
  if (normalized.includes("joint")) terms.add("joint");
  if (normalized.includes("evier") || normalized.includes("sink")) terms.add("evier");
  if (fluid) terms.add(fluid);
  if (hasInaccessibleThreadedJointForResinContext(baseQuestion)) {
    for (const t of RESINE_INACCESSIBLE_QUERY_BOOST) terms.add(t);
  }
  // Only inject plumbing diagnostic expansions if the context is actually plumbing-related
  // (avoid polluting tile/terrace/building queries with "PVC", "pression", "débouchage")
  const isPipePlumbingContext = /\b(tuyau|tube|canalisation|pipe|pvc|cuivre|pehd|raccord|conduit|plomb|evacuation|egout)\b/.test(normalized);
  const isBuildingSurfaceContext = /\b(carrelage|terrasse|mur|facade|sol|dalle|beton|pierre|brique|toiture|toit)\b/.test(normalized);
  if (isPersonalDrinkwareOutOfCatalog(baseQuestion)) {
    return baseQuestion;
  }
  if (PROBLEM_LEXEME_RE.test(baseQuestion) && isPipePlumbingContext && !isBuildingSurfaceContext) {
    for (const t of DIAGNOSTIC_QUERY_EXPANSIONS) terms.add(t);
  }
  if (terms.size === 0) return baseQuestion;
  const expansion = Array.from(terms).join(" ");
  return `${baseQuestion} ${expansion}`.trim();
}

const THEME_SEARCH_EXPANSIONS: Record<ProductTheme, Array<{ pattern: RegExp; terms: string[] }>> = {
  chauffage: [
    {
      pattern: /\b(porte|insert|cordon|tresse|corde|joint.*cheminee|cheminee.*joint|etanche.*insert|insert.*etanche)\b/i,
      terms: ["tresse", "collafeu", "colle refractaire", "joint porte insert", "cordon etancheite", "fibre ceramique", "kit tresse"],
    },
    {
      pattern: /\b(vitre|verre|carreau)\b/i,
      terms: ["collafeu", "mastic refractaire", "joint vitre insert"],
    },
    {
      pattern: /\b(fissure|ciment|brique|chamotte)\b/i,
      terms: ["ciment refractaire", "collafeu", "chamotte", "reparation foyer"],
    },
    {
      pattern: /\b(radiateur|boue|embouage|desembou)\b/i,
      terms: ["desembouant", "nettoyant circuit", "inhibiteur"],
    },
    {
      pattern: /\b(detartr|descal|calcaire|tartre|echangeur|detartrans|g6[0-3])\b/i,
      terms: ["detartrant", "Detartrans", "G60", "G61", "calcaire"],
    },
  ],
  plomberie: [
    {
      pattern: /\b(fuite|raccord|filete)\b/i,
      terms: ["ptfe", "filasse", "pate joint", "ruban etancheite"],
    },
    {
      pattern: /\b(silicone|mastic|joint).*(inaccessible|difficile|etroit|cache|derriere|endroit|espace|reduit|acces|angle|recoin)/i,
      terms: ["canule 360", "buse orientable", "embout application"],
    },
    {
      pattern: /\b(inaccessible|difficile|etroit|cache|derriere|endroit|espace|reduit|acces|angle|recoin).*(silicone|mastic|joint)/i,
      terms: ["canule 360", "buse orientable", "embout application"],
    },
  ],
  piscine: [
    {
      pattern: /\b(fuite|fissure|liner|bassin)\b/i,
      terms: ["mastic piscine", "colle pvc", "reparation liner"],
    },
  ],
  batiment: [
    {
      pattern: /\b(facade|fissure|mur|toiture)\b/i,
      terms: ["mastic acrylique", "etancheite facade", "joint batiment"],
    },
    {
      pattern: /\b(gouttiere|gouttieres|zinc|zinguerie|descente\s+pluviale)\b/i,
      terms: ["ms zinc", "mastic zinc", "toiturol", "etancheite toiture"],
    },
  ],
  maintenance: [
    {
      pattern: /\b(grippe|coince|rouille|graisse)\b/i,
      terms: ["degrippant", "lubrifiant", "graisse", "protection"],
    },
  ],
  automobile: [
    {
      pattern: /\b(echappement|pot[\s-]?d['']?echappement|silencieux|catalyseur)\b/i,
      terms: ["mastic echappement", "pate haute temperature", "reparation echappement", "collex"],
    },
    {
      pattern: /\b(moteur|carter|joint)\b/i,
      terms: ["joint moteur", "pate montage", "collex"],
    },
    {
      pattern: /\b(etancheite|etanchéité|fuite|colmat)\b/i,
      terms: ["mastic echappement", "pate haute temperature"],
    },
  ],
  "eco-conception": [],
};


export function buildThemeAwareSearchQuery(baseQuestion: string, theme: ProductTheme): string {
  const normalized = baseQuestion.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const terms = new Set<string>();

  const expansions = THEME_SEARCH_EXPANSIONS[theme] ?? [];
  for (const rule of expansions) {
    if (rule.pattern.test(normalized)) {
      for (const t of rule.terms) terms.add(t);
    }
  }

  if (terms.size === 0) return baseQuestion;
  return `${baseQuestion} ${Array.from(terms).join(" ")}`.trim();
}

/** Short or dimension-only follow-ups (e.g. "100mm") must not be the sole vector query — merge recent user turns. */

export function enrichRetrievalQuery(effectiveQuery: string, historyMessages: StoredMessage[], currentMessage: string): string {
  if (!isThinRetrievalQuery(effectiveQuery)) return effectiveQuery;
  const userTurns = historyMessages
    .filter((m) => m.role === "user" && !isProfileOnlyMessage(m.content) && !isThemeOnlyMessage(m.content) && m.content.trim().length > 6)
    .slice(-6)
    .map((m) => m.content.trim());

  const currentLeak = hasObviousLeakOrPipeDamageIntent(currentMessage);
  const effectiveLeak = hasObviousLeakOrPipeDamageIntent(effectiveQuery);
  const threadedSealingFocus =
    isThreadedJointOrLiquidSealingTopic(currentMessage) && !currentLeak && !effectiveLeak;
  const sessionDescaling =
    hasDescalingContext(currentMessage) ||
    hasDescalingContext(effectiveQuery) ||
    userTurns.some((t) => hasDescalingContext(t));
  const descalingFocus =
    sessionDescaling && !currentLeak && !effectiveLeak && !threadedSealingFocus;

  let turnsToMerge: string[];
  if (descalingFocus) {
    turnsToMerge = userTurns.filter(
      (t) =>
        hasDescalingContext(t) ||
        /\b(g60|g61|detartrans|aluminium|eau\s+sanitaire|echangeur|pas\s+de\s+fuite)\b/i.test(t) ||
        (!hasObviousLeakOrPipeDamageIntent(t) && isThinRetrievalQuery(t)),
    );
  } else if (threadedSealingFocus) {
    turnsToMerge = userTurns.filter((t) => !isPurePipeLeakDamageTurn(t));
  } else {
    const sessionInLeakThread =
      currentLeak || effectiveLeak || userTurns.some((t) => hasObviousLeakOrPipeDamageIntent(t));
    turnsToMerge = sessionInLeakThread
      ? userTurns.filter((t) => userTurnRelevantToLeakRepairThread(t))
      : userTurns;
  }

  const merged = [...turnsToMerge];
  if (!merged.includes(effectiveQuery.trim())) merged.push(effectiveQuery.trim());
  return [...new Set(merged)].join("\n");
}


export function capContextNodes<T>(nodes: T[], max: number): T[] {
  if (nodes.length <= max) return nodes;
  return nodes.slice(0, max);
}

export const AUTOMOTIVE_EXHAUST_SUPPLEMENT_QUERY =
  "PATE DE MONTAGE ECHAPPEMENT COLLEX MASTIC REPARATION ECHAPPEMENT pot echappement haute temperature etancheite";

function getNodeSlug(item: unknown): string {
  const metadata = (item as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
  return String(metadata.slug ?? "");
}

/** Merge retrieval pools, keeping supplemental hits first and deduplicating by slug. */
export function mergeRetrievalNodes<T>(primary: T[], supplemental: T[]): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const node of [...supplemental, ...primary]) {
    const slug = getNodeSlug(node);
    const key = slug || String(merged.length);
    if (slug && seen.has(key)) continue;
    if (slug) seen.add(key);
    merged.push(node);
  }
  return merged;
}


export function extractSourceUrlsFromNodes(nodes: unknown[]): string[] {
  const urls = new Set<string>();
  for (const item of nodes) {
    const candidate = item as { node?: { metadata?: Record<string, unknown> } };
    const metadata = candidate.node?.metadata ?? {};
    const urlValue = metadata.source_url ?? metadata.url;
    if (typeof urlValue === "string" && urlValue.trim()) {
      urls.add(urlValue.trim());
    }
  }
  return Array.from(urls).slice(0, env.DIAGNOSTIC_MAX_SOURCE_URLS);
}


export function isTechnicalSheetNode(node: unknown): boolean {
  const metadata = (node as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
  const title = String(metadata.title ?? "").toLowerCase();
  const slug = String(metadata.slug ?? "").toLowerCase();
  const sourceUrl = String(metadata.source_url ?? metadata.url ?? "").toLowerCase();
  const marker = `${title} ${slug} ${sourceUrl}`;
  const hasTechnicalMarker =
    marker.includes("fiche technique") ||
    marker.includes("technical data sheet") ||
    marker.includes("tds") ||
    marker.includes("ft_");
  const isPdf = sourceUrl.includes(".pdf");
  const isCatalog = marker.includes("catalogue") || marker.includes("catalog");
  return isPdf && hasTechnicalMarker && !isCatalog;
}


export function isPdfNode(node: unknown): boolean {
  const metadata = (node as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
  const sourceUrl = String(metadata.source_url ?? metadata.url ?? "").toLowerCase();
  const type = String(metadata.type ?? "").toLowerCase();
  const source = String(metadata.source ?? "").toLowerCase();
  return sourceUrl.includes(".pdf") || type === "pdf" || source.includes("pdf");
}


export function isCatalogNode(node: unknown): boolean {
  const metadata = (node as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
  const title = String(metadata.title ?? "").toLowerCase();
  const slug = String(metadata.slug ?? "").toLowerCase();
  const sourceUrl = String(metadata.source_url ?? metadata.url ?? "").toLowerCase();
  const marker = `${title} ${slug} ${sourceUrl}`;
  return marker.includes("catalogue") || marker.includes("catalog");
}


export function summarizeNodeForDebug(node: unknown): Record<string, string | boolean> {
  const metadata = (node as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
  const title = String(metadata.title ?? "");
  const slug = String(metadata.slug ?? "");
  const sourceUrl = String(metadata.source_url ?? metadata.url ?? "");
  const type = String(metadata.type ?? "");
  const source = String(metadata.source ?? "");
  return {
    title,
    slug,
    sourceUrl,
    type,
    source,
    theme: String(metadata.theme ?? ""),
    isTechnical: isTechnicalSheetNode(node),
    isPdf: isPdfNode(node),
    isCatalog: isCatalogNode(node),
  };
}


function isProductKnowledgeNode(node: unknown): boolean {
  const metadata = (node as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
  return metadata.type === "product_knowledge";
}

export function prioritizeTechnicalSheets<T>(nodes: T[]): T[] {
  const catalogNodes = nodes.filter((node) => isProductKnowledgeNode(node));
  const nonCatalogNodes = nodes.filter((node) => !isProductKnowledgeNode(node));

  const technicalNodes = nonCatalogNodes.filter((node) => isTechnicalSheetNode(node));
  if (technicalNodes.length > 0) return [...catalogNodes, ...technicalNodes];
  const pdfNonCatalogNodes = nonCatalogNodes.filter((node) => isPdfNode(node) && !isCatalogNode(node));
  if (pdfNonCatalogNodes.length > 0) return [...catalogNodes, ...pdfNonCatalogNodes];
  if (catalogNodes.length > 0) return catalogNodes;
  return [];
}


export function mapWpReseller(item: Record<string, unknown>): Reseller | null {
  const title = item.title;
  const renderedTitle =
    title && typeof title === "object" && typeof (title as { rendered?: unknown }).rendered === "string"
      ? ((title as { rendered?: string }).rendered ?? "")
      : "";
  const acf = item.acf && typeof item.acf === "object" ? (item.acf as Record<string, unknown>) : {};
  const link =
    (typeof item.url === "string" && item.url) ||
    (typeof item.link === "string" && item.link) ||
    (typeof item.website === "string" && item.website) ||
    (typeof acf.url === "string" && acf.url) ||
    (typeof acf.website === "string" && acf.website);
  const name =
    (typeof item.name === "string" && item.name) ||
    renderedTitle ||
    (typeof item.title === "string" && item.title) ||
    (typeof item.slug === "string" && item.slug);
  if (!name) return null;
  const city =
    (typeof item.city === "string" && item.city) || (typeof acf.city === "string" && acf.city) || undefined;
  const country =
    (typeof item.country === "string" && item.country) ||
    (typeof acf.country === "string" && acf.country) ||
    undefined;
  return {
    name,
    ...(link ? { url: link } : {}),
    ...(city ? { city } : {}),
    ...(country ? { country } : {}),
  };
}


export async function fetchResellersFromWordPress(): Promise<Reseller[]> {
  const apiBase = env.WP_URL.replace(/\/$/, "");
  const siteBase = apiBase
    .replace(/\/wp-json\/wp\/v2\/?$/i, "")
    .replace(/\/wp-json\/?$/i, "")
    .replace(/\/wp\/v2\/?$/i, "");
  const candidateUrls = [
    env.WP_RESELLERS_ENDPOINT,
    `${apiBase}/resellers`,
    `${siteBase}/wp-json/wp/v2/resellers`,
    `${siteBase}/wp-json/wp/v2/store_locator`,
    `${siteBase}/wp-json/acf/v3/resellers`,
  ]
    .map((url) => {
      if (url.startsWith("http")) return url;
      if (url.startsWith("/wp-json")) return `${siteBase}${url}`;
      return `${apiBase}${url.startsWith("/") ? url : `/${url}`}`;
    })
    .filter((value, index, array) => array.indexOf(value) === index);

  for (const url of candidateUrls) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) continue;
      const json = (await response.json()) as unknown;
      const rows = Array.isArray(json)
        ? json
        : json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)
          ? ((json as { data: unknown[] }).data ?? [])
          : [];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const mapped = rows
        .map((item) => (item && typeof item === "object" ? mapWpReseller(item as Record<string, unknown>) : null))
        .filter((item): item is Reseller => Boolean(item));
      if (mapped.length > 0) return mapped;
    } catch {
      // Try the next endpoint.
    }
  }
  return [];
}


export async function getCachedResellers(): Promise<Reseller[]> {
  if (resellerCache && resellerCache.expiresAt > Date.now()) {
    return resellerCache.value;
  }
  const fetched = await fetchResellersFromWordPress();
  const value =
    fetched.length > 0
      ? fetched
      : [
          {
            name: "Annuaire officiel des revendeurs GEB",
            url: RESELLER_DIRECTORY_URL,
            country: "France",
          },
        ];
  resellerCache = { value, expiresAt: Date.now() + RESELLER_CACHE_TTL_MS };
  return value;
}


export async function geolocateIp(ip: string | null): Promise<{ countryCode: string | null }> {
  if (!ip) return { countryCode: null };
  const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/`;
  const response = await withTimeout(fetch(url, { headers: { Accept: "application/json" } }), GEO_TIMEOUT_MS, "IP_GEO");
  if (!response.ok) return { countryCode: null };
  const payload = (await response.json()) as { country_code?: string };
  const countryCode = payload.country_code?.toUpperCase() ?? null;
  return { countryCode };
}

