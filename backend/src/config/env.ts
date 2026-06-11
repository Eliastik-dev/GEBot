import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function parseCsv(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export const env = {
  NODE_ENV: (process.env.NODE_ENV ?? "development") as "development" | "production" | "test",
  /** Comma-separated browser origins allowed to call the API (in addition to WP_URL). */
  CORS_ALLOWED_ORIGINS: parseCsv(process.env.CORS_ALLOWED_ORIGINS),
  /** Max characters accepted in a chat message after sanitization. */
  CHAT_MESSAGE_MAX_LENGTH: Number(process.env.CHAT_MESSAGE_MAX_LENGTH ?? "4000"),
  /** Trust X-Forwarded-For when behind Nginx/reverse proxy. */
  TRUST_PROXY: process.env.TRUST_PROXY !== "false",
  /** Optional bearer for verbose /health diagnostics in production. */
  HEALTH_DETAIL_TOKEN: process.env.HEALTH_DETAIL_TOKEN ?? "",
  MISTRAL_API_KEY: required("MISTRAL_API_KEY"),
  MISTRAL_EMBED_BATCH_SIZE: Number(process.env.MISTRAL_EMBED_BATCH_SIZE ?? "32"),
  /** Pause between embedding HTTP calls (ms). Helps stay under Mistral req/min on free tier (~60). */
  MISTRAL_EMBED_MIN_INTERVAL_MS: Number(process.env.MISTRAL_EMBED_MIN_INTERVAL_MS ?? "1100"),
  SUPABASE_URL: required("SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: required("SUPABASE_SERVICE_ROLE_KEY"),
  WP_URL: required("WP_URL"),
  WP_USER: process.env.WP_USER ?? "",
  WP_APP_PASSWORD: process.env.WP_APP_PASSWORD ?? "",
  PORT: Number(process.env.PORT ?? "8787"),
  SUPABASE_TABLE: process.env.SUPABASE_TABLE ?? "documents",
  /** Chunks passed to the LLM after hybrid rerank / technical prioritization (TDS + SDS coverage). */
  TOP_K: Number(process.env.TOP_K ?? "24"),
  /** Vector search retrieves TOP_K * this many candidates before lexicon rerank. */
  RETRIEVAL_POOL_MULTIPLIER: Number(process.env.RETRIEVAL_POOL_MULTIPLIER ?? "3"),
  /** Max nodes injected into the LLM context (catalog blocks + FT/FDS chunks). */
  DIAGNOSTIC_MAX_CONTEXT_NODES: Number(process.env.DIAGNOSTIC_MAX_CONTEXT_NODES ?? "128"),
  /** Max FT/FDS chunks retrieved per product slug (full datasheet ≈ 5–20 chunks). */
  PDF_CHUNKS_PER_SLUG: Number(process.env.PDF_CHUNKS_PER_SLUG ?? "48"),
  /** Distinct source URLs listed in the prompt footer. */
  DIAGNOSTIC_MAX_SOURCE_URLS: Number(process.env.DIAGNOSTIC_MAX_SOURCE_URLS ?? "12"),
  CHAT_HISTORY_LIMIT: Number(process.env.CHAT_HISTORY_LIMIT ?? "10"),
  QUERY_CACHE_TTL_MS: Number(process.env.QUERY_CACHE_TTL_MS ?? "120000"),
  MISTRAL_CHAT_MODEL: process.env.MISTRAL_CHAT_MODEL ?? "mistral-small-latest",
  MISTRAL_CHAT_FALLBACK_MODELS: process.env.MISTRAL_CHAT_FALLBACK_MODELS ?? "",
  /** Cap generation length (concise answers). */
  MISTRAL_CHAT_MAX_TOKENS: Number(process.env.MISTRAL_CHAT_MAX_TOKENS ?? "720"),
  MISTRAL_CHAT_MAX_RETRIES: Number(process.env.MISTRAL_CHAT_MAX_RETRIES ?? "3"),
  MISTRAL_CHAT_RETRY_BASE_MS: Number(process.env.MISTRAL_CHAT_RETRY_BASE_MS ?? "1500"),
  AMAZON_STORE_URL: process.env.AMAZON_STORE_URL ?? "https://www.amazon.fr/s?k=GEB",
  AMAZON_PRODUCT_URL_MAP: process.env.AMAZON_PRODUCT_URL_MAP ?? "",
  AMAZON_LINKS_XLSX_PATH:
    process.env.AMAZON_LINKS_XLSX_PATH ?? "P:\\Ecommerce\\Liens produits GEB toutes plateformes.xlsx",
  WP_RESELLERS_ENDPOINT: process.env.WP_RESELLERS_ENDPOINT ?? "/wp-json/wp/v2/resellers",
  /** Max structured products injected when product_knowledge route matches. */
  PRODUCT_KNOWLEDGE_MAX_PRODUCTS: Number(process.env.PRODUCT_KNOWLEDGE_MAX_PRODUCTS ?? "3"),
  /** Set to "false" to force legacy vector-only retrieval. */
  PRODUCT_KNOWLEDGE_ENABLED: process.env.PRODUCT_KNOWLEDGE_ENABLED !== "false",
  /**
   * Phase 4: simplify vector fallback when catalog exists.
   * auto (default) = lite when product_knowledge has rows for locale.
   */
  VECTOR_RAG_LITE: (process.env.VECTOR_RAG_LITE ?? "auto") as "auto" | "true" | "false",
} as const;

