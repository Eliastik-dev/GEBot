import axios from "axios";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import type { ScrapedProductRow } from "./product-theme.service.js";

const SCRAPE_OUTPUT_PATH = path.resolve(process.cwd(), "output", "scrape-results.json");

export function buildSourceHash(sourceUrl: string, content: string): string {
  return createHash("sha256").update(`${sourceUrl}|${content.slice(0, 8000)}`).digest("hex");
}

export async function readScrapeOutput(): Promise<ScrapedProductRow[]> {
  try {
    await access(SCRAPE_OUTPUT_PATH);
  } catch {
    return [];
  }
  const raw = await readFile(SCRAPE_OUTPUT_PATH, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((row) => row && typeof row === "object") as ScrapedProductRow[];
}

export async function extractPdfText(sourceUrl: string): Promise<string> {
  const { data } = await axios.get<ArrayBuffer>(sourceUrl, {
    responseType: "arraybuffer",
    timeout: 45_000,
    validateStatus: (status) => status === 200,
  });
  const parser = new PDFParse({ data: Buffer.from(data) });
  try {
    const parsed = await parser.getText();
    return parsed.text.replace(/\u0000/g, "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** Try FT URL first, then FDS — some scraped FT links return 404 while SDS is available. */
export async function extractProductPdfText(
  row: Pick<ScrapedProductRow, "ft_url" | "fds_url" | "slug">,
): Promise<{ text: string; sourceUrl: string } | null> {
  const candidates = [row.ft_url, row.fds_url].filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  );

  for (const url of candidates) {
    try {
      const text = await extractPdfText(url);
      if (text.length >= 80) {
        return { text, sourceUrl: url };
      }
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      console.warn(
        `[catalog] PDF ${status ?? "error"} for ${row.slug}: ${url}`,
      );
    }
  }
  return null;
}

export function getScrapeOutputPath(): string {
  return SCRAPE_OUTPUT_PATH;
}
