import type { Response } from "express";
import type { ExtractedMetadata } from "../intent-extractor.js";
import { answerCache } from "../config/constants.js";
import { env } from "../config/env.js";
import type { Audience, HandoffPayload, Locale, Reseller } from "../types/index.js";
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
} from "../utils/response.js";
import { sseWrite } from "../utils/sse.js";
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
  cacheKey: string;
  startedAt: number;
  resellerPromise: Promise<Reseller[]>;
  ongoingConversation: boolean;
};

/** Stream a catalogue-backed technical sheet reply (no LLM generation). */
export async function deliverDirectTechnicalSheetTurn(ctx: DirectSheetTurnContext): Promise<void> {
  let answer = buildDirectTechnicalSheetReply(ctx.locale, ctx.product);
  sseWrite(ctx.res, { delta: answer, sessionId: ctx.sessionId, audience: ctx.audience }, "chunk");

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
  sseWrite(ctx.res, { delta: `\n\n${amazonSection}`, sessionId: ctx.sessionId, audience: ctx.audience }, "chunk");

  if (resellerSection) {
    answer += `\n\n${resellerSection}`;
    sseWrite(ctx.res, { delta: `\n\n${resellerSection}`, sessionId: ctx.sessionId, audience: ctx.audience }, "chunk");
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
      retrieval_path: "product_knowledge",
      product_slugs: [ctx.product.slug],
      direct_technical_sheet: true,
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
      status: "direct_technical_sheet",
    }),
    "logQuery.direct_technical_sheet",
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
      status: "direct_technical_sheet",
    }),
    "logProductAnalytics.direct_technical_sheet",
  );

  sseWrite(
    ctx.res,
    {
      done: true,
      sessionId: ctx.sessionId,
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
