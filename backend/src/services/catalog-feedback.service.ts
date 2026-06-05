/**
 * Phase 4: Turn negative retrieval feedback into catalog tag suggestions.
 */

import { supabase } from "../config/supabase.js";
import { USE_CASE_TAG_VOCABULARY } from "./product-theme.service.js";
import type { ProductKnowledgeRow } from "../types/product-knowledge.js";

export type CatalogTagSuggestion = {
  slug: string;
  locale: string;
  canonical_name: string;
  current_tags: string[];
  suggested_tags: string[];
  reason: string;
  feedback_count: number;
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter(Boolean);
}

export async function buildCatalogTagSuggestions(limit = 30): Promise<CatalogTagSuggestion[]> {
  const { data, error } = await supabase
    .from("retrieval_feedback_events")
    .select("product_slugs, use_case_tags, recommended_product, retrieval_mismatch, locale")
    .eq("feedback", -1)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (/retrieval_feedback_events/i.test(error.message)) return [];
    throw error;
  }

  const allowed = new Set<string>(USE_CASE_TAG_VOCABULARY);
  const bySlug = new Map<string, CatalogTagSuggestion>();

  for (const row of data ?? []) {
    const slugs = asStringArray((row as { product_slugs?: unknown }).product_slugs);
    const routeTags = asStringArray((row as { use_case_tags?: unknown }).use_case_tags).filter((t) =>
      allowed.has(t),
    );
    const locale = String((row as { locale?: string }).locale ?? "fr");
    const mismatch = Boolean((row as { retrieval_mismatch?: boolean }).retrieval_mismatch);

    if (routeTags.length === 0) continue;

    for (const slug of slugs) {
      const existing = bySlug.get(`${locale}:${slug}`);
      if (existing) {
        existing.feedback_count += 1;
        for (const tag of routeTags) {
          if (!existing.suggested_tags.includes(tag)) existing.suggested_tags.push(tag);
        }
        continue;
      }

      bySlug.set(`${locale}:${slug}`, {
        slug,
        locale,
        canonical_name: slug,
        current_tags: [],
        suggested_tags: [...routeTags],
        reason: mismatch
          ? "Negative feedback: retrieved products missing route tags for this query"
          : "Negative feedback: enrich tags from resolved route",
        feedback_count: 1,
      });
    }
  }

  if (bySlug.size === 0) return [];

  const suggestions = [...bySlug.values()];
  for (const suggestion of suggestions) {
    const { data: product } = await supabase
      .from("product_knowledge")
      .select("canonical_name, use_case_tags")
      .eq("slug", suggestion.slug)
      .eq("locale", suggestion.locale)
      .maybeSingle();

    if (product) {
      const row = product as Pick<ProductKnowledgeRow, "canonical_name" | "use_case_tags">;
      suggestion.canonical_name = row.canonical_name;
      suggestion.current_tags = row.use_case_tags ?? [];
      suggestion.suggested_tags = suggestion.suggested_tags.filter(
        (tag) => !suggestion.current_tags.includes(tag),
      );
    }
  }

  return suggestions.filter((s) => s.suggested_tags.length > 0);
}

export async function applyCatalogTagSuggestions(
  suggestions: CatalogTagSuggestion[],
): Promise<{ updated: number; skipped: number }> {
  let updated = 0;
  let skipped = 0;

  for (const suggestion of suggestions) {
    if (suggestion.suggested_tags.length === 0) {
      skipped += 1;
      continue;
    }

    const merged = [...new Set([...suggestion.current_tags, ...suggestion.suggested_tags])];
    const { error } = await supabase
      .from("product_knowledge")
      .update({
        use_case_tags: merged,
        updated_at: new Date().toISOString(),
      })
      .eq("slug", suggestion.slug)
      .eq("locale", suggestion.locale);

    if (error) {
      console.warn("[catalog-feedback] update failed", suggestion.slug, error.message);
      skipped += 1;
      continue;
    }
    updated += 1;
  }

  return { updated, skipped };
}
