import type { Response } from "express";
import type { ExtractedMetadata } from "../modules/retrieval/intent-extractor.js";
import { answerCache } from "../config/constants.js";
import { env } from "../config/env.js";
import type { Audience, HandoffPayload, Locale, ProductTheme, Reseller } from "../types/index.js";
import type { ProductKnowledgeRow } from "../types/product-knowledge.js";
import { fireAndForget } from "../utils/async.js";
import {
  buildAmazonSection,
  extractRecommendedProduct,
  getAmazonDefaultUrl,
  removeAmazonSections,
  resolveAmazonRecommendation,
} from "../utils/amazon.js";
import {
  buildDirectTechnicalSheetReply,
  buildResellerSection,
  removeComplementaryQuestionBlocks,
  sanitizeDocumentationLinks,
  stripLeadingConversationGreeting,
} from "../utils/response/index.js";
import { sseWriteWithSession } from "../utils/sse.js";
import { classifyProblemTypeWithLlm } from "./ai.service.js";
import { logProductAnalytics, logQuery, saveMessage } from "./database.service.js";

export type DirectSheetTurnContext = {
  res: Response;
  sessionId: string;
  locale: Locale;
  audience: Audience;
  handoff: HandoffPayload | null;
  geoCountry: string | null;
  product: ProductKnowledgeRow;
  extractedMeta: ExtractedMetadata;
  queryForRetrieval: string;
  /** Question initiale pour indexer le 👍 (correction testeur). */
  trainingQuery?: string;
  cacheKey: string;
  startedAt: number;
  resellerPromise: Promise<Reseller[]>;
  ongoingConversation: boolean;
  buildReply?: (
    locale: Locale,
    product: ProductKnowledgeRow,
    ctx?: { sessionAudience?: Audience | null; sessionTheme?: ProductTheme | null; feedbackCorrection?: boolean },
  ) => string;
  sessionTheme?: ProductTheme | null;
  logStatus?: "direct_technical_sheet" | "direct_cited_product";
};

/** Stream a catalogue-backed product reply (no LLM generation). */
export async function deliverDirectTechnicalSheetTurn(ctx: DirectSheetTurnContext): Promise<void> {
  const buildReply = ctx.buildReply ?? buildDirectTechnicalSheetReply;
  const logStatus = ctx.logStatus ?? "direct_technical_sheet";
  let answer = buildReply(ctx.locale, ctx.product, {
    sessionAudience: ctx.audience,
    sessionTheme: ctx.sessionTheme ?? null,
    feedbackCorrection: Boolean(ctx.trainingQuery),
  });
  sseWriteWithSession(ctx.res, ctx.sessionId, { delta: answer, audience: ctx.audience }, "chunk");

  answer = stripLeadingConversationGreeting(answer, ctx.ongoingConversation);
  answer = sanitizeDocumentationLinks(answer);
  answer = removeComplementaryQuestionBlocks(answer);

  const recommendation = resolveAmazonRecommendation(
    answer,
    ctx.locale,
    ctx.product.canonical_name,
    ctx.product.slug,
  );
  const resellers = ctx.locale === "pl" ? [] : await ctx.resellerPromise;
  const resellerSection = ctx.locale === "pl" ? "" : buildResellerSection(ctx.locale, resellers);
  const amazonSection = recommendation.productName
    ? buildAmazonSection(ctx.locale, recommendation)
    : buildAmazonSection(ctx.locale, { productName: null, amazonUrl: getAmazonDefaultUrl(ctx.locale, null) });

  answer = `${removeAmazonSections(answer)}\n\n${amazonSection}`.trim();
  sseWriteWithSession(ctx.res, ctx.sessionId, { delta: `\n\n${amazonSection}`, audience: ctx.audience }, "chunk");

  if (resellerSection) {
    answer += `\n\n${resellerSection}`;
    sseWriteWithSession(ctx.res, ctx.sessionId, { delta: `\n\n${resellerSection}`, audience: ctx.audience }, "chunk");
  }

  answerCache.set(ctx.cacheKey, {
    value: answer,
    expiresAt: Date.now() + env.QUERY_CACHE_TTL_MS,
  });

  const assistantMsgId = await saveMessage(ctx.sessionId, "assistant", answer, {
    metadata_extracted: ctx.extractedMeta,
    intent: ctx.extractedMeta.intent,
    response_context: {
      query_for_retrieval: ctx.queryForRetrieval,
      training_query: ctx.trainingQuery ?? ctx.queryForRetrieval,
      feedback_correction: Boolean(ctx.trainingQuery),
      retrieval_path: "product_knowledge",
      product_slugs: [ctx.product.slug],
      recommended_product: ctx.product.canonical_name,
      direct_technical_sheet: logStatus === "direct_technical_sheet",
      direct_cited_product: logStatus === "direct_cited_product",
    },
  });

  const problemClassification = await classifyProblemTypeWithLlm(ctx.queryForRetrieval, ctx.locale);

  fireAndForget(
    logQuery({
      sessionId: ctx.sessionId,
      locale: ctx.locale,
      audience: ctx.audience,
      fluidType: ctx.extractedMeta.fluid ?? null,
      query: ctx.queryForRetrieval,
      responseMs: Date.now() - ctx.startedAt,
      status: logStatus,
    }),
    `logQuery.${logStatus}`,
  );
  fireAndForget(
    logProductAnalytics({
      sessionId: ctx.sessionId,
      locale: ctx.locale,
      audience: ctx.audience,
      query: ctx.queryForRetrieval,
      recommendedProduct: recommendation.productName ?? extractRecommendedProduct(answer),
      amazonUrl: recommendation.amazonUrl,
      problemType: problemClassification.problemType,
      status: logStatus,
    }),
    `logProductAnalytics.${logStatus}`,
  );

  sseWriteWithSession(
    ctx.res,
    ctx.sessionId,
    {
      done: true,
      audience: ctx.audience,
      handoff: ctx.handoff,
      responseMs: Date.now() - ctx.startedAt,
      geoCountry: ctx.geoCountry,
      messageId: assistantMsgId,
    },
    "done",
  );
  ctx.res.end();
}
