/**
 * Phase 3: Run golden routing cases against product_knowledge (no LLM).
 *
 *   npm run retrieval-regression
 *   npm run retrieval-regression -- --case automobile-exhaust-seal
 */

import { CITATION_REGRESSION_CASES, RETRIEVAL_REGRESSION_CASES, type RetrievalRegressionCase } from "../config/retrieval-regression-cases.js";
import type { ExtractedMetadata } from "../intent-extractor.js";
import { countProductKnowledge, lookupCatalogProductsByCitation } from "../services/product-knowledge.service.js";
import { routeProductKnowledge } from "../services/product-router.service.js";

function parseArgs(argv: string[]): { caseId?: string; citationOnly?: boolean } {
  const caseIdx = argv.indexOf("--case");
  const caseId = caseIdx >= 0 ? argv[caseIdx + 1] : undefined;
  const citationOnly = argv.includes("--citation");
  return { ...(caseId ? { caseId } : {}), ...(citationOnly ? { citationOnly: true } : {}) };
}

function defaultMeta(testCase: RetrievalRegressionCase): ExtractedMetadata {
  return {
    intent: (testCase.intent ?? "product_info") as ExtractedMetadata["intent"],
    material: null,
    fluid: testCase.fluid ?? null,
    confidence: 1,
    pressure: null,
    diameter: null,
    accessibility: "unknown",
    damage_type: null,
    safety_keywords: [],
    missing_params: [],
    needs_clarification: false,
    synonyms: [],
    method: "fallback",
  };
}

async function runCase(testCase: RetrievalRegressionCase): Promise<{ ok: boolean; slugs: string[]; reason?: string }> {
  const meta = defaultMeta(testCase);
  const { products, tags } = await routeProductKnowledge({
    locale: testCase.locale,
    query: testCase.query,
    searchQuery: testCase.query,
    userQuery: testCase.query,
    theme: testCase.theme,
    metadata: meta,
    limit: 3,
    audience: testCase.audience ?? null,
  });

  const slugs = products.map((p) => p.slug);

  if (testCase.expectNoProducts) {
    if (slugs.length > 0) {
      return { ok: false, slugs, reason: "expected no products (out-of-catalog case)" };
    }
    return { ok: true, slugs, reason: "no routing (out of catalog)" };
  }

  if (slugs.length === 0) {
    return { ok: false, slugs, reason: "no products returned" };
  }

  const hasExpected = testCase.expectedSlugs.some((expected) =>
    slugs.some((slug) => slug.includes(expected) || expected.includes(slug)),
  );
  if (!hasExpected) {
    return {
      ok: false,
      slugs,
      reason: `expected one of [${testCase.expectedSlugs.join(", ")}] in top-${slugs.length}`,
    };
  }

  const forbidden = testCase.forbiddenSlugs ?? [];
  const hitForbidden = forbidden.find((bad) => slugs.some((slug) => slug.includes(bad)));
  if (hitForbidden) {
    return { ok: false, slugs, reason: `forbidden slug matched: ${hitForbidden}` };
  }

  return { ok: true, slugs, reason: `tags=${tags.join(",")}` };
}

async function runCitationCase(
  testCase: (typeof CITATION_REGRESSION_CASES)[number],
): Promise<{ ok: boolean; slugs: string[]; reason?: string }> {
  const products = await lookupCatalogProductsByCitation({
    locale: testCase.locale,
    userQuery: testCase.query,
    audience: testCase.audience ?? null,
    limit: 2,
  });
  const slugs = products.map((p) => p.slug);
  if (slugs.length === 0) {
    return { ok: false, slugs, reason: "no cited products returned" };
  }
  const hasExpected = testCase.expectedSlugs.some((expected) =>
    slugs.some((slug) => slug.includes(expected) || expected.includes(slug)),
  );
  if (!hasExpected) {
    return {
      ok: false,
      slugs,
      reason: `expected one of [${testCase.expectedSlugs.join(", ")}] in top-${slugs.length}`,
    };
  }
  const forbidden = testCase.forbiddenSlugs ?? [];
  const hitForbidden = forbidden.find((bad) => slugs.some((slug) => slug.includes(bad)));
  if (hitForbidden) {
    return { ok: false, slugs, reason: `forbidden slug matched: ${hitForbidden}` };
  }
  return { ok: true, slugs, reason: "citation lookup" };
}

async function main() {
  const { caseId, citationOnly } = parseArgs(process.argv.slice(2));
  const routeCases = citationOnly
    ? []
    : caseId
      ? RETRIEVAL_REGRESSION_CASES.filter((c) => c.id === caseId)
      : RETRIEVAL_REGRESSION_CASES;
  const citationCases = citationOnly
    ? caseId
      ? CITATION_REGRESSION_CASES.filter((c) => c.id === caseId)
      : CITATION_REGRESSION_CASES
    : caseId
      ? CITATION_REGRESSION_CASES.filter((c) => c.id === caseId)
      : CITATION_REGRESSION_CASES;

  if (routeCases.length === 0 && citationCases.length === 0) {
    console.error(`Unknown case id: ${caseId}`);
    process.exit(1);
  }

  const catalogCount = await countProductKnowledge("fr").catch(() => 0);
  if (catalogCount === 0) {
    console.error("product_knowledge table is empty — run synthesize-products first.");
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  for (const testCase of routeCases) {
    const result = await runCase(testCase);
    const status = result.ok ? "PASS" : "FAIL";
    console.log(`[${status}] ${testCase.id}`);
    console.log(`  query: ${testCase.query}`);
    console.log(`  slugs: ${result.slugs.join(", ") || "(none)"}`);
    if (result.reason) console.log(`  note:  ${result.reason}`);
    if (result.ok) passed += 1;
    else failed += 1;
  }

  for (const testCase of citationCases) {
    const result = await runCitationCase(testCase);
    const status = result.ok ? "PASS" : "FAIL";
    console.log(`[${status}] ${testCase.id} (citation)`);
    console.log(`  query: ${testCase.query}`);
    console.log(`  slugs: ${result.slugs.join(", ") || "(none)"}`);
    if (result.reason) console.log(`  note:  ${result.reason}`);
    if (result.ok) passed += 1;
    else failed += 1;
  }

  const total = routeCases.length + citationCases.length;
  console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
