import { supabase } from "../../../config/supabase.js";
import type { ProductTheme } from "../../../types/index.js";
import type { ProductKnowledgeRow, UpsertProductKnowledgeInput } from "../../../types/product-knowledge.js";
import { feedbackSlugScoreDelta } from "../../../services/feedback-retrieval.service.js";
import { inferCatalogProductAudience } from "../../../services/product-theme.service.js";
import {
  computeExplicitProductMatchScore,
  EXPLICIT_PRODUCT_MATCH_MIN,
  extractProductSearchTerms,
  sanitizeIlikeSearchTerm,
  isExplicitProductLookupQuery,
  isExplicitProductTargeted,
  isFactualProductQuestion,
  matchesCatalogCodeTerm,
  EXPLICIT_PRODUCT_NAME_PRIORITY_MIN,
} from "../../../utils/product-mention.js";
import { isSanitaryFixtureSealingContext } from "../../../utils/diagnostic-rules.js";
import {
  combineRetrievalText,
  EXPLICIT_CATALOG_PRODUCT_PATTERNS,
  explicitMatchTexts,
  normalizeText,
  type ProductKnowledgeSearchInput,
} from "./types.js";
import { extractNameSearchTerms, pickSanitaryAwareProducts, scoreProduct } from "./scoring.js";
import { slugMatchesPenalty } from "./filters.js";

export async function fetchByNameTerms(locale: "fr" | "nl" | "pl", terms: string[]): Promise<ProductKnowledgeRow[]> {
  const safeTerms = [...new Set(terms.map((term) => sanitizeIlikeSearchTerm(term)).filter(Boolean))] as string[];
  if (safeTerms.length === 0) return [];
  const seen = new Map<string, ProductKnowledgeRow>();

  for (const term of safeTerms) {
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

export async function fetchByExplicitProductMention(
  locale: "fr" | "nl" | "pl",
  texts: string[],
): Promise<ProductKnowledgeRow[]> {
  const terms = extractProductSearchTerms(texts);
  return fetchByNameTerms(locale, terms);
}

export async function fetchExplicitCatalogProducts(
  locale: "fr" | "nl" | "pl",
  combinedText: string,
): Promise<ProductKnowledgeRow[]> {
  const rows: ProductKnowledgeRow[] = [];
  const normalizedText = normalizeText(combinedText);
  for (const { pattern, slug } of EXPLICIT_CATALOG_PRODUCT_PATTERNS) {
    if (!pattern.test(normalizedText)) continue;
    const row = await getProductKnowledgeBySlug(slug, locale);
    if (row) rows.push(row);
  }
  return rows;
}

export function needsCrossThemeCatalogSearch(theme: ProductTheme | null | undefined, combinedText: string): boolean {
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
  options?: { skipThemeHardFilter?: boolean },
): Promise<ProductKnowledgeRow[]> {
  let query = supabase.from("product_knowledge").select("*").eq("locale", locale);

  if (theme && !options?.skipThemeHardFilter) {
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

/** Ensure 👍 slugs (session or cross-session) appear in catalogue results — symmetric to hard penalize. */
export async function injectFeedbackBoostProducts(
  products: ProductKnowledgeRow[],
  slugHints: string[],
  locale: "fr" | "nl" | "pl",
): Promise<ProductKnowledgeRow[]> {
  if (slugHints.length === 0) return products;

  const merged = new Map<string, ProductKnowledgeRow>(products.map((p) => [p.slug, p]));
  const missingHints = slugHints.filter(
    (hint) => ![...merged.keys()].some((slug) => slugMatchesPenalty(slug, [hint])),
  );
  if (missingHints.length === 0) return products;

  for (const hint of missingHints) {
    const exact = await getProductKnowledgeBySlug(hint, locale).catch(() => null);
    if (exact) {
      merged.set(exact.slug, exact);
      continue;
    }

    const ilikePattern = hint.replace(/-/g, "%").slice(0, 48);
    const { data, error } = await supabase
      .from("product_knowledge")
      .select("*")
      .eq("locale", locale)
      .ilike("slug", `%${ilikePattern}%`)
      .limit(8);

    if (error) continue;
    for (const row of (data as ProductKnowledgeRow[]) ?? []) {
      if (slugMatchesPenalty(row.slug, [hint])) {
        merged.set(row.slug, row);
        break;
      }
    }
  }

  const boostedFirst: ProductKnowledgeRow[] = [];
  for (const hint of slugHints) {
    const match = [...merged.values()].find((p) => slugMatchesPenalty(p.slug, [hint]));
    if (match && !boostedFirst.some((p) => p.slug === match.slug)) {
      boostedFirst.push(match);
    }
  }
  const rest = [...merged.values()].filter((p) => !boostedFirst.some((b) => b.slug === p.slug));
  return [...boostedFirst, ...rest];
}

export async function searchProductKnowledge(input: ProductKnowledgeSearchInput): Promise<ProductKnowledgeRow[]> {
  const tags = input.tags ?? [];
  const limit = input.limit ?? 3;
  const queryText = combineRetrievalText(input);
  const explicitTexts = explicitMatchTexts(input);
  const skipThemeHardFilter = isExplicitProductTargeted(explicitTexts);

  const byTags = await fetchCandidates(input.locale, input.theme, tags, { skipThemeHardFilter });
  const byTagsWithoutTheme =
    input.theme != null && !skipThemeHardFilter ? await fetchCandidates(input.locale, null, tags) : [];

  const nameTerms = extractNameSearchTerms(queryText, tags, input.audience, input.theme);
  const byName = await fetchByNameTerms(input.locale, nameTerms);
  const directProductLookup = explicitTexts.some(isExplicitProductLookupQuery);
  const byExplicitMention = directProductLookup
    ? await fetchByExplicitProductMention(input.locale, explicitTexts)
    : [];
  const byExplicit = await fetchExplicitCatalogProducts(input.locale, queryText);

  const merged = new Map<string, ProductKnowledgeRow>();
  for (const row of [...byExplicit, ...byExplicitMention, ...byTags, ...byTagsWithoutTheme, ...byName]) {
    merged.set(row.slug, row);
  }

  const explicitSlugs = new Set(byExplicit.map((p) => p.slug));

  let candidates = [...merged.values()];

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
    candidates = (data as ProductKnowledgeRow[]) ?? [];
  }

  if (candidates.length === 0) return [];

  const sanitaryContext = isSanitaryFixtureSealingContext(queryText);
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
        item.explicitScore >= EXPLICIT_PRODUCT_MATCH_MIN ||
        (sanitaryContext &&
          item.product.use_case_tags.some((tag) => normalizeText(tag) === "silicone_sanitaire")),
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

  if (isFactualProductQuestion(queryText)) {
    const factualMatches = scored.filter((item) => item.explicitScore >= EXPLICIT_PRODUCT_MATCH_MIN);
    if (factualMatches.length > 0) {
      return factualMatches.slice(0, limit).map((item) => item.product);
    }
  }

  const strongExplicit = scored.filter((item) => item.explicitScore >= EXPLICIT_PRODUCT_NAME_PRIORITY_MIN);
  if (strongExplicit.length > 0) {
    const explicitPicked = pickSanitaryAwareProducts(strongExplicit, queryText, limit);
    const explicitHasSilicone =
      explicitPicked.length > 0 &&
      explicitPicked.some((product) =>
        product.use_case_tags.some((tag) => normalizeText(tag) === "silicone_sanitaire"),
      );
    if (
      explicitHasSilicone ||
      !sanitaryContext ||
      !tags.some((tag) => normalizeText(tag) === "silicone_sanitaire")
    ) {
      return explicitPicked;
    }
  }

  const picked = pickSanitaryAwareProducts(scored, queryText, limit);
  const pickedHasSilicone =
    picked.length > 0 &&
    picked.some((product) =>
      product.use_case_tags.some((tag) => normalizeText(tag) === "silicone_sanitaire"),
    );
  if (
    pickedHasSilicone ||
    !sanitaryContext ||
    !tags.some((tag) => normalizeText(tag) === "silicone_sanitaire")
  ) {
    return picked;
  }

  const siliconeCatalog = candidates.filter((product) =>
    product.use_case_tags.some((tag) => normalizeText(tag) === "silicone_sanitaire"),
  );
  if (siliconeCatalog.length === 0) return picked;

  const siliconeScored = siliconeCatalog
    .map((product) => ({
      product,
      score: scoreProduct(
        product,
        tags,
        input.material,
        input.fluid,
        queryText,
        input.audience,
        input.theme,
        explicitTexts,
      ),
      explicitScore: computeExplicitProductMatchScore(product, explicitTexts),
    }))
    .sort((a, b) => b.score - a.score);

  return siliconeScored.slice(0, limit).map((item) => item.product);
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
