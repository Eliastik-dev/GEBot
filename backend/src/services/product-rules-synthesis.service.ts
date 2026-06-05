import {
  USE_CASE_TAG_VOCABULARY,
  type ScrapedProductRow,
} from "./product-theme.service.js";
import { resolveProductTheme } from "./wp-catalog-theme.service.js";
import type { ProductTheme } from "../types/index.js";
import type { SynthesizedProductFacts } from "../types/product-knowledge.js";

export const RULES_EXTRACTION_VERSION = "1.0-rules";

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const TAG_PATTERNS: Array<{ pattern: RegExp; tags: string[] }> = [
  { pattern: /\b(echappement|pot echappement)\b/, tags: ["echappement", "montage_auto", "haute_temperature"] },
  { pattern: /\b(pool|piscine|liner|bassin|spa)\b/, tags: ["piscine"] },
  { pattern: /\b(silicone|sanitaire|evier|douche|baignoire|wc)\b/, tags: ["silicone_sanitaire"] },
  { pattern: /\b(debouch|deboucheur)\b/, tags: ["debouchage"] },
  { pattern: /\b(degripp|debloqu|lubrif|graisse)\b/, tags: ["lubrification", "maintenance"] },
  { pattern: /\b(desembou|g3\b|g70\b|radiateur|embouage)\b/, tags: ["desembouage", "chauffage"] },
  { pattern: /\b(detartr|descal|calcaire|tartre|detartrans)\b/, tags: ["maintenance"] },
  { pattern: /\b(eau potable|potable)\b/, tags: ["eau_potable"] },
  { pattern: /\b(evacuation|egout|usee)\b/, tags: ["evacuation"] },
  { pattern: /\b(gaz|gpl)\b/, tags: ["gaz"] },
  { pattern: /\b(etanche|joint|mastic|pate|raccord|ptfe|filasse|ruban)\b/, tags: ["etancheite_filetage", "plomberie_raccord"] },
  { pattern: /\b(fuite|colmat|repar)\b/, tags: ["reparation_fuite"] },
  { pattern: /\b(900|1100|haute temp|refractaire|cheminee|insert|feu)\b/, tags: ["haute_temperature", "cheminee"] },
  { pattern: /\b(facade|toiture|terrasse|carrelage|bitume)\b/, tags: ["facade", "carrelage"] },
  { pattern: /\b(facade|mur exterieur)\b/, tags: ["facade"] },
  { pattern: /\b(auto|vehicule|moteur|carter|collex)\b/, tags: ["montage_auto", "reparation_auto"] },
];

const THEME_DEFAULT_TAGS: Record<ProductTheme, string[]> = {
  plomberie: ["plomberie_raccord"],
  piscine: ["piscine"],
  chauffage: ["chauffage"],
  batiment: ["facade"],
  maintenance: ["maintenance"],
  automobile: ["montage_auto"],
  "eco-conception": ["maintenance"],
};

const MATERIAL_KEYWORDS = ["acier", "inox", "cuivre", "laiton", "pvc", "pehd", "multicouche", "fonte", "beton", "carrelage", "ceramique"];
const FLUID_KEYWORDS = ["eau potable", "eau usee", "gaz", "huile", "fioul", "chauffage"];

export function inferUseCaseTags(title: string, pdfText: string, theme: ProductTheme): string[] {
  const combined = normalizeText(`${title} ${pdfText.slice(0, 3000)}`);
  const allowed = new Set<string>(USE_CASE_TAG_VOCABULARY);
  const tags = new Set<string>();

  for (const { pattern, tags: ruleTags } of TAG_PATTERNS) {
    if (pattern.test(combined)) {
      for (const tag of ruleTags) if (allowed.has(tag)) tags.add(tag);
    }
  }
  for (const tag of THEME_DEFAULT_TAGS[theme] ?? []) {
    if (allowed.has(tag)) tags.add(tag);
  }

  return [...tags];
}

function extractNumericSpecs(text: string): Pick<SynthesizedProductFacts, "max_pressure_bar" | "temp_min_c" | "temp_max_c" | "curing_time"> {
  const norm = normalizeText(text);
  const pressureMatch = norm.match(/(\d+(?:[.,]\d+)?)\s*bar\b/);
  const tempMatches = [...norm.matchAll(/(-?\d+(?:[.,]\d+)?)\s*°?\s*c\b/g)].map((m) => parseFloat(m[1]!.replace(",", ".")));
  const curingMatch = text.match(/(?:sechage|séchage|prise)[^\n.]{0,40}(\d+[^\n.]{0,30})/i);

  return {
    max_pressure_bar: pressureMatch ? parseFloat(pressureMatch[1]!.replace(",", ".")) : null,
    temp_min_c: tempMatches.length > 0 ? Math.min(...tempMatches) : null,
    temp_max_c: tempMatches.length > 0 ? Math.max(...tempMatches) : null,
    curing_time: curingMatch?.[1]?.trim() ?? null,
  };
}

function extractKeywordList(text: string, keywords: string[]): string[] {
  const norm = normalizeText(text);
  return keywords.filter((kw) => norm.includes(normalizeText(kw)));
}

export function buildRulesBasedFacts(title: string, pdfText: string, theme: ProductTheme): SynthesizedProductFacts {
  const use_case_tags = inferUseCaseTags(title, pdfText, theme);
  const specs = extractNumericSpecs(pdfText);
  const snippet = pdfText.replace(/\s+/g, " ").trim().slice(0, 900);

  return {
    summary_technical: `${title} — fiche technique GEB (synthèse heuristique, en attente d'enrichissement LLM). ${snippet}`,
    advantages: [],
    compatible_materials: extractKeywordList(pdfText, MATERIAL_KEYWORDS),
    incompatible_materials: [],
    compatible_fluids: extractKeywordList(pdfText, FLUID_KEYWORDS),
    incompatible_fluids: [],
    use_case_tags,
    applications: use_case_tags.length > 0
      ? [{ context: use_case_tags[0]!, description: title, constraints: null }]
      : [],
    ...specs,
    supports: extractKeywordList(pdfText, MATERIAL_KEYWORDS).join(", ") || null,
    certifications: [],
    warnings: [],
  };
}

export function buildRulesBasedFactsForRow(
  row: Pick<
    ScrapedProductRow,
    "title" | "gamme_officielle" | "wp_product_cat_slugs" | "wp_product_cat_names"
  >,
  pdfText: string,
): SynthesizedProductFacts {
  const title = row.title.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const { theme } = resolveProductTheme({
    title,
    content: pdfText,
    gamme_officielle: row.gamme_officielle ?? null,
    wp_product_cat_slugs: row.wp_product_cat_slugs ?? [],
    wp_product_cat_names: row.wp_product_cat_names ?? [],
  });
  return buildRulesBasedFacts(title, pdfText, theme);
}
