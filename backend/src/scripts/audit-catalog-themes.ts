/**
 * Audit product_knowledge themes vs WP gamme and heuristics.
 * Usage: npm run audit-catalog-themes [-- --locale fr]
 */
import { readScrapeOutput } from "../services/product-catalog.service.js";
import { supabase } from "../config/supabase.js";
import type { ProductKnowledgeRow } from "../types/product-knowledge.js";
import { resolveProductTheme } from "../services/wp-catalog-theme.service.js";
import { decodeHtmlEntities } from "../utils/text.js";

function parseArgs(argv: string[]): { locale: "fr" | "nl" | "pl" | "all" } {
  let locale: "fr" | "nl" | "pl" | "all" = "fr";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--locale" && argv[i + 1]) {
      const v = argv[i + 1] as "fr" | "nl" | "pl" | "all";
      if (v === "fr" || v === "nl" || v === "pl" || v === "all") locale = v;
    }
  }
  return { locale };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  let query = supabase.from("product_knowledge").select("*");
  if (opts.locale !== "all") query = query.eq("locale", opts.locale);

  const { data, error } = await query;
  if (error) {
    console.error("[audit] query failed:", error.message);
    process.exitCode = 1;
    return;
  }

  const rows = (data as ProductKnowledgeRow[]) ?? [];
  const scrapeRows = await readScrapeOutput();
  const scrapeByKey = new Map(
    scrapeRows.map((r) => [`${r.slug}|${r.language}`, r]),
  );

  const byTheme: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const mismatches: Array<{
    slug: string;
    locale: string;
    stored: string;
    expected: string;
    source: string;
    gamme: string | null;
  }> = [];
  let missingGamme = 0;

  for (const row of rows) {
    const theme = String(row.theme ?? "null");
    byTheme[theme] = (byTheme[theme] ?? 0) + 1;
    const src = String(row.theme_source ?? "unknown");
    bySource[src] = (bySource[src] ?? 0) + 1;
    if (!row.gamme_officielle) missingGamme += 1;

    const scrape = scrapeByKey.get(`${row.slug}|${row.locale}`);
    const title = decodeHtmlEntities(row.canonical_name);
    const expected = resolveProductTheme({
      title,
      content: row.summary_technical ?? "",
      gamme_officielle: scrape?.gamme_officielle ?? row.gamme_officielle ?? null,
      wp_product_cat_slugs: scrape?.wp_product_cat_slugs ?? row.wp_product_cat_slugs ?? [],
      wp_product_cat_names: scrape?.wp_product_cat_names ?? [],
    });

    if (row.theme !== expected.theme) {
      mismatches.push({
        slug: row.slug,
        locale: String(row.locale),
        stored: String(row.theme),
        expected: expected.theme,
        source: expected.theme_source,
        gamme: scrape?.gamme_officielle ?? row.gamme_officielle ?? null,
      });
    }
  }

  console.log("\n=== Audit product_knowledge ===");
  console.log(`Rows: ${rows.length} (locale=${opts.locale})`);
  console.log(`Missing gamme_officielle: ${missingGamme}`);
  console.log("\nBy theme:");
  for (const [t, n] of Object.entries(byTheme).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${n}`);
  }
  console.log("\nBy theme_source:");
  for (const [s, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${n}`);
  }

  console.log(`\nTheme mismatches (stored vs WP/heuristic): ${mismatches.length}`);
  for (const m of mismatches.slice(0, 40)) {
    console.log(
      `  ${m.slug} [${m.locale}] stored=${m.stored} → expected=${m.expected} (${m.source}) | ${m.gamme ?? "no gamme"}`,
    );
  }
  if (mismatches.length > 40) {
    console.log(`  ... and ${mismatches.length - 40} more`);
  }

  if (scrapeRows.length === 0) {
    console.warn("\n[audit] No scrape-results.json — run `npm run scrape` for full WP gamme comparison.");
  } else {
    const scrapeWithGamme = scrapeRows.filter((r) => r.gamme_officielle).length;
    console.log(`\nScrape file: ${scrapeRows.length} rows, ${scrapeWithGamme} with gamme_officielle`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
