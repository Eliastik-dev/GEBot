import type { ProductTheme } from "../../../types/index.js";
import type { ProductKnowledgeRow } from "../../../types/product-knowledge.js";
import {
  isPiscineLeakContext,
  isSanitaryFixtureSealingContext,
  isThreadPasteOrPlumbingInternalSlug,
} from "../../../utils/diagnostic-rules.js";
import { hasNegatedLeakInText, isHydraulicEcsDiagnosticContext } from "../../../utils/fluid-context.js";
import { normalizeText } from "./types.js";

function isOffTopicSlugForHydraulicEcsDiagnostics(slug: string, title: string): boolean {
  const combined = normalizeText(`${slug} ${title}`);
  return (
    /gebsomousse|coupe\s*feu|intumescent/.test(combined) ||
    /\b(pool|piscine|liner|skimmer|colmateur)\b/.test(combined) ||
    /\b(echappement|collex|retouche\s+email)\b/.test(combined)
  );
}

export function slugMatchesPenalty(slug: string, penalizeSlugs: string[]): boolean {
  const norm = normalizeText(slug);
  return penalizeSlugs.some((target) => {
    const t = normalizeText(target);
    return norm.includes(t) || t.includes(norm);
  });
}

/** Remove catalogue rows incompatible with query context (sanitary surface vs filetage, piscine vs échappement). */
export function filterProductKnowledgeByQueryContext(
  products: ProductKnowledgeRow[],
  queryText: string,
  sessionTheme?: ProductTheme | null,
): ProductKnowledgeRow[] {
  if (products.length === 0) return products;
  const q = queryText;

  let filtered = products;
  if (isSanitaryFixtureSealingContext(q)) {
    const siliconeTagged = filtered.filter((p) =>
      p.use_case_tags.some((tag) => normalizeText(tag) === "silicone_sanitaire"),
    );
    if (siliconeTagged.length > 0) {
      filtered = siliconeTagged;
    } else {
      filtered = filtered.filter((p) => !isThreadPasteOrPlumbingInternalSlug(p.slug, p.canonical_name));
    }
  }
  if (isPiscineLeakContext(q, sessionTheme)) {
    const next = filtered.filter((p) => {
      const s = normalizeText(p.slug);
      const t = normalizeText(p.canonical_name);
      if (s.includes("echappement") || s.includes("collex") || t.includes("echappement")) return false;
      if (isThreadPasteOrPlumbingInternalSlug(p.slug, p.canonical_name)) return false;
      return true;
    });
    if (next.length > 0) filtered = next;
  }
  if (isHydraulicEcsDiagnosticContext(q)) {
    const next = filtered.filter((p) => {
      if (isOffTopicSlugForHydraulicEcsDiagnostics(p.slug, p.canonical_name)) return false;
      if (hasNegatedLeakInText(q) && isThreadPasteOrPlumbingInternalSlug(p.slug, p.canonical_name)) {
        return false;
      }
      return true;
    });
    if (next.length > 0) filtered = next;
  }
  return filtered;
}

/** Drop session / cross-session disliked slugs; soft global penalties only when alternatives remain. */
export function filterProductKnowledgeByPenalties(
  products: ProductKnowledgeRow[],
  sessionPenalizeSlugs: string[],
  globalPenalizeSlugs: string[] = [],
  crossSessionPenalizeSlugs: string[] = [],
): ProductKnowledgeRow[] {
  if (products.length === 0) return products;

  const hardSlugs = [
    ...new Set([...sessionPenalizeSlugs, ...crossSessionPenalizeSlugs]),
  ];
  if (hardSlugs.length > 0) {
    const withoutHard = products.filter((p) => !slugMatchesPenalty(p.slug, hardSlugs));
    if (withoutHard.length > 0) return withoutHard;
  }

  if (globalPenalizeSlugs.length === 0) return products;
  const withoutGlobal = products.filter((p) => !slugMatchesPenalty(p.slug, globalPenalizeSlugs));
  return withoutGlobal.length > 0 ? withoutGlobal : products;
}
