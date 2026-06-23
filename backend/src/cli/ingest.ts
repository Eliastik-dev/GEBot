import axios from "axios";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import {
  Document,
  SentenceSplitter,
  Settings,
  VectorStoreIndex,
  storageContextFromDefaults,
} from "llamaindex";
import { SupabaseVectorStore } from "@llamaindex/supabase";
import { env } from "../config/env.js";
import { MistralBatchedEmbedding } from "../mistral-batched-embedding.js";
import { supabase } from "../config/supabase.js";
import type { ScrapedProductRow } from "../services/product-theme.service.js";
import { resolveProductTheme } from "../services/wp-catalog-theme.service.js";
import {
  buildFaqDocuments,
  DEFAULT_FAQ_KNOWLEDGE_PATH,
  loadFaqKnowledgeEntries,
} from "../services/faq-knowledge.service.js";

type WpMedia = {
  id: number;
  slug?: string;
  source_url?: string;
  mime_type?: string;
  modified?: string;
  title?: { rendered?: string };
};

const WP_MEDIA_ENDPOINT = "https://www.geb.fr/wp-json/wp/v2/media?media_type=application";
const SCRAPE_OUTPUT_PATH = path.resolve(process.cwd(), "output", "scrape-results.json");
const PRIORITY_TERMS = ["SILICONE", "GEBSICONE", "FICHE"];
const TECHNICAL_TERMS = [
  "TECHNIQUE",
  "TECHNICAL",
  "TDS",
  "FT_",
  "T_FR_",
  "T_NL_",
  "T_PL_",
  "S_FR_",
  "FICHE TECHNIQUE",
  "FICHE_PRODUIT",
];

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function detectLocale(title: string, slug: string): "fr" | "nl" | "pl" {
  const marker = `${title} ${slug}`.toUpperCase();
  if (marker.includes("NL")) return "nl";
  if (marker.includes("PL")) return "pl";
  if (marker.includes("FR")) return "fr";
  return "fr";
}

function detectAudience(title: string, slug: string): "professional" | "particulier" | "all" {
  const marker = `${title} ${slug}`.toUpperCase();
  if (/(PRO|PROFESSIONNEL|PROFESSIONAL|CHANTIER|B2B)/.test(marker)) return "professional";
  if (/(PARTICULIER|CONSO|CONSUMER|DIY|B2C)/.test(marker)) return "particulier";
  return "all";
}

function detectRegulatoryScope(title: string, slug: string): "FR" | "GLOBAL" {
  const marker = `${title} ${slug}`.toUpperCase();
  if (marker.includes("NF DTU") || marker.includes("DTU") || marker.includes("NORME FR")) return "FR";
  return "GLOBAL";
}

function isTechnicalPdfCandidate(item: WpMedia): boolean {
  const sourceUrl = item.source_url?.trim() ?? "";
  const title = stripHtml(item.title?.rendered ?? "");
  const slug = item.slug ?? "";
  if (!sourceUrl) return false;
  if (sourceUrl.toLowerCase().includes("/blog/")) return false;
  const upper = `${title} ${slug} ${sourceUrl}`.toUpperCase();
  const isCatalog = upper.includes("CATALOGUE") || upper.includes("CATA-");
  if (isCatalog) return false;
  const hasPriorityTerm = PRIORITY_TERMS.some((term) => upper.includes(term));
  const hasTechnicalTerm = TECHNICAL_TERMS.some((term) => upper.includes(term));
  return hasPriorityTerm || hasTechnicalTerm;
}

async function fetchAllMedia(): Promise<WpMedia[]> {
  const perPage = 100;
  let page = 1;
  const out: WpMedia[] = [];

  while (true) {
    const url = `${WP_MEDIA_ENDPOINT}&per_page=${perPage}&page=${page}`;
    const { data } = await axios.get<WpMedia[]>(url, {
      timeout: 20_000,
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

async function readScrapeOutput(): Promise<ScrapedProductRow[]> {
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

async function extractPdfText(sourceUrl: string): Promise<string> {
  const { data } = await axios.get<ArrayBuffer>(sourceUrl, {
    responseType: "arraybuffer",
    timeout: 45_000,
  });
  const parser = new PDFParse({ data: Buffer.from(data) });
  try {
    const parsed = await parser.getText();
    return parsed.text.replace(/\u0000/g, "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

function buildContentHash(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

async function hasCurrentVersion(sourceUrl: string, contentHash: string): Promise<boolean> {
  const { data, error } = await supabase
    .from(env.SUPABASE_TABLE)
    .select("id, metadata")
    .contains("metadata", { source_url: sourceUrl })
    .limit(20);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return rows.some((row) => {
    const metadata = (row as { metadata?: Record<string, unknown> }).metadata ?? {};
    const stored =
      (typeof metadata.content_hash === "string" && metadata.content_hash) ||
      (typeof metadata.modified_hash === "string" && metadata.modified_hash);
    return stored === contentHash;
  });
}

async function deletePreviousVersions(sourceUrl: string): Promise<void> {
  const { error } = await supabase.from(env.SUPABASE_TABLE).delete().contains("metadata", { source_url: sourceUrl });
  if (error) throw error;
}

async function deletePreviousFaqVersions(faqId: string, locale: string): Promise<void> {
  const { error } = await supabase
    .from(env.SUPABASE_TABLE)
    .delete()
    .contains("metadata", { faq_id: faqId, locale });
  if (error) throw error;
}

async function hasCurrentFaqVersion(faqId: string, locale: string, contentHash: string): Promise<boolean> {
  const { data, error } = await supabase
    .from(env.SUPABASE_TABLE)
    .select("id, metadata")
    .contains("metadata", { faq_id: faqId, locale })
    .limit(20);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return rows.some((row) => {
    const metadata = (row as { metadata?: Record<string, unknown> }).metadata ?? {};
    const stored =
      (typeof metadata.content_hash === "string" && metadata.content_hash) ||
      (typeof metadata.modified_hash === "string" && metadata.modified_hash);
    return stored === contentHash;
  });
}

async function run(): Promise<void> {
  const splitter = new SentenceSplitter({ chunkSize: 1200, chunkOverlap: 120 });
  const embedBatchSize = Number.isFinite(env.MISTRAL_EMBED_BATCH_SIZE)
    ? Math.max(1, env.MISTRAL_EMBED_BATCH_SIZE)
    : 32;
  const minIntervalMs = Number.isFinite(env.MISTRAL_EMBED_MIN_INTERVAL_MS)
    ? Math.max(500, env.MISTRAL_EMBED_MIN_INTERVAL_MS)
    : 500;

  // mistral-embed vectors are 1024 dimensions.
  // This custom embedding class batches inputs, paces requests, and retries on 429.
  Settings.embedModel = new MistralBatchedEmbedding({
    apiKey: env.MISTRAL_API_KEY,
    embedBatchSize,
    minIntervalMs,
  });

  const scrapedRows = await readScrapeOutput();
  const media = scrapedRows.length === 0 ? await fetchAllMedia() : [];
  const docsToIngest: Array<{ doc: Document; sourceUrl: string }> = [];
  let indexedCount = 0;
  let skippedUpToDate = 0;
  let indexedFaqCount = 0;
  let skippedFaqUpToDate = 0;

  const faqJsonPath = env.FAQ_KNOWLEDGE_JSON_PATH?.trim() || DEFAULT_FAQ_KNOWLEDGE_PATH;
  const faqEntries = await loadFaqKnowledgeEntries(faqJsonPath);
  if (faqEntries.length > 0) {
    console.log(`Loading FAQ/general knowledge: ${faqJsonPath} (${faqEntries.length} entries)`);
    for (const item of buildFaqDocuments(faqEntries)) {
      const entry = item.doc.metadata as Record<string, unknown>;
      const faqId = String(entry.faq_id ?? "");
      const locale = String(entry.locale ?? "fr");
      const contentHash = String(entry.content_hash ?? buildContentHash(item.doc.text));
      const sourceUrl = String(entry.source_url ?? item.sourceKey);

      const alreadyIndexed = await hasCurrentFaqVersion(faqId, locale, contentHash);
      if (alreadyIndexed) {
        skippedFaqUpToDate += 1;
        continue;
      }
      await deletePreviousFaqVersions(faqId, locale);
      console.log(`Indexing FAQ [${locale}] ${faqId}...`);
      docsToIngest.push({ doc: item.doc, sourceUrl });
      indexedFaqCount += 1;
    }
  } else {
    console.log(`No FAQ entries found at ${faqJsonPath} (skipping FAQ ingestion).`);
  }

  if (scrapedRows.length > 0) {
    console.log(`Using scraper output: ${SCRAPE_OUTPUT_PATH} (${scrapedRows.length} rows)`);
    for (const row of scrapedRows) {
      const pdfCandidates = [
        { url: row.ft_url, kind: "ft" as const },
        { url: row.fds_url, kind: "fds" as const },
      ].filter((candidate) => typeof candidate.url === "string" && candidate.url.length > 0);

      for (const candidate of pdfCandidates) {
        const sourceUrl = candidate.url as string;

        try {
          console.log(`Checking ${row.title} [${row.language}] (${candidate.kind.toUpperCase()})...`);
          const text = await extractPdfText(sourceUrl);
          if (!text) continue;

          const contentHash = buildContentHash(text);
          const alreadyIndexed = await hasCurrentVersion(sourceUrl, contentHash);
          if (alreadyIndexed) {
            skippedUpToDate += 1;
            continue;
          }
          await deletePreviousVersions(sourceUrl);
          console.log(`Indexing ${row.title} [${row.language}] (${candidate.kind.toUpperCase()})...`);

          const resolved = resolveProductTheme({
            title: row.title,
            content: text,
            gamme_officielle: row.gamme_officielle ?? null,
            wp_product_cat_slugs: row.wp_product_cat_slugs ?? [],
            wp_product_cat_names: row.wp_product_cat_names ?? [],
          });
          const doc = new Document({
            text,
            metadata: {
              title: row.title,
              source_url: sourceUrl,
              url: sourceUrl,
              slug: row.slug,
              locale: row.language,
              audience: "all",
              regulatory_scope: "GLOBAL",
              wp_id: row.wp_id,
              modified: "",
              content_hash: contentHash,
              source: "geb_product_scraper_pdf",
              type: "pdf",
              sheet_type: candidate.kind,
              theme: resolved.theme,
              theme_source: resolved.theme_source,
              gamme_officielle: resolved.gamme_officielle ?? "",
              wp_product_cat_slugs: resolved.wp_product_cat_slugs,
            },
          });
          docsToIngest.push({ doc, sourceUrl });
          indexedCount += 1;
        } catch (error) {
          console.warn(`Skipping PDF ${sourceUrl}:`, error);
        }
      }
    }
  } else {
    for (const item of media) {
      const sourceUrl = item.source_url?.trim() ?? "";
      const isPdf = sourceUrl.toLowerCase().endsWith(".pdf") || item.mime_type === "application/pdf";
      if (!sourceUrl || !isPdf || !isTechnicalPdfCandidate(item)) continue;

      const title = stripHtml(item.title?.rendered ?? "").trim() || `document-${item.id}`;
      const slug = item.slug?.trim() ?? "";
      const locale = detectLocale(title, slug);
      const audience = detectAudience(title, slug);
      const regulatoryScope = detectRegulatoryScope(title, slug);

      try {
        console.log(`Checking ${title} in ${locale}...`);
        const text = await extractPdfText(sourceUrl);
        if (!text) continue;

        const contentHash = buildContentHash(text);
        const alreadyIndexed = await hasCurrentVersion(sourceUrl, contentHash);
        if (alreadyIndexed) {
          skippedUpToDate += 1;
          continue;
        }
        await deletePreviousVersions(sourceUrl);
        console.log(`Indexing ${title} in ${locale}...`);

        const resolved = resolveProductTheme({ title, content: text });
        const doc = new Document({
          text,
          metadata: {
            title,
            source_url: sourceUrl,
            url: sourceUrl,
            slug,
            locale,
            audience,
            regulatory_scope: regulatoryScope,
            wp_id: item.id,
            modified: item.modified ?? "",
            content_hash: contentHash,
            source: "wordpress_media_pdf",
            type: "pdf",
            theme: resolved.theme,
            theme_source: resolved.theme_source,
          },
        });
        docsToIngest.push({ doc, sourceUrl });
        indexedCount += 1;
      } catch (error) {
        console.warn(`Skipping PDF ${sourceUrl}:`, error);
      }
    }
  }

  if (docsToIngest.length === 0) {
    console.log("No documents to ingest (PDFs or FAQ).");
    return;
  }

  const vectorStore = new SupabaseVectorStore({
    supabaseUrl: env.SUPABASE_URL,
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY,
    table: env.SUPABASE_TABLE,
  });

  const storageContext = await storageContextFromDefaults({ vectorStore });
  let totalChunks = 0;
  for (const item of docsToIngest) {
    const chunks = splitter.getNodesFromDocuments([item.doc]);
    totalChunks += chunks.length;
    await VectorStoreIndex.fromDocuments(chunks, { storageContext });
  }

  console.log(
    JSON.stringify(
      {
        endpoint: WP_MEDIA_ENDPOINT,
        scrape_output_path: SCRAPE_OUTPUT_PATH,
        scrape_rows: scrapedRows.length,
        fetched_media_items: media.length,
        indexed_pdfs: indexedCount,
        indexed_faq: indexedFaqCount,
        skipped_up_to_date: skippedUpToDate,
        skipped_faq_up_to_date: skippedFaqUpToDate,
        faq_json_path: faqJsonPath,
        faq_entries: faqEntries.length,
        ingested_documents: docsToIngest.length,
        ingested_chunks: totalChunks,
        table: env.SUPABASE_TABLE,
      },
      null,
      2,
    ),
  );
}

run().catch((error: unknown) => {
  console.error("Ingestion error:", error);
  process.exitCode = 1;
});
