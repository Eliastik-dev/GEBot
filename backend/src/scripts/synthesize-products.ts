/**
 * Batch job: synthesize structured product knowledge from GEB technical data sheets.
 *
 * Usage:
 *   npm run synthesize-products                          # all FR products with FT
 *   npm run synthesize-products -- --locale fr --limit 5
 *   npm run synthesize-products -- --slug pate-de-montage-echappement-collex
 *   npm run synthesize-products -- --force               # re-synthesize even if hash unchanged
 *   npm run synthesize-products -- --only-missing        # skip slugs already in DB (resume)
 *   npm run synthesize-products -- --rules-only          # no LLM — instant heuristic fill
 *
 * On Mistral 429, falls back to rules-based synthesis by default (SYNTHESIZE_RULES_FALLBACK=false to disable).
 *   SYNTHESIZE_MIN_INTERVAL_MS=10000
 *   SYNTHESIZE_RATE_LIMIT_COOLDOWN_MS=180000
 */

import { env } from "../config/env.js";
import { sleep } from "../utils/async.js";
import {
  buildSourceHash,
  extractProductPdfText,
  getScrapeOutputPath,
  readScrapeOutput,
} from "../services/product-catalog.service.js";
import {
  stripHtml,
  USE_CASE_TAG_VOCABULARY,
  type ScrapedProductRow,
} from "../services/product-theme.service.js";
import { resolveProductTheme } from "../services/wp-catalog-theme.service.js";
import {
  getProductKnowledgeBySlug,
  listProductKnowledgeSlugs,
  upsertProductKnowledge,
} from "../modules/retrieval/product-knowledge/index.js";
import {
  buildRulesBasedFactsForRow,
  RULES_EXTRACTION_VERSION,
} from "../services/product-rules-synthesis.service.js";
import {
  PRODUCT_KNOWLEDGE_EXTRACTION_VERSION,
  type ProductApplication,
  type SynthesizedProductFacts,
} from "../types/product-knowledge.js";

const RULES_FALLBACK_ENABLED = process.env.SYNTHESIZE_RULES_FALLBACK !== "false";

const SYNTHESIS_MODEL = env.MISTRAL_CHAT_MODEL;
const MIN_INTERVAL_MS = Number(process.env.SYNTHESIZE_MIN_INTERVAL_MS ?? "15000");
const MAX_LLM_RETRIES = Number(process.env.SYNTHESIZE_MAX_RETRIES ?? "2");
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.SYNTHESIZE_RATE_LIMIT_COOLDOWN_MS ?? "180000");
const LLM_TIMEOUT_MS = Number(process.env.SYNTHESIZE_LLM_TIMEOUT_MS ?? "120000");

const SYNTHESIS_SYSTEM_PROMPT = `You are a technical data extractor for GEB (French sealing/plumbing/heating/automotive products).
Read the product title and technical data sheet (TDS) text. Extract ONLY facts explicitly stated in the TDS.
Do NOT invent specifications. Use null for unknown numeric fields. Use empty arrays when not mentioned.

Return ONLY valid JSON:
{
  "summary_technical": "200-400 word synthesis in the sheet language — applications, key specs, how to use",
  "advantages": ["bullet", "..."],
  "compatible_materials": ["acier", "inox", "cuivre", ...],
  "incompatible_materials": ["..."],
  "compatible_fluids": ["eau potable", "gaz", "huile", ...],
  "incompatible_fluids": ["..."],
  "use_case_tags": ["tag1", "tag2"],
  "applications": [{"context": "short label", "description": "what it is for", "constraints": "limits or null"}],
  "max_pressure_bar": number or null,
  "temp_min_c": number or null,
  "temp_max_c": number or null,
  "curing_time": "string or null",
  "supports": "compatible surfaces/substrates summary or null",
  "certifications": ["..."],
  "warnings": ["safety or usage warnings from TDS"]
}

use_case_tags MUST use ONLY these normalized tags when applicable:
${USE_CASE_TAG_VOCABULARY.join(", ")}

Examples:
- Exhaust sealant → ["echappement", "montage_auto", "haute_temperature"]
- Potable water joint compound → ["eau_potable", "plomberie_raccord", "etancheite_filetage"]
- Pool liner repair → ["piscine", "reparation_fuite"]`;

type CliOptions = {
  locale: "fr" | "nl" | "pl" | "all";
  limit: number | null;
  slug: string | null;
  force: boolean;
  onlyMissing: boolean;
  rulesOnly: boolean;
  rulesFallback: boolean;
};

type ProcessResult = "skipped" | "synthesized" | "synthesized_rules" | "failed";

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    locale: "fr",
    limit: null,
    slug: null,
    force: false,
    onlyMissing: false,
    rulesOnly: false,
    rulesFallback: RULES_FALLBACK_ENABLED,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--locale" && argv[i + 1]) {
      opts.locale = argv[i + 1] as CliOptions["locale"];
      i += 1;
    } else if (arg === "--limit" && argv[i + 1]) {
      opts.limit = parseInt(argv[i + 1]!, 10);
      i += 1;
    } else if (arg === "--slug" && argv[i + 1]) {
      opts.slug = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--only-missing") {
      opts.onlyMissing = true;
    } else if (arg === "--rules-only") {
      opts.rulesOnly = true;
      opts.rulesFallback = true;
    } else if (arg === "--no-rules-fallback") {
      opts.rulesFallback = false;
    }
  }
  return opts;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asApplications(value: unknown): ProductApplication[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const row = item as Record<string, unknown>;
      return {
        context: typeof row.context === "string" ? row.context : "",
        description: typeof row.description === "string" ? row.description : "",
        constraints: typeof row.constraints === "string" ? row.constraints : null,
      };
    })
    .filter((item) => item.context.length > 0 || item.description.length > 0);
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = parseFloat(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeFacts(raw: Record<string, unknown>): SynthesizedProductFacts {
  const allowedTags = new Set<string>(USE_CASE_TAG_VOCABULARY);
  const tags = asStringArray(raw.use_case_tags)
    .map((tag) => tag.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "_"))
    .filter((tag) => allowedTags.has(tag));

  return {
    summary_technical: typeof raw.summary_technical === "string" ? raw.summary_technical.trim() : "",
    advantages: asStringArray(raw.advantages),
    compatible_materials: asStringArray(raw.compatible_materials),
    incompatible_materials: asStringArray(raw.incompatible_materials),
    compatible_fluids: asStringArray(raw.compatible_fluids),
    incompatible_fluids: asStringArray(raw.incompatible_fluids),
    use_case_tags: tags,
    applications: asApplications(raw.applications),
    max_pressure_bar: asNumberOrNull(raw.max_pressure_bar),
    temp_min_c: asNumberOrNull(raw.temp_min_c),
    temp_max_c: asNumberOrNull(raw.temp_max_c),
    curing_time: typeof raw.curing_time === "string" ? raw.curing_time : null,
    supports: typeof raw.supports === "string" ? raw.supports : null,
    certifications: asStringArray(raw.certifications),
    warnings: asStringArray(raw.warnings),
  };
}

function rateLimitWaitMs(attempt: number): number {
  const exponential = Math.min(RATE_LIMIT_COOLDOWN_MS, 20_000 * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 5000);
  return exponential + jitter;
}

async function callMistral(model: string, title: string, locale: string, ftText: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    return await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1400,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Product: ${title}\nLocale: ${locale}\n\n--- TDS TEXT ---\n${ftText.slice(0, 10000)}`,
          },
        ],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function synthesizeFromTds(
  title: string,
  locale: string,
  ftText: string,
): Promise<SynthesizedProductFacts | null | "rate_limited"> {
  for (let attempt = 0; attempt < MAX_LLM_RETRIES; attempt += 1) {
    try {
      const response = await callMistral(SYNTHESIS_MODEL, title, locale, ftText);

      if (response.status === 429 || response.status === 503) {
        const waitMs = rateLimitWaitMs(attempt);
        console.warn(
          `[synthesize] LLM HTTP ${response.status}, retry ${attempt + 1}/${MAX_LLM_RETRIES} in ${Math.round(waitMs / 1000)}s`,
        );
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.warn(`[synthesize] LLM HTTP ${response.status}:`, body.slice(0, 200));
        return null;
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = payload.choices?.[0]?.message?.content ?? "";
      let cleaned = raw.trim();
      const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
      if (fence?.[1]) cleaned = fence[1].trim();

      const parsed = JSON.parse(cleaned) as Record<string, unknown>;
      return normalizeFacts(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isAbort = /aborted|abort/i.test(message);
      if (isAbort && attempt < MAX_LLM_RETRIES - 1) {
        const waitMs = rateLimitWaitMs(attempt);
        console.warn(`[synthesize] LLM timeout, retry ${attempt + 1}/${MAX_LLM_RETRIES} in ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }
      console.warn("[synthesize] LLM failed:", message);
      return null;
    }
  }

  return "rate_limited";
}

function filterRows(rows: ScrapedProductRow[], opts: CliOptions, existingSlugs: Set<string>): ScrapedProductRow[] {
  let filtered = rows.filter(
    (row) =>
      (typeof row.ft_url === "string" && row.ft_url.length > 0) ||
      (typeof row.fds_url === "string" && row.fds_url.length > 0),
  );
  if (opts.locale !== "all") {
    filtered = filtered.filter((row) => row.language === opts.locale);
  }
  if (opts.slug) {
    filtered = filtered.filter((row) => row.slug === opts.slug);
  }
  if (opts.onlyMissing && !opts.force) {
    filtered = filtered.filter((row) => !existingSlugs.has(row.slug));
  }
  if (opts.limit && opts.limit > 0) {
    filtered = filtered.slice(0, opts.limit);
  }
  return filtered;
}

async function processProduct(row: ScrapedProductRow, opts: CliOptions): Promise<ProcessResult> {
  const title = stripHtml(row.title);

  const pdfResult = await extractProductPdfText(row);
  if (!pdfResult) {
    console.warn(`[synthesize] no usable PDF for ${row.slug} (FT and FDS unavailable)`);
    return "failed";
  }
  const { text: ftText, sourceUrl: pdfSourceUrl } = pdfResult;

  const sourceHash = buildSourceHash(pdfSourceUrl, ftText);
  if (!opts.force) {
    const existing = await getProductKnowledgeBySlug(row.slug, row.language);
    if (existing && existing.source_ft_hash === sourceHash) {
      const llmCurrent = existing.extraction_version === PRODUCT_KNOWLEDGE_EXTRACTION_VERSION;
      const rulesCurrent = existing.extraction_version === RULES_EXTRACTION_VERSION;
      if (llmCurrent || (rulesCurrent && !opts.force)) {
        console.log(`[synthesize] skip (up to date): ${title} [${existing.extraction_version}]`);
        return "skipped";
      }
    }
  }

  let facts: SynthesizedProductFacts;
  let extractionVersion = PRODUCT_KNOWLEDGE_EXTRACTION_VERSION;
  let extractionModel = SYNTHESIS_MODEL;

  if (opts.rulesOnly) {
    console.log(`[synthesize] rules-only: ${title} [${row.language}]`);
    facts = buildRulesBasedFactsForRow(row, ftText);
    extractionVersion = RULES_EXTRACTION_VERSION;
    extractionModel = "rules-fallback";
  } else {
    console.log(`[synthesize] extracting: ${title} [${row.language}]`);
    const llmFacts = await synthesizeFromTds(title, row.language, ftText);
    if (llmFacts === "rate_limited") {
      if (opts.rulesFallback) {
        console.warn(`[synthesize] LLM quota — rules fallback: ${row.slug}`);
        facts = buildRulesBasedFactsForRow(row, ftText);
        extractionVersion = RULES_EXTRACTION_VERSION;
        extractionModel = "rules-fallback";
      } else {
        console.warn(`[synthesize] LLM quota — skipped: ${row.slug}`);
        return "failed";
      }
    } else if (!llmFacts || !llmFacts.summary_technical) {
      console.warn(`[synthesize] extraction failed: ${row.slug}`);
      return "failed";
    } else {
      facts = llmFacts;
    }
  }

  if (!facts.summary_technical) {
    console.warn(`[synthesize] empty synthesis: ${row.slug}`);
    return "failed";
  }

  const resolved = resolveProductTheme({
    title,
    content: ftText,
    gamme_officielle: row.gamme_officielle ?? null,
    wp_product_cat_slugs: row.wp_product_cat_slugs ?? [],
    wp_product_cat_names: row.wp_product_cat_names ?? [],
  });
  await upsertProductKnowledge({
    wp_id: row.wp_id,
    slug: row.slug,
    locale: row.language,
    canonical_name: title,
    theme: resolved.theme,
    theme_source: resolved.theme_source,
    gamme_officielle: resolved.gamme_officielle,
    wp_product_cat_slugs: resolved.wp_product_cat_slugs,
    ft_url: row.ft_url ?? pdfSourceUrl,
    fds_url: row.fds_url,
    source_ft_hash: sourceHash,
    extraction_version: extractionVersion,
    extraction_model: extractionModel,
    facts,
  });

  const mode = extractionModel === "rules-fallback" ? "synthesized_rules" : "synthesized";
  console.log(
    `[synthesize] saved (${extractionModel}): ${title} | tags=[${facts.use_case_tags.join(", ")}] | theme=${resolved.theme} (${resolved.theme_source})`,
  );
  return mode;
}

async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const rows = await readScrapeOutput();
  if (rows.length === 0) {
    console.error(`No scrape output at ${getScrapeOutputPath()}. Run: npm run scrape`);
    process.exitCode = 1;
    return;
  }

  const existingSlugs =
    opts.locale !== "all" ? await listProductKnowledgeSlugs(opts.locale).catch(() => new Set<string>()) : new Set<string>();

  const targets = filterRows(rows, opts, existingSlugs);
  console.log(
    `[synthesize] ${targets.length} products (locale=${opts.locale}, onlyMissing=${opts.onlyMissing}, rulesOnly=${opts.rulesOnly}, rulesFallback=${opts.rulesFallback})`,
  );
  if (!opts.rulesOnly) {
    console.log(`[synthesize] LLM model: ${SYNTHESIS_MODEL}`);
  }

  let synthesized = 0;
  let synthesizedRules = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of targets) {
    const result = await processProduct(row, opts);
    if (result === "synthesized") synthesized += 1;
    else if (result === "synthesized_rules") synthesizedRules += 1;
    else if (result === "skipped") skipped += 1;
    else failed += 1;

    if (!opts.rulesOnly) {
      await sleep(MIN_INTERVAL_MS);
    }
  }

  console.log(
    JSON.stringify(
      {
        processed: targets.length,
        synthesized_llm: synthesized,
        synthesized_rules: synthesizedRules,
        skipped,
        failed,
        extraction_version: PRODUCT_KNOWLEDGE_EXTRACTION_VERSION,
        rules_version: RULES_EXTRACTION_VERSION,
      },
      null,
      2,
    ),
  );
}

run().catch((err: unknown) => {
  console.error("[synthesize] fatal:", err);
  process.exitCode = 1;
});
