/**
 * Scrape GEB WordPress products (PDFs + official product_cat gamme).
 * Usage:
 *   npm run scrape
 *   npm run scrape -- --locale fr          # FR only (merges into existing scrape-results.json)
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  scrapeGebProductPdfs,
  SCRAPE_LOCALES,
  type ScrapeLocale,
} from "../services/geb-scraper.service.js";
import { getScrapeOutputPath, readScrapeOutput } from "../services/product-catalog.service.js";

type CliOptions = {
  locales: ScrapeLocale[];
  slug: string | null;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { locales: [...SCRAPE_LOCALES], slug: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--slug" && argv[i + 1]) {
      opts.slug = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--locale" && argv[i + 1]) {
      const value = argv[i + 1]!;
      if (value === "all") {
        opts.locales = [...SCRAPE_LOCALES];
      } else if ((SCRAPE_LOCALES as readonly string[]).includes(value)) {
        opts.locales = [value as ScrapeLocale];
      } else {
        console.error(`[scrape-products] Unknown locale: ${value} (expected fr|nl|pl|all)`);
        process.exitCode = 1;
      }
      i += 1;
    }
  }
  return opts;
}

async function main(): Promise<void> {
  if (process.exitCode === 1) return;

  const opts = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const scraped = await scrapeGebProductPdfs(console, opts.locales, opts.slug);
  if (opts.slug && scraped.length === 0) {
    console.error(`[scrape-products] No product matched slug: ${opts.slug}`);
    process.exitCode = 1;
    return;
  }

  const localeSet = new Set(opts.locales);
  const partial = opts.locales.length < SCRAPE_LOCALES.length || Boolean(opts.slug);
  const existing = partial ? await readScrapeOutput() : [];
  const scrapedKeys = new Set(scraped.map((row) => `${row.language}:${row.slug}`));
  const kept = partial
    ? existing.filter((row) => !scrapedKeys.has(`${row.language}:${row.slug}`))
    : [];
  const data = [...kept, ...scraped];

  const outputPath = getScrapeOutputPath();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(data, null, 2), "utf-8");

  const withGamme = data.filter((r) => r.gamme_officielle).length;
  console.log("[scrape-products] Done", {
    locales: opts.locales,
    scraped: scraped.length,
    keptFromPrevious: kept.length,
    total: data.length,
    withGamme,
    elapsedMs: Date.now() - startedAt,
    outputPath,
  });
}

main().catch((err: unknown) => {
  console.error("[scrape-products] Failed:", err);
  process.exitCode = 1;
});
