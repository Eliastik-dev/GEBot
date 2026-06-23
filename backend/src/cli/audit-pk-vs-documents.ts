/**
 * Compare product_knowledge vs documents coverage (FR T_FR technical sheets).
 * Usage: npx tsx src/cli/audit-pk-vs-documents.ts
 */
import { readScrapeOutput } from "../services/product-catalog.service.js";
import { supabase } from "../config/supabase.js";

async function main(): Promise<void> {
  const [{ count: pkTotal }, { count: docChunks }, { data: pkRows, error: pkErr }] = await Promise.all([
    supabase.from("product_knowledge").select("*", { count: "exact", head: true }),
    supabase.from("documents").select("*", { count: "exact", head: true }),
    supabase.from("product_knowledge").select("slug, locale, ft_url, fds_url, summary_technical, canonical_name"),
  ]);
  if (pkErr) throw pkErr;

  const rows = pkRows ?? [];
  const byLocale = Object.fromEntries(
    (["fr", "nl", "pl"] as const).map((locale) => [locale, rows.filter((r) => r.locale === locale).length]),
  );

  const frRows = rows.filter((r) => r.locale === "fr");
  const frWithTfr = frRows.filter((r) => r.ft_url?.includes("T_FR_"));
  const frNoFt = frRows.filter((r) => !r.ft_url);
  const frNoSummary = frRows.filter((r) => !r.summary_technical);

  const scrape = await readScrapeOutput();
  const scrapeFr = scrape.filter((r) => r.language === "fr");
  const scrapeFrFt = scrapeFr.filter((r) => r.ft_url);
  const scrapeFrTfr = scrapeFrFt.filter((r) => r.ft_url!.includes("T_FR_"));

  const pkFrSlugs = new Set(frRows.map((r) => r.slug));
  const scrapeFrSlugs = new Set(scrapeFr.map((r) => r.slug));
  const missingFromPk = scrapeFr.filter((r) => (r.ft_url || r.fds_url) && !pkFrSlugs.has(r.slug));
  const pkNotInCurrentScrape = frRows.filter((r) => !scrapeFrSlugs.has(r.slug));
  const scrapeNotInPk = scrapeFr.filter((r) => !pkFrSlugs.has(r.slug));

  // Sample documents for unique PDF URLs (paginated, cap 20k rows)
  const uniqueUrls = new Set<string>();
  const tfrUrls = new Set<string>();
  const ftUrls = new Set<string>();
  const fdsUrls = new Set<string>();
  let offset = 0;
  const pageSize = 1000;
  while (offset < 20_000) {
    const { data, error } = await supabase
      .from("documents")
      .select("metadata")
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const url = (meta.source_url ?? meta.url) as string | undefined;
      if (!url) continue;
      uniqueUrls.add(url);
      if (url.includes("T_FR_")) tfrUrls.add(url);
      if (url.includes("/pdf/tech/")) ftUrls.add(url);
      if (url.includes("/pdf/sds/") || url.includes("FDS") || url.includes("S_FR_")) fdsUrls.add(url);
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  const pkFrFtUrls = new Set(frRows.map((r) => r.ft_url).filter(Boolean) as string[]);
  const pkFrTfrFtUrls = new Set(
    frRows.map((r) => r.ft_url).filter((u): u is string => typeof u === "string" && u.includes("T_FR_")),
  );
  const tfrInDocsNotInPk = [...tfrUrls].filter((u) => !pkFrFtUrls.has(u));
  const tfrInPkNotInDocs = [...pkFrTfrFtUrls].filter((u) => !tfrUrls.has(u));
  const sharedFtUrls = [...pkFrTfrFtUrls].filter((u) => tfrUrls.has(u));

  console.log(
    JSON.stringify(
      {
        product_knowledge: { total: pkTotal, by_locale: byLocale },
        product_knowledge_fr: {
          count: frRows.length,
          with_T_FR_ft_url: frWithTfr.length,
          without_ft_url: frNoFt.length,
          without_summary: frNoSummary.length,
          no_ft_slugs: frNoFt.map((r) => r.slug),
        },
        scrape_fr: {
          products: scrapeFr.length,
          with_ft_url: scrapeFrFt.length,
          with_T_FR_: scrapeFrTfr.length,
        },
        scraped_but_missing_from_product_knowledge: missingFromPk.map((r) => ({
          slug: r.slug,
          ft_url: r.ft_url,
          fds_url: r.fds_url,
        })),
        product_knowledge_not_in_current_scrape: {
          count: pkNotInCurrentScrape.length,
          sample: pkNotInCurrentScrape.slice(0, 12).map((r) => ({
            slug: r.slug,
            ft_url: r.ft_url,
            title: r.canonical_name,
          })),
        },
        scrape_fr_not_in_product_knowledge: scrapeNotInPk.map((r) => ({
          slug: r.slug,
          ft_url: r.ft_url,
          fds_url: r.fds_url,
        })),
        documents: {
          total_chunks: docChunks,
          unique_pdf_urls: uniqueUrls.size,
          unique_T_FR_urls: tfrUrls.size,
          unique_ft_urls: ftUrls.size,
          unique_fds_urls: fdsUrls.size,
        },
        T_FR_coverage: {
          unique_T_FR_in_documents: tfrUrls.size,
          unique_T_FR_in_product_knowledge_ft_url: pkFrTfrFtUrls.size,
          T_FR_in_documents_not_in_any_pk_ft_url: tfrInDocsNotInPk.length,
          T_FR_in_pk_ft_url_not_in_documents_index: tfrInPkNotInDocs.length,
          shared_T_FR_urls: sharedFtUrls.length,
          sample_T_FR_only_in_documents: tfrInDocsNotInPk.slice(0, 10),
          sample_T_FR_only_in_pk: tfrInPkNotInDocs.slice(0, 10),
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  console.error("[audit-pk-vs-documents] failed:", err);
  process.exitCode = 1;
});
