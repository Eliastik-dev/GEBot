import { Settings } from "llamaindex";
import { MistralAI } from "@llamaindex/mistral";
import { env } from "./env.js";
import { MistralBatchedEmbedding } from "../mistral-batched-embedding.js";

export function configureLlm(): void {
  if (!env.MISTRAL_API_KEY) {
    console.warn("[startup] Missing env var: MISTRAL_API_KEY");
  }
  if (!env.SUPABASE_URL) {
    console.warn("[startup] Missing env var: SUPABASE_URL");
  }

  Settings.llm = new MistralAI({
    apiKey: env.MISTRAL_API_KEY,
    model: env.MISTRAL_CHAT_MODEL as never,
  });

  const embedBatchSize = Number.isFinite(env.MISTRAL_EMBED_BATCH_SIZE)
    ? Math.max(1, env.MISTRAL_EMBED_BATCH_SIZE)
    : 32;
  const minIntervalMs = Number.isFinite(env.MISTRAL_EMBED_MIN_INTERVAL_MS)
    ? Math.max(0, env.MISTRAL_EMBED_MIN_INTERVAL_MS)
    : 1100;
  Settings.embedModel = new MistralBatchedEmbedding({
    apiKey: env.MISTRAL_API_KEY,
    embedBatchSize,
    minIntervalMs,
  });
}
