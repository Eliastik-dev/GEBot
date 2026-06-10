/**
 * Full FT coverage audit: documents vs scrape vs product_knowledge + guess gaps.
 */
import axios from "axios";
import { readScrapeOutput } from "../services/product-catalog.service.js";
import { supabase } from "../supabase.js";

function normalizeUrl(url: string): string {
  try {
    return encodeURI(url.split("#")[0]!.split("?")[0]!.trim());
  } catch {
    return url.trim();
  }
}

function isFtUrl(url: string): boolean {
  return /\/pdf\/tech\/T_/i.test(url) || /\/T_(FR|NL|PL)_/i.test(url);
}

function ftLocale(url: string): string {
  if (/_NL_/i.test(url)) return "nl";
  if (/_PL_/i.test(url)) return "pl";
  if (/_FR_/i.test(url)) return "fr";
  return "other";
}

async function urlExists(url: string): Promise<boolean> {
  try {
    const r = await axios.head(url, { timeout: 10_000, validateStatus: (s) => s < 500 });
    return r.status === 200;
  } catch {
    return false;
  }
}

function normalizeTitle(title: string): string {
  return title
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&#0?38;/g, "")
    .replace(/&amp;/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

const SUFFIXES = ["", "_BRILLANT", "_MAT", "_PRO", "_PLUS", "_SPRAY", "_2", "_KIT"];

function suffixHintsFromSlug(slug: string): string[] {
  const hints: string[] = [""];
  if (/brillant/i.test(slug)) hints.unshift("_BRILLANT");
  if (/(?:^|-)mat(?:-|$)/i.test(slug)) hints.unshift("_MAT");
  if (/\bpro\b/i.test(slug)) hints.unshift("_PRO");
  if (/spray/i.test(slug)) hints.unshift("_SPRAY");
  if (/kit/i.test(slug)) hints.unshift("_KIT");
  return [...new Set(hints)];
}

async function guessFtUrl(title: string, slug: string, locale: string): Promise<string | null> {
  const token = locale === "nl" ? "NL" : locale === "pl" ? "PL" : "FR";
  const base = normalizeTitle(title);
  if (!base) return null;
  const ordered = [...new Set([...suffixHintsFromSlug(slug), ...SUFFIXES])];
  for (const suffix of ordered) {
    const url = `https://www.geb.fr/pdf/tech/T_${token}_${base}${suffix}.pdf`;
    if (await urlExists(url)) return url;
  }
  return null;
}

async function collectDocumentFtUrls(): Promise<Map<string, { locale: string; count: number }>> {
  const map = new Map<string, { locale: string; count: number }>();
  let offset = 0;
  while (offset < 30_000) {
    const { data, error } = await supabase.from("documents").select("metadata").range(offset, offset + 999);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const u = meta.source_url ?? meta.url;
      if (typeof u !== "string" || !isFtUrl(u)) continue;
      const url = normalizeUrl(u);
      const prev = map.get(url);
      map.set(url, { locale: ftLocale(url), count: (prev?.count ?? 0) + 1 });
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  return map;
}

async function main(): Promise<void> {
  const scrape = await readScrapeOutput();
  const docFt = await collectDocumentFtUrls();
  const docFtUrls = new Set(docFt.keys());

  const scrapeFtByLocale = { fr: new Set<string>(), nl: new Set<string>(), pl: new Set<string>() };
  for (const row of scrape) {
    if (!row.ft_url) continue;
    const url = normalizeUrl(row.ft_url);
    scrapeFtByLocale[row.language].add(url);
  }

  const { data: pkRows } = await supabase.from("product_knowledge").select("locale, ft_url, slug");
  const pkFtUrls = new Set(
    (pkRows ?? []).map((r) => r.ft_url).filter((u): u is string => typeof u === "string").map(normalizeUrl),
  );

  const frNoFt = scrape.filter((r) => r.language === "fr" && !r.ft_url);
  const guessable: Array<{ slug: string; title: string; guessed: string }> = [];
  const unrecoverable: Array<{ slug: string; title: string }> = [];

  for (const row of frNoFt) {
    const guessed = await guessFtUrl(row.title, row.slug, row.language);
    if (guessed) guessable.push({ slug: row.slug, title: row.title, guessed });
    else unrecoverable.push({ slug: row.slug, title: row.title });
  }

  const scrapeFtAll = new Set(
    scrape.map((r) => r.ft_url).filter((u): u is string => typeof u === "string").map(normalizeUrl),
  );

  const inScrapeNotDocs = [...scrapeFtAll].filter((u) => isFtUrl(u) && !docFtUrls.has(u));
  const inDocsNotScrape = [...docFtUrls].filter((u) => !scrapeFtAll.has(u));

  const docFr = [...docFtUrls].filter((u) => ftLocale(u) === "fr");
  const scrapeFr = [...scrapeFtByLocale.fr];

  const scrapeFrNotDocs = scrapeFr.filter((u) => !docFtUrls.has(u));
  const docFrNotScrape = docFr.filter((u) => !scrapeFtByLocale.fr.has(u));

  const pkFrNotDocs = [...pkFtUrls].filter((u) => isFtUrl(u) && ftLocale(u) === "fr" && !docFtUrls.has(u));

  console.log(
    JSON.stringify(
      {
        summary: {
          documents_unique_ft_urls: docFtUrls.size,
          documents_fr_ft_urls: docFr.length,
          scrape_unique_ft_urls: scrapeFtAll.size,
          scrape_fr_ft_urls: scrapeFtByLocale.fr.size,
          product_knowledge_ft_urls: pkFtUrls.size,
        },
        catalogue_fr: {
          wp_products: scrape.filter((r) => r.language === "fr").length,
          with_ft_in_scrape: scrapeFtByLocale.fr.size,
          without_ft: frNoFt.length,
          guessable_missing: guessable,
          unrecoverable,
        },
        alignment: {
          scrape_ft_not_in_documents: inScrapeNotDocs.length,
          scrape_fr_ft_not_in_documents: scrapeFrNotDocs,
          documents_fr_ft_not_in_scrape: {
            count: docFrNotScrape.length,
            urls: docFrNotScrape.slice(0, 25),
          },
          pk_fr_ft_not_in_documents: pkFrNotDocs,
        },
        verdict: {
          catalogue_fr_complete:
            frNoFt.length === 0
              ? "yes"
              : guessable.length === 0
                ? "almost — only unrecoverable gaps"
                : "no — run scrape with fixed guesser",
          documents_vs_scrape_fr:
            scrapeFrNotDocs.length === 0
              ? "aligned"
              : `missing ${scrapeFrNotDocs.length} FT from ingest`,
          orphan_pdfs_in_documents_not_in_catalogue: docFrNotScrape.length,
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
