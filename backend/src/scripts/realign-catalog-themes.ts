/**
 * Realign product_knowledge.theme from scrape-results.json (WP product_cat) without re-running LLM.
 * Usage: npm run realign-catalog-themes [-- --locale fr] [-- --dry-run]
 */
import { readScrapeOutput } from "../services/product-catalog.service.js";
import { supabase } from "../config/supabase.js";
import { resolveProductTheme } from "../services/wp-catalog-theme.service.js";
import { decodeHtmlEntities } from "../utils/text.js";

function parseArgs(argv: string[]): { locale: "fr" | "nl" | "pl" | "all"; dryRun: boolean } {
  let locale: "fr" | "nl" | "pl" | "all" = "all";
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--locale" && argv[i + 1]) {
      const v = argv[i + 1] as "fr" | "nl" | "pl" | "all";
      if (v === "fr" || v === "nl" || v === "pl" || v === "all") locale = v;
    }
    if (argv[i] === "--dry-run") dryRun = true;
  }
  return { locale, dryRun };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const scrapeRows = await readScrapeOutput();
  if (scrapeRows.length === 0) {
    console.error("No scrape-results.json. Run: npm run scrape");
    process.exitCode = 1;
    return;
  }

  let updated = 0;
  let skipped = 0;
  let notInDb = 0;

  for (const row of scrapeRows) {
    if (opts.locale !== "all" && row.language !== opts.locale) continue;

    const title = decodeHtmlEntities(row.title.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    const resolved = resolveProductTheme({
      title,
      content: title,
      gamme_officielle: row.gamme_officielle ?? null,
      wp_product_cat_slugs: row.wp_product_cat_slugs ?? [],
      wp_product_cat_names: row.wp_product_cat_names ?? [],
    });

    const patch = {
      theme: resolved.theme,
      theme_source: resolved.theme_source,
      gamme_officielle: resolved.gamme_officielle,
      wp_product_cat_slugs: resolved.wp_product_cat_slugs,
      updated_at: new Date().toISOString(),
    };

    if (opts.dryRun) {
      console.log(`[dry-run] ${row.slug} [${row.language}] → theme=${resolved.theme} (${resolved.theme_source})`);
      updated += 1;
      continue;
    }

    const { data, error } = await supabase
      .from("product_knowledge")
      .update(patch)
      .eq("slug", row.slug)
      .eq("locale", row.language)
      .select("id");

    if (error) {
      if (/gamme_officielle|theme_source|wp_product_cat/i.test(error.message)) {
        console.error(
          "[realign] Apply migration supabase/migrations/20260603_product_gamme.sql first:",
          error.message,
        );
        process.exitCode = 1;
        return;
      }
      console.warn(`[realign] ${row.slug}:`, error.message);
      skipped += 1;
      continue;
    }

    if (!data || data.length === 0) {
      notInDb += 1;
      continue;
    }
    updated += 1;
  }

  console.log("[realign] Done", {
    dryRun: opts.dryRun,
    updated,
    skipped,
    notInDb,
    scrapeRows: scrapeRows.length,
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
