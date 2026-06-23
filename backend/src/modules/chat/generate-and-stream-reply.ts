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
import { answerProvidesProductGuidance, answerContradictsRecommendation, buildComplementaryFollowUp, buildComplementarySuggestion, buildDirectCitedProductReply, buildDirectTechnicalSheetReply, buildEscalationSection, buildGratitudeReply, buildHandoff, buildPurchaseAvailabilityIntro, buildResellerSection, buildMoreDetailsForProductRequest, buildPersonalDrinkwareOutOfScopeReply, compactProductFollowUpAnswer, containsOffTopicSink, extractComplementaryQuestionBlock, isComplementaryQuestion, isGratitudeOrClosingMessage, isResellerIntent, isYesNoAnswer, removeComplementaryQuestionBlocks, sanitizeDocumentationLinks, buildPipeGasClarification, hasStoreSection, stripAnswerWithoutProductRecommendation, stripContradictoryProductRecommendation, stripLeadingConversationGreeting } from "../../utils/response.js";
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
import { assertAfterRetrieval } from "./chat-pipeline-assertions.js";

export async function generateAndStreamReply(ctx: ChatPipelineBindings): Promise<void> {
  if (ctx.completed) return;
  assertAfterRetrieval(ctx);
  const { req, res, deps, startedAt, body, message, locale, profileFromMetadata, sessionId, geoConsentFromBody, geoCountryFromBody } = ctx;

    ctx.directSheetProduct = 
      (await lookupExplicitCatalogProductForSheet({
        locale: ctx.pkLocale,
        userQuery: ctx.effectiveQuery,
        contextQuery: ctx.queryForRetrieval,
        audience: ctx.audience,
      })) ??
      resolveDirectTechnicalSheetProduct(ctx.effectiveQuery, ctx.queryForRetrieval, ctx.pkResolvedProducts);
    ctx.citedRecommendation = 
      !ctx.directSheetProduct && !isExplicitProductLookupQuery(ctx.effectiveQuery)
        ? await lookupCitedCatalogProductForRecommendation({
            locale: ctx.pkLocale,
            userQuery: ctx.queryForRetrieval,
            audience: ctx.audience,
          })
        : null;
    ctx.directCitedProduct = 
      ctx.citedRecommendation ??
      (hasNamedProductCitation(ctx.effectiveQuery)
        ? resolveDirectCitedProduct(ctx.effectiveQuery, ctx.pkResolvedProducts)
        : null);
    if (ctx.directSheetProduct) {
      ctx.answer = buildDirectTechnicalSheetReply(locale, ctx.directSheetProduct, ctx.pkRenderContext);
      console.log("[/api/chat] direct_technical_sheet", {
        sessionId,
        slug: ctx.directSheetProduct.slug,
        name: ctx.directSheetProduct.canonical_name,
      });
      sseWriteWithSession(res, sessionId, { delta: ctx.answer, sessionId, audience: ctx.audience }, "chunk");
    } else if (ctx.directCitedProduct) {
      ctx.answer = buildDirectCitedProductReply(locale, ctx.directCitedProduct, ctx.pkRenderContext);
      console.log("[/api/chat] direct_cited_product", {
        sessionId,
        slug: ctx.directCitedProduct.slug,
        name: ctx.directCitedProduct.canonical_name,
      });
      sseWriteWithSession(res, sessionId, { delta: ctx.answer, sessionId, audience: ctx.audience }, "chunk");
    } else {
    try {
      console.log("Calling Mistral...", { sessionId });
      ctx.answer = await queryWithRetryAndFallback({
        index: deps.index,
        retriever: ctx.retrieverForAnswer,
        fullQuery: ctx.fullQuery,
        sessionId,
        audience: ctx.audience,
        locale,
        res,
      });
    } catch (err) {
      const generationError = err instanceof Error ? err.message : "Unknown generation error";
      console.error("[/api/chat] mistral_generation_error", { sessionId, error: generationError });
      console.error("DETAILED ERROR:", err);
      fireAndForget(
        logQuery({
        sessionId,
        locale,
        audience: ctx.audience,
        fluidType: ctx.fluid,
        query: ctx.searchQuery,
        responseMs: Date.now() - startedAt,
        status: "generation_error",
        }),
        "logQuery.generation_error",
      );
      if (!res.headersSent) {
        res.status(500).json(safeErrorPayload(generationError, err));
      } else {
        const escalation = buildEscalationSection(locale, ctx.audience);
        if (escalation) {
          sseWriteWithSession(res, sessionId, { delta: escalation, sessionId, audience: ctx.audience }, "chunk");
        }
        sseWriteWithSession(res, sessionId, { ...safeErrorPayload(generationError, err) }, "error");
        sseWriteWithSession(res, sessionId, { done: true, sessionId, audience: ctx.audience }, "done");
        res.end();
      }
      ctx.completed = true;
      return;
    }
    }

    console.log("[/api/chat] mistral_response", {
      sessionId,
      answerLength: ctx.answer.length,
      preview: ctx.answer.slice(0, 160),
    });

    if (!ctx.answer.trim()) {
      ctx.answer = getGenericNoAnswerFallback(locale);
      sseWriteWithSession(res, sessionId, { delta: ctx.answer, sessionId, audience: ctx.audience }, "chunk");
    }

    ctx.answer = stripLeadingConversationGreeting(ctx.answer, ctx.ongoingConversation);
    ctx.contradictedBefore = answerContradictsRecommendation(ctx.answer);
    ctx.answer = stripContradictoryProductRecommendation(ctx.answer);
    if (ctx.contradictedBefore) {
      console.warn("[/api/chat] contradictory_recommendation_stripped", { sessionId });
      sseWriteWithSession(res, sessionId, { replaceContent: ctx.answer, sessionId, audience: ctx.audience }, "chunk");
    }
    if (ctx.productFollowUp && ctx.priorRecommendedProduct) {
      ctx.answer = compactProductFollowUpAnswer(ctx.answer, ctx.priorRecommendedProduct);
    }
    ctx.answer = sanitizeDocumentationLinks(ctx.answer);
    if (containsCompetitorBrandMention(ctx.answer)) {
      console.warn("[/api/chat] competitor_brand_redacted", { sessionId });
      ctx.answer = sanitizeCompetitorBrandMentions(ctx.answer, locale);
      sseWriteWithSession(res, sessionId, { replaceContent: ctx.answer, sessionId, audience: ctx.audience }, "chunk");
    }

    if (containsOffTopicSink(ctx.answer, ctx.queryForRetrieval)) {
      ctx.answer = buildPipeGasClarification(locale);
      sseWriteWithSession(res, sessionId, { delta: `\n\n${ctx.answer}`, sessionId, audience: ctx.audience }, "chunk");
    }

    ctx.answer = removeComplementaryQuestionBlocks(ctx.answer);

    ctx.extractedProduct = extractRecommendedProduct(ctx.answer);
    ctx.validProductRecommended = ctx.productFollowUp ? false : hasValidRecommendedProduct(ctx.answer);
    let analyticsProduct: string | null = null;
    ctx.analyticsAmazonUrl = "";

    if (!ctx.validProductRecommended) {
      const stripped = stripAnswerWithoutProductRecommendation(removeAmazonSections(ctx.answer));
      const moreDetails =
        ctx.productFollowUp || answerProvidesProductGuidance(ctx.answer)
          ? ""
          : buildMoreDetailsForProductRequest(locale, ctx.audience, message);
      ctx.answer = [stripped, moreDetails].filter(Boolean).join("\n\n");
      sseWriteWithSession(res, sessionId, { replaceContent: ctx.answer, sessionId, audience: ctx.audience }, "chunk");
      console.log("[/api/chat] no_product_recommendation", {
        sessionId,
        extractedProduct: ctx.extractedProduct,
        retrievalCount: ctx.retrievalCount,
        productSlugs: ctx.pkProductSlugs,
      });
    } else {
      const productHint = getProductHintFromNodes(ctx.resolvedNodes, ctx.extractedProduct);
      const productSlugHint = getProductSlugHintFromNodes(ctx.resolvedNodes, ctx.extractedProduct);
      const recommendation = resolveAmazonRecommendation(ctx.answer, locale, productHint, productSlugHint);
      ctx.analyticsProduct = recommendation.productName;
      ctx.analyticsAmazonUrl = recommendation.amazonUrl;
      const resellers = locale === "pl" ? [] : await ctx.resellerPromise;
      const resellerSection = locale === "pl" ? "" : buildResellerSection(locale, resellers);
      const amazonSection = recommendation.productName
        ? buildAmazonSection(locale, recommendation)
        : buildAmazonSection(locale, { productName: null, amazonUrl: getAmazonDefaultUrl(locale, null) });
      const mistralHadAmazon = hasAmazonSection(ctx.answer);
      const strippedAnswer = removeAmazonSections(ctx.answer);
      ctx.answer = `${strippedAnswer}\n\n${amazonSection}`.trim();
      if (!mistralHadAmazon) {
        sseWriteWithSession(res, sessionId, { delta: `\n\n${amazonSection}`, sessionId, audience: ctx.audience }, "chunk");
      }
      console.log("[/api/chat] amazon_resolution", {
        sessionId,
        extractedProduct: ctx.extractedProduct,
        productHint,
        productSlugHint,
        finalAmazonUrl: recommendation.amazonUrl,
        hadAmazonSection: mistralHadAmazon,
        hadFallbackSearchUrl: hasFallbackAmazonSearchUrl(strippedAnswer),
      });
      if (resellerSection && !hasStoreSection(ctx.answer) && locale !== "pl") {
        ctx.answer += `\n\n${resellerSection}`;
        sseWriteWithSession(res, sessionId, { delta: `\n\n${resellerSection}`, sessionId, audience: ctx.audience }, "chunk");
      }
    }

    ctx.extractedComplementary = extractComplementaryQuestionBlock(ctx.answer);
    ctx.answer = ctx.extractedComplementary.cleaned;
    ctx.complementaryContext = `${ctx.queryForRetrieval}\n${message}`.trim();
    ctx.upsell = 
      ctx.productFollowUp
        ? null
        : ctx.extractedComplementary.question ?? buildComplementarySuggestion(locale, ctx.audience, ctx.complementaryContext);
    if (ctx.upsell && !isComplementaryQuestion(ctx.answer)) {
      const withUpsell = `\n\n${ctx.upsell.trim()}`;
      ctx.answer += withUpsell;
      sseWriteWithSession(res, sessionId, { delta: withUpsell, sessionId, audience: ctx.audience }, "chunk");
    }
}
