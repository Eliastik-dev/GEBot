/**
 * Compare WordPress technical PDFs vs scrape / documents / product_knowledge.
 * Usage: npx tsx src/cli/audit-wp-ft-coverage.ts
 */
import axios from "axios";
import { readScrapeOutput } from "../services/product-catalog.service.js";
import { supabase } from "../config/supabase.js";

type WpMedia = {
  id: number;
  slug?: string;
  source_url?: string;
  mime_type?: string;
  title?: { rendered?: string };
};

const WP_MEDIA_ENDPOINT = "https://www.geb.fr/wp-json/wp/v2/media?media_type=application";

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeUrl(url: string): string {
  try {
    return encodeURI(url.split("#")[0]!.split("?")[0]!.trim());
  } catch {
    return url.trim();
  }
}

function isTechnicalSheetUrl(url: string, title = "", slug = ""): boolean {
  const upper = `${url} ${title} ${slug}`.toUpperCase();
  if (!/\.PDF$/i.test(url.split("?")[0] ?? "")) return false;
  if (upper.includes("/BLOG/")) return false;
  if (upper.includes("CATALOGUE") || upper.includes("CATA-")) return false;
  if (/\/PDF\/TECH\/T_(FR|NL|PL)_/i.test(url)) return true;
  if (/\/PDF\/TECH\/T_/i.test(url)) return true;
  if (/\bT_(FR|NL|PL)_/i.test(url)) return true;
  if (/\bFT_/i.test(url) || /\bTDS\b/.test(upper)) return true;
  if (/FICHE\s*TECHNIQUE/i.test(upper) || /TECHNICAL\s*(DATA\s*)?SHEET/i.test(upper)) return true;
  return false;
}

function localeFromUrl(url: string): "fr" | "nl" | "pl" | "other" {
  if (/_NL_/i.test(url)) return "nl";
  if (/_PL_/i.test(url)) return "pl";
  if (/_FR_/i.test(url)) return "fr";
  return "other";
}

async function fetchAllMedia(): Promise<WpMedia[]> {
  const perPage = 100;
  let page = 1;
  const out: WpMedia[] = [];
  while (true) {
    const url = `${WP_MEDIA_ENDPOINT}&per_page=${perPage}&page=${page}`;
    const { data } = await axios.get<WpMedia[]>(url, {
      timeout: 30_000,
      headers: { Accept: "application/json" },
    });
    const items = Array.isArray(data) ? data : [];
    if (items.length === 0) break;
    out.push(...items);
    if (items.length < perPage) break;
    page += 1;
  }
  return out;
}

async function collectDocumentUrls(): Promise<Set<string>> {
  const urls = new Set<string>();
  let offset = 0;
  while (offset < 30_000) {
    const { data, error } = await supabase.from("documents").select("metadata").range(offset, offset + 999);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const u = meta.source_url ?? meta.url;
      if (typeof u === "string" && u.length > 0) urls.add(normalizeUrl(u));
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  return urls;
}

async function main(): Promise<void> {
  console.log("[audit] Fetching WordPress media...");
  const media = await fetchAllMedia();
  const wpFtPdfs = media
    .map((item) => {
      const sourceUrl = normalizeUrl(item.source_url?.trim() ?? "");
      const title = stripHtml(item.title?.rendered ?? "");
      const slug = item.slug ?? "";
      if (!sourceUrl || item.mime_type !== "application/pdf" && !sourceUrl.toLowerCase().endsWith(".pdf")) {
        return null;
      }
      if (!isTechnicalSheetUrl(sourceUrl, title, slug)) return null;
      return { sourceUrl, title, slug, locale: localeFromUrl(sourceUrl) };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const wpByLocale = Object.fromEntries(
    (["fr", "nl", "pl", "other"] as const).map((loc) => [
      loc,
      wpFtPdfs.filter((p) => p.locale === loc).length,
    ]),
  );
  const wpUrls = new Set(wpFtPdfs.map((p) => p.sourceUrl));

  const scrape = await readScrapeOutput();
  const scrapeFtUrls = new Set(
    scrape.map((r) => r.ft_url).filter((u): u is string => typeof u === "string").map(normalizeUrl),
  );

  const { data: pkRows } = await supabase.from("product_knowledge").select("locale, ft_url, slug, canonical_name");
  const pkFtUrls = new Set(
    (pkRows ?? []).map((r) => r.ft_url).filter((u): u is string => typeof u === "string").map(normalizeUrl),
  );

  const docUrls = await collectDocumentUrls();

  const missingInScrape = wpFtPdfs.filter((p) => !scrapeFtUrls.has(p.sourceUrl));
  const missingInDocuments = wpFtPdfs.filter((p) => !docUrls.has(p.sourceUrl));
  const missingInPk = wpFtPdfs.filter((p) => !pkFtUrls.has(p.sourceUrl));

  const scrapeNotInWp = [...scrapeFtUrls].filter((u) => u.includes("/pdf/tech/T_") && !wpUrls.has(u));

  const missingFrInScrape = missingInScrape.filter((p) => p.locale === "fr");
  const missingFrInDocuments = missingInDocuments.filter((p) => p.locale === "fr");

  console.log(
    JSON.stringify(
      {
        wordpress: {
          media_total: media.length,
          technical_ft_pdfs: wpFtPdfs.length,
          by_locale: wpByLocale,
        },
        scrape: {
          rows: scrape.length,
          with_ft_url: scrapeFtUrls.size,
          fr_with_ft_url: scrape.filter((r) => r.language === "fr" && r.ft_url).length,
          fr_without_ft_url: scrape
            .filter((r) => r.language === "fr" && !r.ft_url)
            .map((r) => ({ slug: r.slug, title: r.title })),
        },
        documents: {
          unique_pdf_urls: docUrls.size,
          wp_ft_missing: missingInDocuments.length,
          wp_fr_ft_missing: missingFrInDocuments.length,
        },
        product_knowledge: {
          rows: pkRows?.length ?? 0,
          with_ft_url: pkFtUrls.size,
          wp_ft_missing: missingInPk.length,
        },
        coverage: {
          scrape_covers_wp_ft_pct: `${Math.round((1 - missingInScrape.length / wpFtPdfs.length) * 100)}%`,
          documents_covers_wp_ft_pct: `${Math.round((1 - missingInDocuments.length / wpFtPdfs.length) * 100)}%`,
          pk_covers_wp_ft_pct: `${Math.round((1 - missingInPk.length / wpFtPdfs.length) * 100)}%`,
        },
        gaps: {
          wp_ft_not_in_scrape: {
            count: missingInScrape.length,
            fr_count: missingFrInScrape.length,
            sample: missingInScrape.slice(0, 20).map((p) => ({
              url: p.sourceUrl,
              title: p.title,
              locale: p.locale,
            })),
          },
          wp_fr_ft_not_in_documents: {
            count: missingFrInDocuments.length,
            all: missingFrInDocuments.map((p) => ({ url: p.sourceUrl, title: p.title })),
          },
          scrape_ft_not_found_in_wp_media: {
            count: scrapeNotInWp.length,
            urls: scrapeNotInWp.slice(0, 15),
          },
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("[audit-wp-ft-coverage] failed:", err);
  process.exitCode = 1;
});
