/**
 * Scrape GEB WordPress products (PDFs + official product_cat gamme).
 * Usage: npm run scrape
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { scrapeGebProductPdfs } from "../services/geb-scraper.service.js";
import { getScrapeOutputPath } from "../services/product-catalog.service.js";

async function main(): Promise<void> {
  const startedAt = Date.now();
  const data = await scrapeGebProductPdfs(console);
  const outputPath = getScrapeOutputPath();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(data, null, 2), "utf-8");

  const withGamme = data.filter((r) => r.gamme_officielle).length;
  console.log("[scrape-products] Done", {
    count: data.length,
    withGamme,
    elapsedMs: Date.now() - startedAt,
    outputPath,
  });
}

main().catch((err: unknown) => {
  console.error("[scrape-products] Failed:", err);
  process.exitCode = 1;
});
