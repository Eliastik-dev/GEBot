import type { Request, Response } from "express";
import { buildEnrichedSearchQuery, dynamicRerank, hasExhaustProductInNodes, isAutomotiveExhaustContext } from "../retrieval/dynamic-reranker.js";
import { runDiagnosticAnalysis, type DiagnosticAnalysis } from "../retrieval/intent-extractor.js";
import { ANSWER_CACHE_VERSION, answerCache, NEXT_QUESTION_AFTER_THEME, ONBOARDING_QUESTION_BY_LOCALE, THEME_QUESTION_BY_LOCALE, TTFT_TARGET_MS, VALID_THEMES, VECTOR_SEARCH_TIMEOUT_MS } from "../../config/constants.js";
import { env } from "../../config/env.js";
import { resolveVectorRagLite } from "../../config/retrieval.js";
import {
  buildSystemPrompt,
  buildPreAnalysisTranscript,
  classifyProblemTypeWithLlm,
  expandRetrievalQueryWithLlm,
  queryWithRetryAndFallback,
} from "../../services/ai.service.js";
import { hardBoostSlugs, hardPenalizeSlugs, resolveFeedbackRetrievalContext } from "../../services/feedback-retrieval.service.js";
import { ensureSession, getSessionTheme, loadRecentMessages, logProblemEvent, logProductAnalytics, logQuery, saveMessage, updateSessionAudience, updateSessionTheme } from "../../services/database.service.js";
import { scheduleJudgeEvaluation, type JudgeInput } from "../../services/judge.service.js";
import {
  buildSearchQuery,
  buildThemeAwareSearchQuery,
  capContextNodes,
  enrichRetrievalQuery,
  extractSourceUrlsFromNodes,
  getCachedResellers,
  mergeRetrievalNodes,
  prioritizeTechnicalSheets,
  retrievePdfChunksForSlugs,
  retrieveFaqKnowledgeChunks,
  searchFaqKnowledgeMatch,
  summarizeNodeForDebug,
  AUTOMOTIVE_EXHAUST_SUPPLEMENT_QUERY,
} from "../../services/rag.service.js";
import { hasDescalingContext, hasHeatingCircuitContext, isBuildingEnvelopeLeakContext, isBuildingSurfaceSealingContext, isPersonalDrinkwareOutOfCatalog } from "../../utils/diagnostic-rules.js";
import {
  countProductKnowledge,
  detectCatalogProductCitations,
  filterProductKnowledgeByPenalties,
  filterProductKnowledgeByQueryContext,
  getProductKnowledgeBySlug,
  injectFeedbackBoostProducts,
  lookupCatalogProductsByCitation,
  lookupCitedCatalogProductForRecommendation,
  lookupExplicitCatalogProductForSheet,
  searchProductKnowledge,
} from "../retrieval/product-knowledge/index.js";
import { deliverDirectTechnicalSheetTurn } from "../../services/direct-sheet.service.js";
import {
  buildRetrieverNodesFromProductKnowledge,
  productKnowledgeLocale,
  routeProductKnowledge,
  summarizeProductKnowledgeForDebug,
} from "../../services/product-router.service.js";
import type { Audience, ChatRequestBody, Locale, ProductTheme, Reseller } from "../../types/index.js";
import type { ProductKnowledgeRow } from "../../types/product-knowledge.js";
import { fireAndForget, withTimeout } from "../../utils/async.js";
import { getAmazonDefaultUrl, getProductHintFromNodes, getProductSlugHintFromNodes, resolveAmazonRecommendation, extractRecommendedProduct, hasAmazonSection, hasFallbackAmazonSearchUrl, hasValidRecommendedProduct, removeAmazonSections, buildAmazonSection } from "../../utils/amazon.js";
import { resolveAnyProductCorrectionContext, resolveProductCitationQuery, buildUserCitationScanText } from "../../utils/feedback-correction.js";
import { detectAudience, detectTheme, getSpecificClarification, isProfileOnlyMessage, isThemeOnlyMessage, isThemeUncertaintyMessage, buildThemeUncertaintyReply, normalizeAudience, normalizeLocale } from "../../utils/locale.js";
import { answerProvidesProductGuidance, answerContradictsRecommendation, buildComplementaryFollowUp, buildComplementarySuggestion, buildDirectCitedProductReply, buildDirectTechnicalSheetReply, buildEscalationSection, buildGratitudeReply, buildHandoff, buildPurchaseAvailabilityIntro, buildResellerSection, buildMoreDetailsForProductRequest, buildPersonalDrinkwareOutOfScopeReply, compactProductFollowUpAnswer, containsOffTopicSink, extractComplementaryQuestionBlock, isComplementaryQuestion, isGratitudeOrClosingMessage, isResellerIntent, isYesNoAnswer, removeComplementaryQuestionBlocks, sanitizeDocumentationLinks, buildPipeGasClarification, hasStoreSection, stripAnswerWithoutProductRecommendation, stripContradictoryProductRecommendation, stripLeadingConversationGreeting } from "../../utils/response/index.js";
import {
  getLastDiscussedProductFromHistory,
  getLastDiscussedProductSlugFromHistory,
  isProductFollowUpQuestion,
  isPurchaseAvailabilityQuestion,
} from "../../utils/conversation-context.js";
import {
  EXPLICIT_PRODUCT_MATCH_MIN,
  computeExplicitProductMatchScore,
  EXPLICIT_PRODUCT_NAME_PRIORITY_MIN,
  formatNamedProductCitationPrompt,
  hasNamedProductCitation,
  isExplicitProductLookupQuery,
  isExplicitProductTargeted,
  isFactualProductQuestion,
  resolveDirectCitedProduct,
  resolveDirectTechnicalSheetProduct,
} from "../../utils/product-mention.js";
import { containsCompetitorBrandMention, sanitizeCompetitorBrandMentions } from "../../utils/brand-policy.js";
import {
  buildNoContextFallback,
  extractFluid,
  getGenericNoAnswerFallback,
  hasOngoingConversation,
  isCompatibilitySpecQuestion,
  isInformationalProductQuestion,
  resolveClarificationContext,
  toAudienceLabel,
  toHistoryPrompt,
} from "../../utils/text.js";
import { resolveJointPasteClarificationContext } from "../../utils/joint-paste.js";
import { safeErrorPayload, isProduction } from "../../utils/http.js";
import { getIncomingSessionId } from "../../utils/session.js";
import { startSse, sseWriteWithSession } from "../../utils/sse.js";
import type { chatBodySchema } from "../../validation/schemas.js";
import type { VectorStoreIndex } from "llamaindex";
import type { z } from "zod";
import type { ChatPipelineBindings } from "./chat-pipeline-bindings.js";
import { assertAfterGeneration } from "./chat-pipeline-assertions.js";

export async function postProcessReply(ctx: ChatPipelineBindings): Promise<void> {
  if (ctx.completed) return;
  assertAfterGeneration(ctx);
  const { req, res, deps, startedAt, body, message, locale, profileFromMetadata, sessionId, geoConsentFromBody, geoCountryFromBody } = ctx;

    if (ctx.answer) {
      answerCache.set(ctx.cacheKey, {
        value: ctx.answer,
        expiresAt: Date.now() + env.QUERY_CACHE_TTL_MS,
      });
    }

    ctx.contextChunksForJudge = ctx.resolvedNodes.slice(0, 8).map((node) => {
      const wrap = node as { node?: { text?: string; getContent?: (mode?: string) => string; metadata?: Record<string, unknown> } };
      const text = typeof wrap.node?.getContent === "function"
        ? (wrap.node.getContent("NONE") ?? "")
        : (wrap.node?.text ?? "");
      return { text, metadata: wrap.node?.metadata ?? {} };
    });
    ctx.assistantMsgId = await saveMessage(sessionId, "assistant", ctx.answer, {
      metadata_extracted: ctx.extractedMeta,
      intent: ctx.extractedMeta.intent,
      response_context: {
        search_query: ctx.searchQuery,
        query_for_retrieval: ctx.queryForRetrieval,
        training_query: ctx.queryForRetrieval,
        conversation_transcript: ctx.conversationTranscript.slice(0, 8_000),
        source_urls: ctx.sourceUrls,
        retrieval_count: ctx.retrievalCount,
        retrieval_path: ctx.retrievalPath,
        product_slugs: ctx.pkProductSlugs.length > 0 ? ctx.pkProductSlugs : undefined,
        use_case_tags: ctx.pkRouteTags.length > 0 ? ctx.pkRouteTags : undefined,
        ...(ctx.analyticsProduct ? { recommended_product: ctx.analyticsProduct } : {}),
      },
    });
    ctx.problemClassification = await classifyProblemTypeWithLlm(ctx.searchQuery, locale);

    // ÔöÇÔöÇ LLM-as-a-Judge (fire-and-forget background evaluation) ÔöÇÔöÇ
    if (ctx.assistantMsgId) {
      const judgeInput: JudgeInput = {
        messageId: ctx.assistantMsgId,
        sessionId,
        userQuery: ctx.queryForRetrieval,
        assistantReply: ctx.answer,
        contextChunks: ctx.contextChunksForJudge,
        searchQuery: ctx.searchQuery,
        intent: ctx.extractedMeta.intent,
        metadataExtracted: ctx.extractedMeta,
        retrievalPath: ctx.retrievalPath,
        ...(ctx.pkProductSlugs.length > 0 ? { productSlugs: ctx.pkProductSlugs } : {}),
        ...(ctx.pkRouteTags.length > 0 ? { useCaseTags: ctx.pkRouteTags } : {}),
      };
      scheduleJudgeEvaluation(judgeInput);
    }

    fireAndForget(
      logQuery({
        sessionId,
        locale,
        audience: ctx.audience,
        fluidType: ctx.extractedMeta.fluid ?? ctx.fluid,
        query: ctx.searchQuery,
        responseMs: Date.now() - startedAt,
        status: "success",
      }),
      "logQuery.success",
    );
    fireAndForget(
      logProductAnalytics({
        sessionId,
        locale,
        audience: ctx.audience,
        query: ctx.searchQuery,
        recommendedProduct: ctx.analyticsProduct,
        amazonUrl: ctx.analyticsAmazonUrl,
        problemType: ctx.problemClassification.problemType,
        status: "success",
      }),
      "logProductAnalytics.success",
    );
    fireAndForget(
      logProblemEvent({
        sessionId,
        locale,
        audience: ctx.audience,
        geoCountry: ctx.effectiveGeoCountry,
        problemType: ctx.problemClassification.problemType,
        confidence: ctx.problemClassification.confidence,
        method: ctx.problemClassification.method,
      }),
      "logProblemEvent.success",
    );

    sseWriteWithSession(
      res,
      sessionId,
      {
        done: true,
        audience: ctx.audience,
        handoff: ctx.handoff,
        responseMs: Date.now() - startedAt,
        geoCountry: ctx.effectiveGeoCountry,
        messageId: ctx.assistantMsgId,
      },
      "done",
    );
    res.end();
}
