/**
 * LLM-as-a-Judge Pipeline
 *
 * Background service that evaluates the quality of AI responses by analyzing
 * the User Question + Context Chunks + AI Response against TDS/SDS compliance.
 * Results are persisted to Supabase for building a training dataset.
 */

import { env } from "../../config/env.js";
import { supabase } from "../../config/supabase.js";
import type { ExtractedMetadata } from "../retrieval/intent-extractor.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface JudgeInput {
  messageId: string;
  sessionId: string;
  userQuery: string;
  assistantReply: string;
  contextChunks: Array<{ text: string; metadata?: Record<string, unknown> }>;
  searchQuery: string;
  intent: string | null;
  metadataExtracted: ExtractedMetadata | null;
  retrievalPath?: "product_knowledge" | "vector_rag";
  productSlugs?: string[];
  useCaseTags?: string[];
}

export interface JudgeResult {
  score: number;
  critique: string;
  tdsCompliance: boolean;
  sdsCompliance: boolean;
  modelUsed: string;
}

// ── Judge prompt ───────────────────────────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = `You are a strict technical quality evaluator for GEBot, a plumbing/sealing product advisor.
You must evaluate whether the AI assistant's response is technically sound, safe, and grounded in the provided context.

You receive:
1. The user's question
2. The context chunks (document excerpts from TDS/SDS/product pages) that were retrieved
3. The AI assistant's response
4. The detected intent and extracted metadata

Evaluate on these criteria (score each 0-20, total 0-100):

**1. TDS Compliance (0-20)**: Does the response respect Technical Data Sheet limits?
- Are pressure limits, temperature ranges, and fluid compatibility correctly stated?
- Does it only claim what the TDS text explicitly supports?
- Score 0 if TDS data is present in context but the response contradicts or ignores limits.

**2. SDS/Safety Compliance (0-20)**: Does the response respect Safety Data Sheet constraints?
- Are chemical incompatibilities mentioned when SDS data is in context?
- Are safety warnings included for hazardous products?
- Score 0 if safety-critical info is omitted when SDS data is available.

**3. Grounding / Hallucination Check (0-20)**: Is the response grounded in context?
- Does it only state what can be verified from the provided chunks?
- Does it fabricate product names, specs, or URLs not in context?
- Score 0 for clear hallucinations.

**4. Completeness & Relevance (0-20)**: Does it answer the user's actual question?
- Is the recommended product appropriate for the detected intent?
- When retrieval_path is "product_knowledge", does the recommended product match one of the catalog slugs provided?
- Are missing parameters acknowledged (not guessed)?
- Does it address the specific use case (not a generic answer)?

**5. Safety-Critical Judgment (0-20)**: For leak/pressure/gas scenarios:
- Does it refuse to recommend without mandatory safety data?
- Does it distinguish "may work" from "certified for this application"?
- For large holes/cracks, does it warn against simple surface mastic?
- Score 0 if it recommends a product for a safety-critical use without proper TDS backing.

**6. GEB brand policy (apply as penalty on total score)**: Deduct up to 30 points from the final total if the assistant names or recommends competitor brands (Sika, Mapei, Kerakoll, Bostik, Henkel, Loctite, 3M, Würth, Soudal, Weber, etc.). Only GEB catalogue products may be endorsed.

Return ONLY valid JSON:
{
  "tds_compliance_score": 0-20,
  "tds_compliance_note": "...",
  "sds_compliance_score": 0-20,
  "sds_compliance_note": "...",
  "grounding_score": 0-20,
  "grounding_note": "...",
  "completeness_score": 0-20,
  "completeness_note": "...",
  "safety_score": 0-20,
  "safety_note": "...",
  "total_score": 0-100,
  "tds_compliant": boolean,
  "sds_compliant": boolean,
  "critique": "One paragraph summary of strengths and weaknesses"
}`;

// ── Core evaluation function ───────────────────────────────────────────────────

async function callJudgeLlm(input: JudgeInput): Promise<JudgeResult | null> {
  try {
    const contextSummary = input.contextChunks
      .slice(0, 8)
      .map((chunk, i) => {
        const sheetType = chunk.metadata?.sheet_type ?? "unknown";
        const title = chunk.metadata?.title ?? "untitled";
        return `[Chunk ${i + 1} | type=${sheetType} | title=${title}]\n${chunk.text.slice(0, 1500)}`;
      })
      .join("\n\n");

    const metaSummary = input.metadataExtracted
      ? JSON.stringify(input.metadataExtracted, null, 2)
      : "No metadata extracted";

    const retrievalSummary =
      input.retrievalPath || input.productSlugs?.length
        ? `path=${input.retrievalPath ?? "unknown"}
catalog_slugs=${(input.productSlugs ?? []).join(", ") || "none"}
use_case_tags=${(input.useCaseTags ?? []).join(", ") || "none"}`
        : "No structured catalog routing metadata";

    const userMessage = `--- USER QUESTION ---
${input.userQuery}

--- DETECTED INTENT ---
${input.intent ?? "unknown"}

--- EXTRACTED METADATA ---
${metaSummary}

--- RETRIEVAL ROUTING ---
${retrievalSummary}

--- SEARCH QUERY USED ---
${input.searchQuery}

--- CONTEXT CHUNKS RETRIEVED ---
${contextSummary || "(no context)"}

--- AI ASSISTANT RESPONSE ---
${input.assistantReply}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.MISTRAL_CHAT_MODEL,
        temperature: 0,
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          { role: "user", content: userMessage.slice(0, 12_000) },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const raw = payload.choices?.[0]?.message?.content ?? "";
    let cleaned = raw.trim();
    const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    if (fence?.[1]) cleaned = fence[1].trim();

    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const score = typeof parsed.total_score === "number"
      ? Math.max(0, Math.min(100, Math.round(parsed.total_score)))
      : 50;

    const critique = typeof parsed.critique === "string" ? parsed.critique : "No critique generated";
    const tdsCompliance = typeof parsed.tds_compliant === "boolean" ? parsed.tds_compliant : score >= 60;
    const sdsCompliance = typeof parsed.sds_compliant === "boolean" ? parsed.sds_compliant : score >= 60;

    return {
      score,
      critique,
      tdsCompliance,
      sdsCompliance,
      modelUsed: env.MISTRAL_CHAT_MODEL,
    };
  } catch (err) {
    console.warn("[judge] LLM evaluation failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Persistence ────────────────────────────────────────────────────────────────

async function persistJudgeResult(input: JudgeInput, result: JudgeResult): Promise<void> {
  // Update the chat_messages row
  const { error: msgError } = await supabase
    .from("chat_messages")
    .update({
      judge_score: result.score,
      judge_critique: result.critique,
    })
    .eq("id", input.messageId);

  if (msgError) {
    const msg = (msgError as { message?: string }).message ?? "";
    if (!/judge_score|judge_critique/i.test(msg) && (msgError as { code?: string }).code !== "PGRST204") {
      console.warn("[judge] Failed to update chat_messages:", msg);
    }
  }

  // Insert full audit record
  const { error: evalError } = await supabase.from("judge_evaluations").insert({
    message_id: input.messageId,
    session_id: input.sessionId,
    user_query: input.userQuery,
    assistant_reply: input.assistantReply.slice(0, 10_000),
    context_chunks: input.contextChunks.map((c) => ({
      text: c.text.slice(0, 2000),
      metadata: c.metadata ?? {},
    })),
    search_query: input.searchQuery,
    intent: input.intent,
    metadata_extracted: input.metadataExtracted,
    retrieval_context:
      input.retrievalPath || input.productSlugs?.length
        ? {
            retrieval_path: input.retrievalPath ?? null,
            product_slugs: input.productSlugs ?? [],
            use_case_tags: input.useCaseTags ?? [],
          }
        : null,
    tds_compliance: result.tdsCompliance,
    sds_compliance: result.sdsCompliance,
    score: result.score,
    critique: result.critique,
    model_used: result.modelUsed,
  });

  if (evalError) {
    const msg = (evalError as { message?: string }).message ?? "";
    const code = (evalError as { code?: string }).code;
    if (/judge_evaluations/i.test(msg) || code === "PGRST204" || code === "42P01") {
      console.warn("[judge] judge_evaluations table not found — skipping audit record:", msg);
    } else {
      console.warn("[judge] Failed to insert judge_evaluations:", msg);
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget background evaluation.
 * Call this after generating a response — it won't block the chat flow.
 */
export async function evaluateResponse(input: JudgeInput): Promise<void> {
  const result = await callJudgeLlm(input);
  if (!result) {
    console.warn("[judge] Evaluation returned null for message", input.messageId);
    return;
  }

  console.log("[judge] Score:", result.score, "for message", input.messageId, "—", result.critique.slice(0, 120));
  await persistJudgeResult(input, result);
}
