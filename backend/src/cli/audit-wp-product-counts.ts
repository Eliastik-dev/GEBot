/**
 * Compare WordPress product counts vs scrape-results vs product_knowledge.
 */
import axios from "axios";
import { readScrapeOutput } from "../services/product-catalog.service.js";
import { supabase } from "../config/supabase.js";

const ENDPOINTS = {
  fr: "https://www.geb.fr/wp-json/wp/v2/product",
  nl: "https://www.geb.fr/nl/wp-json/wp/v2/product",
  pl: "https://www.geb.fr/pl/wp-json/wp/v2/product",
} as const;

async function countWpLocale(locale: keyof typeof ENDPOINTS): Promise<{
  locale: string;
  total: number;
  totalPages: number;
  xWpTotal: string | undefined;
}> {
  let page = 1;
  let total = 0;
  let totalPages = 0;
  let xWpTotal: string | undefined;
  while (true) {
    const { data, headers } = await axios.get<unknown[]>(ENDPOINTS[locale], {
      params: { per_page: 100, page },
      timeout: 45_000,
    });
    const items = Array.isArray(data) ? data : [];
    if (page === 1) {
      xWpTotal = headers["x-wp-total"] as string | undefined;
      totalPages = Number(headers["x-wp-totalpages"] ?? 1);
    }
    if (items.length === 0) break;
    total += items.length;
    if (items.length < 100) break;
    page += 1;
  }
  return { locale, total, totalPages, xWpTotal };
}

async function main(): Promise<void> {
  const wp = await Promise.all(
    (Object.keys(ENDPOINTS) as Array<keyof typeof ENDPOINTS>).map((locale) => countWpLocale(locale)),
  );

  const scrape = await readScrapeOutput();
  const scrapeByLocale = Object.fromEntries(
    (["fr", "nl", "pl"] as const).map((loc) => [loc, scrape.filter((r) => r.language === loc).length]),
  );

  const { data: pkRows } = await supabase.from("product_knowledge").select("slug, locale");
  const pkByLocale = Object.fromEntries(
    (["fr", "nl", "pl"] as const).map((loc) => [loc, (pkRows ?? []).filter((r) => r.locale === loc).length]),
  );

  const scrapeSlugs = new Set(scrape.map((r) => `${r.language}:${r.slug}`));
  const pkNotInScrape = (pkRows ?? []).filter((r) => !scrapeSlugs.has(`${r.locale}:${r.slug}`));

  console.log(
    JSON.stringify(
      {
        wordpress_api: wp,
        wordpress_total: wp.reduce((s, w) => s + w.total, 0),
        scrape_results: { total: scrape.length, by_locale: scrapeByLocale },
        product_knowledge: { total: pkRows?.length ?? 0, by_locale: pkByLocale },
        pk_rows_not_in_current_scrape: {
          count: pkNotInScrape.length,
          sample: pkNotInScrape.slice(0, 15).map((r) => ({ locale: r.locale, slug: r.slug })),
        },
        explanation: {
          scrape_scope: "Custom post type product via WP REST API — one row per fiche produit publiée",
          pk_extra_rows: "Lignes synthétisées lors d'un ancien run (catalogue plus large ou slugs différents)",
          documents_orphans: "PDF indexés hors produits WP actuels (legacy / accessoires)",
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
