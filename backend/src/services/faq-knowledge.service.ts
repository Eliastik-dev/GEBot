import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Document } from "llamaindex";
import type { ProductTheme } from "../types/index.js";
import type { ScrapeLocale } from "./geb-scraper.service.js";

export type FaqKnowledgeEntry = {
  /** Stable identifier (slug-like). */
  id: string;
  locale: ScrapeLocale;
  question: string;
  answer: string;
  theme?: ProductTheme | null;
  audience?: "professional" | "particulier" | "all";
  source_url?: string | null;
  tags?: string[];
};

export const DEFAULT_FAQ_KNOWLEDGE_PATH = path.resolve(process.cwd(), "output", "faq-knowledge.json");

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function buildFaqContentHash(entry: FaqKnowledgeEntry): string {
  const payload = [
    entry.id,
    entry.locale,
    entry.question,
    entry.answer,
    entry.theme ?? "",
    entry.source_url ?? "",
    (entry.tags ?? []).join(","),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

export function buildFaqDocumentText(entry: FaqKnowledgeEntry): string {
  const tags =
    entry.tags && entry.tags.length > 0 ? `\nMots-clés: ${entry.tags.join(", ")}` : "";
  return `Question: ${normalizeText(entry.question)}\n\nRéponse: ${normalizeText(entry.answer)}${tags}`;
}

export function normalizeFaqKnowledgeEntry(raw: unknown): FaqKnowledgeEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const locale = row.locale;
  const question = typeof row.question === "string" ? row.question.trim() : "";
  const answer = typeof row.answer === "string" ? row.answer.trim() : "";
  if (!id || !question || !answer) return null;
  if (locale !== "fr" && locale !== "nl" && locale !== "pl") return null;

  const themeRaw = typeof row.theme === "string" ? row.theme.trim() : null;
  const audienceRaw = row.audience;
  const tags = Array.isArray(row.tags)
    ? row.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim())
    : [];

  return {
    id,
    locale,
    question,
    answer,
    ...(themeRaw ? { theme: themeRaw as ProductTheme } : {}),
    audience:
      audienceRaw === "professional" || audienceRaw === "particulier" || audienceRaw === "all"
        ? audienceRaw
        : "all",
    ...(typeof row.source_url === "string" && row.source_url.trim()
      ? { source_url: row.source_url.trim() }
      : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

export async function loadFaqKnowledgeEntries(filePath = DEFAULT_FAQ_KNOWLEDGE_PATH): Promise<FaqKnowledgeEntry[]> {
  try {
    await access(filePath);
  } catch {
    return [];
  }
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeFaqKnowledgeEntry).filter((row): row is FaqKnowledgeEntry => row !== null);
}

export function buildFaqDocuments(entries: FaqKnowledgeEntry[]): Array<{ doc: Document; sourceKey: string }> {
  return entries.map((entry) => {
    const text = buildFaqDocumentText(entry);
    const contentHash = buildFaqContentHash(entry);
    const sourceKey = `faq:${entry.locale}:${entry.id}`;
    const sourceUrl = entry.source_url?.trim() || `faq://${entry.locale}/${entry.id}`;

    const doc = new Document({
      text,
      metadata: {
        title: entry.question,
        source_url: sourceUrl,
        url: sourceUrl,
        slug: entry.id,
        locale: entry.locale,
        audience: entry.audience ?? "all",
        regulatory_scope: "GLOBAL",
        content_hash: contentHash,
        source: "faq_knowledge_json",
        type: "general_knowledge",
        document_type: "faq",
        sheet_type: "faq",
        faq_id: entry.id,
        theme: entry.theme ?? "",
        tags: entry.tags ?? [],
      },
    });

    return { doc, sourceKey };
  });
}
