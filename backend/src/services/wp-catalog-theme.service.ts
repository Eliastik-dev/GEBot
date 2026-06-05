import type { ProductTheme } from "../types/index.js";
import { classifyProductTheme } from "./product-theme.service.js";

export type WpProductCategoryTerm = {
  slug: string;
  name: string;
};

export type WpCatalogFields = {
  gamme_officielle: string | null;
  wp_product_cat_slugs: string[];
  wp_product_cat_names: string[];
};

const SKIP_CAT_SLUGS = new Set([
  "particulier",
  "pro",
  "non-classe",
  "non-classé",
  "uncategorized",
]);

/** Map WP product_cat slugs/names → chatbot ProductTheme (priority order). */
const THEME_FROM_CATEGORY_RULES: Array<{ pattern: RegExp; theme: ProductTheme }> = [
  { pattern: /\b(automobile|vehicule|vehicules|echappement|auto-moto|moto)\b/, theme: "automobile" },
  { pattern: /\b(piscine|pool|bassin|spa)\b/, theme: "piscine" },
  {
    pattern: /\b(chauffage|cheminee|cheminees|poele|fioul|combustion|fumisterie|refractaire|insert|radiateur|desembouage)\b/,
    theme: "chauffage",
  },
  { pattern: /\b(batiment|facade|toiture|zinguerie|couverture|terrasse|bardage|etancheite-toiture)\b/, theme: "batiment" },
  { pattern: /\b(entretien|maintenance|nettoyant|degrippant|debouchage|degraissant)\b/, theme: "maintenance" },
  { pattern: /\b(eco-conception|ecologique|biosource|environnement|green)\b/, theme: "eco-conception" },
  {
    pattern: /\b(plomberie|sanitaire|etancheite|etanchéité|raccord|silicone|joint|ptfe|filasse|evacuation)\b/,
    theme: "plomberie",
  },
];

export function normalizeCatalogSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function decodeWpName(name: string): string {
  return name
    .replace(/&#8211;/g, "–")
    .replace(/&#038;/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractClassListCategorySlugs(classList: unknown): string[] {
  if (!Array.isArray(classList)) return [];
  const slugs: string[] = [];
  for (const item of classList) {
    if (typeof item !== "string" || !item.startsWith("product_cat-")) continue;
    const slug = item.slice("product_cat-".length).trim();
    if (slug && !SKIP_CAT_SLUGS.has(normalizeCatalogSlug(slug))) {
      slugs.push(slug);
    }
  }
  return [...new Set(slugs)];
}

/** Parse `wp:term` embed block — product_cat is typically the second group. */
export function extractEmbeddedProductCategories(embedded: unknown): WpProductCategoryTerm[] {
  if (!embedded || typeof embedded !== "object") return [];
  const wpTerm = (embedded as { "wp:term"?: unknown })["wp:term"];
  if (!Array.isArray(wpTerm)) return [];

  const terms: WpProductCategoryTerm[] = [];
  for (const group of wpTerm) {
    if (!Array.isArray(group)) continue;
    for (const term of group) {
      if (!term || typeof term !== "object") continue;
      const t = term as { taxonomy?: string; slug?: string; name?: string };
      if (t.taxonomy !== "product_cat") continue;
      const slug = typeof t.slug === "string" ? t.slug : "";
      if (!slug || SKIP_CAT_SLUGS.has(normalizeCatalogSlug(slug))) continue;
      const name = typeof t.name === "string" ? decodeWpName(t.name) : slug;
      terms.push({ slug, name });
    }
  }
  return dedupeTerms(terms);
}

function dedupeTerms(terms: WpProductCategoryTerm[]): WpProductCategoryTerm[] {
  const seen = new Set<string>();
  const out: WpProductCategoryTerm[] = [];
  for (const t of terms) {
    if (seen.has(t.slug)) continue;
    seen.add(t.slug);
    out.push(t);
  }
  return out;
}

export function buildGammeOfficielle(terms: WpProductCategoryTerm[]): string | null {
  if (terms.length === 0) return null;
  const sorted = [...terms].sort(
    (a, b) => a.slug.split("-").length - b.slug.split("-").length || a.name.localeCompare(b.name, "fr"),
  );
  const path = sorted.map((t) => t.name).filter(Boolean);
  return path.length > 0 ? path.join(" > ") : null;
}

export function mapWpCategoriesToTheme(
  slugs: string[],
  names: string[] = [],
): ProductTheme | null {
  const combined = normalizeCatalogSlug([...slugs, ...names].join(" "));
  for (const { pattern, theme } of THEME_FROM_CATEGORY_RULES) {
    if (pattern.test(combined)) return theme;
  }
  return null;
}

export function parseWpCatalogFromProduct(product: Record<string, unknown>): WpCatalogFields {
  const embeddedTerms = extractEmbeddedProductCategories(product._embedded);
  const classSlugs = extractClassListCategorySlugs(product.class_list);
  const slugSet = new Set<string>([...embeddedTerms.map((t) => t.slug), ...classSlugs]);
  const termBySlug = new Map(embeddedTerms.map((t) => [t.slug, t]));

  for (const slug of classSlugs) {
    if (!termBySlug.has(slug)) {
      termBySlug.set(slug, { slug, name: slug.replace(/-/g, " ") });
    }
  }

  const terms = [...termBySlug.values()].filter((t) => !SKIP_CAT_SLUGS.has(normalizeCatalogSlug(t.slug)));
  return {
    gamme_officielle: buildGammeOfficielle(terms),
    wp_product_cat_slugs: [...slugSet].filter((s) => !SKIP_CAT_SLUGS.has(normalizeCatalogSlug(s))),
    wp_product_cat_names: terms.map((t) => t.name),
  };
}

export type ResolvedProductTheme = {
  theme: ProductTheme;
  theme_source: "wordpress" | "heuristic";
  gamme_officielle: string | null;
  wp_product_cat_slugs: string[];
};

export function resolveProductTheme(input: {
  title: string;
  content: string;
  wp_product_cat_slugs?: string[];
  wp_product_cat_names?: string[];
  gamme_officielle?: string | null;
}): ResolvedProductTheme {
  const slugs = input.wp_product_cat_slugs ?? [];
  const names = input.wp_product_cat_names ?? [];
  const wpTheme = slugs.length > 0 || names.length > 0 ? mapWpCategoriesToTheme(slugs, names) : null;

  if (wpTheme) {
    return {
      theme: wpTheme,
      theme_source: "wordpress",
      gamme_officielle: input.gamme_officielle ?? null,
      wp_product_cat_slugs: slugs,
    };
  }

  return {
    theme: classifyProductTheme(input.title, input.content),
    theme_source: "heuristic",
    gamme_officielle: input.gamme_officielle ?? null,
    wp_product_cat_slugs: slugs,
  };
}
