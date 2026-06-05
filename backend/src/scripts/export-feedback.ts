/**
 * Export negative retrieval feedback for catalog review.
 *
 *   npm run export-feedback
 *   npm run export-feedback -- --limit 100 --json
 */

import { exportNegativeFeedback } from "../services/retrieval-feedback.service.js";

function parseArgs(argv: string[]): { limit: number; json: boolean } {
  let limit = 50;
  let json = false;
  const limitIdx = argv.indexOf("--limit");
  if (limitIdx >= 0 && argv[limitIdx + 1]) {
    limit = Math.max(1, Number(argv[limitIdx + 1]) || 50);
  }
  if (argv.includes("--json")) json = true;
  return { limit, json };
}

async function main() {
  const { limit, json } = parseArgs(process.argv.slice(2));
  const rows = await exportNegativeFeedback(limit);

  if (rows.length === 0) {
    console.log("No negative feedback rows (table empty or migration not applied).");
    return;
  }

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`# Negative retrieval feedback (last ${rows.length})\n`);
  for (const row of rows) {
    console.log(`--- ${row.created_at} | path=${row.retrieval_path ?? "?"} | mismatch=${row.retrieval_mismatch}`);
    console.log(`Q: ${row.user_query ?? "(unknown)"}`);
    console.log(`Recommended: ${row.recommended_product ?? "(not parsed)"}`);
    console.log(`Retrieved slugs: ${row.product_slugs.join(", ") || "(none)"}`);
    console.log(`Intent: ${row.intent ?? "-"} | Judge: ${row.judge_score ?? "-"}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
