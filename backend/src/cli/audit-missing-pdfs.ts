/**
 * Find FR scrape products without PDF URLs but with T_FR PDFs in documents or WP media pattern.
 */
import axios from "axios";
import { readScrapeOutput } from "../services/product-catalog.service.js";
import { supabase } from "../config/supabase.js";

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
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

async function main(): Promise<void> {
  const scrape = await readScrapeOutput();
  const frNoPdf = scrape.filter((r) => r.language === "fr" && !r.ft_url && !r.fds_url);

  const uniqueUrls = new Set<string>();
  let offset = 0;
  while (offset < 20_000) {
    const { data } = await supabase.from("documents").select("metadata").range(offset, offset + 999);
    if (!data?.length) break;
    for (const row of data) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const u = (meta.source_url ?? meta.url) as string | undefined;
      if (u) uniqueUrls.add(u);
    }
    if (data.length < 1000) break;
    offset += 1000;
  }

  const results: Array<{
    slug: string;
    title: string;
    candidate_pdfs_in_documents: string[];
    head_check_variants: string[];
  }> = [];

  for (const row of frNoPdf) {
    const norm = normalizeTitle(row.title);
    const tokens = norm.split("_").filter((t) => t.length > 2);
    const inDocs = [...uniqueUrls].filter(
      (u) => u.includes("T_FR_") && tokens.some((t) => u.toUpperCase().includes(t)),
    );

    const variants = [
      `https://www.geb.fr/pdf/tech/T_FR_${norm}.pdf`,
      `https://www.geb.fr/pdf/tech/T_FR_${norm}_BRILLANT.pdf`,
      `https://www.geb.fr/pdf/tech/T_FR_${norm}_MAT.pdf`,
    ];
    const existing: string[] = [];
    for (const v of variants) {
      if (await urlExists(v)) existing.push(v);
    }

    if (inDocs.length > 0 || existing.length > 0) {
      results.push({
        slug: row.slug,
        title: row.title,
        candidate_pdfs_in_documents: inDocs,
        head_check_variants: existing,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        fr_without_pdf_in_scrape: frNoPdf.map((r) => ({ slug: r.slug, title: r.title })),
        recoverable: results,
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
