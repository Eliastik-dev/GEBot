/**
 * Phase 4: Suggest or apply product_knowledge tag fixes from negative user feedback.
 *
 *   npm run apply-catalog-feedback
 *   npm run apply-catalog-feedback -- --apply
 *   npm run apply-catalog-feedback -- --json
 */

import {
  applyCatalogTagSuggestions,
  buildCatalogTagSuggestions,
} from "../services/catalog-feedback.service.js";

function parseArgs(argv: string[]): { apply: boolean; json: boolean; limit: number } {
  let limit = 30;
  const limitIdx = argv.indexOf("--limit");
  if (limitIdx >= 0 && argv[limitIdx + 1]) {
    limit = Math.max(1, Number(argv[limitIdx + 1]) || 30);
  }
  return {
    apply: argv.includes("--apply"),
    json: argv.includes("--json"),
    limit,
  };
}

async function main() {
  const { apply, json, limit } = parseArgs(process.argv.slice(2));
  const suggestions = await buildCatalogTagSuggestions(limit);

  if (suggestions.length === 0) {
    console.log("No tag suggestions (no negative feedback or migration not applied).");
    return;
  }

  if (json) {
    console.log(JSON.stringify(suggestions, null, 2));
    if (!apply) return;
  } else {
    console.log(`# Catalog tag suggestions (${suggestions.length})\n`);
    for (const s of suggestions) {
      console.log(`## ${s.canonical_name} (${s.slug}) [${s.locale}] x${s.feedback_count}`);
      console.log(`Current: ${s.current_tags.join(", ") || "(none)"}`);
      console.log(`Add:     ${s.suggested_tags.join(", ")}`);
      console.log(`Reason:  ${s.reason}\n`);
    }
  }

  if (!apply) {
    console.log("Dry run. Pass --apply to merge suggested tags into product_knowledge.");
    return;
  }

  const result = await applyCatalogTagSuggestions(suggestions);
  console.log(`Applied: ${result.updated} updated, ${result.skipped} skipped`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
