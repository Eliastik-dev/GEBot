/**
 * Re-run PDF URL guessing for FR products and report gaps vs scrape-results.json.
 */
import axios from "axios";
import { readScrapeOutput } from "../services/product-catalog.service.js";

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

async function guessFtUrl(title: string, slug: string): Promise<string | null> {
  const base = normalizeTitle(title);
  if (!base) return null;
  const ordered = [...new Set([...suffixHintsFromSlug(slug), ...SUFFIXES.map((s) => s)])];
  for (const suffix of ordered) {
    const url = `https://www.geb.fr/pdf/tech/T_FR_${base}${suffix}.pdf`;
    if (await urlExists(url)) return url;
  }
  return null;
}

async function main(): Promise<void> {
  const scrape = await readScrapeOutput();
  const fr = scrape.filter((r) => r.language === "fr");
  const gaps: Array<{ slug: string; title: string; current_ft: string | null; guessed_ft: string }> = [];

  for (const row of fr) {
    const guessed = await guessFtUrl(row.title, row.slug);
    if (!guessed) continue;
    if (row.ft_url === guessed) continue;
    gaps.push({
      slug: row.slug,
      title: row.title,
      current_ft: row.ft_url,
      guessed_ft: guessed,
    });
  }

  console.log(
    JSON.stringify(
      {
        fr_products: fr.length,
        gaps_count: gaps.length,
        missing_entirely: gaps.filter((g) => !g.current_ft),
        wrong_or_different: gaps.filter((g) => g.current_ft),
        gaps,
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
