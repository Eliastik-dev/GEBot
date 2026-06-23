// @ts-nocheck
﻿import type { Request, Response } from "express";
import { buildEnrichedSearchQuery, dynamicRerank, hasExhaustProductInNodes, isAutomotiveExhaustContext } from "../../dynamic-reranker.js";
import { runDiagnosticAnalysis, type DiagnosticAnalysis } from "../../intent-extractor.js";
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
} from "../../services/product-knowledge.service.js";
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

export async function resolveSessionContext(ctx: ChatPipelineBindings): Promise<void> {
  if (ctx.completed) return;
  const { req, res, deps, startedAt, body, message, locale, profileFromMetadata, sessionId, geoConsentFromBody, geoCountryFromBody } = ctx;

    console.log("[/api/chat] incoming", {
      sessionId,
      locale,
      message: isProduction() ? `${message.slice(0, 120)}ÔÇª` : message,
      profile: body.profile ?? null,
      geoConsent: geoConsentFromBody ?? null,
      geoCountry: geoCountryFromBody,
    });
    startSse(res);
    sseWriteWithSession(res, sessionId, { status: "searching", sessionId, locale }, "status");
    ctx.ttftElapsed = Date.now() - startedAt;
    if (ctx.ttftElapsed > TTFT_TARGET_MS) {
      console.warn("[/api/chat] TTFT target exceeded before retrieval", { sessionId, ttftElapsed: ctx.ttftElapsed });
    }
    ctx.sessionContext = await ensureSession(sessionId, locale, geoConsentFromBody, geoCountryFromBody);
    ctx.persistedAudience = ctx.sessionContext.audience;
    ctx.detectedAudience = detectAudience(message);
    ctx.audience = profileFromMetadata ?? ctx.detectedAudience ?? ctx.persistedAudience;
    ctx.audienceForPersistence = profileFromMetadata ?? ctx.detectedAudience;
    ctx.effectiveGeoCountry = geoCountryFromBody ?? ctx.sessionContext.geoCountry;
    ctx.effectiveGeoConsent = geoConsentFromBody ?? ctx.sessionContext.geoConsent;
    ctx.allowFrenchStandards = ctx.effectiveGeoConsent === true && ctx.effectiveGeoCountry === "FR";
    ctx.disallowFrenchStandards = !ctx.allowFrenchStandards;
    ctx.handoff = buildHandoff(locale, ctx.audience);
    if (ctx.audienceForPersistence) {
      await updateSessionAudience(sessionId, ctx.audienceForPersistence, locale);
    }

    await saveMessage(sessionId, "user", message);
    ctx.historyMessages = await loadRecentMessages(sessionId);
    /** Only for analytics on paths that return before ctx.clarificationContext exists */
    ctx.fluidHint = extractFluid(message);
    ctx.yesNo = isYesNoAnswer(message);
    ctx.previousAssistant = [...ctx.historyMessages].reverse().find((row) => row.role === "assistant");
    ctx.previousUserContext = 
      [...ctx.historyMessages]
        .reverse()
        .find((row) => row.role === "user" && !isYesNoAnswer(row.content) && !isProfileOnlyMessage(row.content) && !isThemeOnlyMessage(row.content))?.content ??
      "";

    if (!ctx.audience) {
      const onboardingQuestion = ONBOARDING_QUESTION_BY_LOCALE[locale];
      startSse(res);
      sseWriteWithSession(res, sessionId, { delta: onboardingQuestion, sessionId }, "chunk");
      await saveMessage(sessionId, "assistant", onboardingQuestion);
      fireAndForget(
        logQuery({
        sessionId,
        locale,
        audience: null,
        fluidType: ctx.fluidHint,
        query: message,
        responseMs: Date.now() - startedAt,
        status: "awaiting_profile",
        }),
        "logQuery.awaiting_profile",
      );
      sseWriteWithSession(res, sessionId, { done: true, sessionId, geoCountry: ctx.effectiveGeoCountry }, "done");
      ctx.completed = true;
    res.end();
    return;
    }

    if (hasOngoingConversation(ctx.historyMessages) && isGratitudeOrClosingMessage(message)) {
      const response = buildGratitudeReply(locale, ctx.audience);
      startSse(res);
      sseWriteWithSession(res, sessionId, { delta: response, sessionId, audience: ctx.audience }, "chunk");
      await saveMessage(sessionId, "assistant", response);
      fireAndForget(
        logQuery({
          sessionId,
          locale,
          audience: ctx.audience,
          fluidType: ctx.fluidHint,
          query: message,
          responseMs: Date.now() - startedAt,
          status: "gratitude_closing",
        }),
        "logQuery.gratitude_closing",
      );
      sseWriteWithSession(res, sessionId, { done: true, sessionId, audience: ctx.audience, handoff: ctx.handoff, geoCountry: ctx.effectiveGeoCountry }, "done");
      ctx.completed = true;
    res.end();
    return;
    }

    ctx.sessionDiscussedProduct = getLastDiscussedProductFromHistory(ctx.historyMessages);
    ctx.sessionDiscussedSlug = getLastDiscussedProductSlugFromHistory(ctx.historyMessages);
    ctx.purchaseFollowUp = 
      hasOngoingConversation(ctx.historyMessages) &&
      ctx.sessionDiscussedProduct &&
      isPurchaseAvailabilityQuestion(message);

    if (ctx.purchaseFollowUp) {
      const pkLocalePurchase = productKnowledgeLocale(locale);
      let purchaseProduct: ProductKnowledgeRow | null = null;
      if (ctx.sessionDiscussedSlug) {
        purchaseProduct = await getProductKnowledgeBySlug(ctx.sessionDiscussedSlug, pkLocalePurchase).catch(() => null);
      }
      if (!purchaseProduct) {
        const cited = await lookupCatalogProductsByCitation({
          locale: pkLocalePurchase,
          userQuery: ctx.sessionDiscussedProduct!,
          audience: ctx.audience,
          limit: 1,
        }).catch(() => []);
        purchaseProduct = cited[0] ?? null;
      }
      const productLabel = purchaseProduct?.canonical_name ?? ctx.sessionDiscussedProduct!;
      const productSlug = purchaseProduct?.slug ?? ctx.sessionDiscussedSlug;
      const recommendation = resolveAmazonRecommendation("", locale, productLabel, productSlug);
      const resellers = locale === "pl" ? [] : await getCachedResellers().catch(() => []);
      const resellerSection = locale === "pl" ? "" : buildResellerSection(locale, resellers);
      const amazonSection = buildAmazonSection(locale, recommendation);
      const response = [buildPurchaseAvailabilityIntro(locale, productLabel), amazonSection, resellerSection]
        .filter(Boolean)
        .join("\n\n");
      sseWriteWithSession(res, sessionId, { delta: response, sessionId, audience: ctx.audience }, "chunk");
      await saveMessage(sessionId, "assistant", response, {
        response_context: {
          recommended_product: productLabel,
          ...(productSlug ? { product_slugs: [productSlug] } : {}),
        },
      });
      fireAndForget(
        logQuery({
          sessionId,
          locale,
          audience: ctx.audience,
          fluidType: ctx.fluidHint,
          query: message,
          responseMs: Date.now() - startedAt,
          status: "purchase_availability_short",
        }),
        "logQuery.purchase_availability_short",
      );
      fireAndForget(
        logProductAnalytics({
          sessionId,
          locale,
          audience: ctx.audience,
          query: message,
          recommendedProduct: recommendation.productName,
          amazonUrl: recommendation.amazonUrl,
          problemType: "purchase",
          status: "purchase_availability_short",
        }),
        "logProductAnalytics.purchase_availability_short",
      );
      sseWriteWithSession(
        res,
        sessionId,
        { done: true, audience: ctx.audience, handoff: ctx.handoff, geoCountry: ctx.effectiveGeoCountry },
        "done",
      );
      ctx.completed = true;
    res.end();
    return;
    }

    if (ctx.yesNo && ctx.previousAssistant && isComplementaryQuestion(ctx.previousAssistant.content)) {
      const followUp = buildComplementaryFollowUp(locale, ctx.yesNo, ctx.previousUserContext);
      const amazonSection = buildAmazonSection(locale, {
        productName: null,
        amazonUrl: getAmazonDefaultUrl(locale, null),
      });
      const response = [followUp, amazonSection].filter(Boolean).join("\n\n");
      startSse(res);
      sseWriteWithSession(res, sessionId, { delta: response, sessionId, audience: ctx.audience }, "chunk");
      await saveMessage(sessionId, "assistant", response);
      fireAndForget(
        logQuery({
          sessionId,
          locale,
          audience: ctx.audience,
          fluidType: ctx.fluidHint,
          query: message,
          responseMs: Date.now() - startedAt,
          status: ctx.yesNo === "yes" ? "complementary_yes" : "complementary_no",
        }),
        "logQuery.complementary",
      );
      sseWriteWithSession(res, sessionId, { done: true, sessionId, audience: ctx.audience, handoff: ctx.handoff, geoCountry: ctx.effectiveGeoCountry }, "done");
      ctx.completed = true;
    res.end();
    return;
    }

    if (locale !== "pl" && isResellerIntent(message)) {
      const resellers = await getCachedResellers().catch(() => []);
      const resellerSection = buildResellerSection(locale, resellers);
      const fallbackMessageByLocale: Record<Locale, string> = {
        fr: "Je ne parviens pas a recuperer les revendeurs pour le moment.",
        en: "I cannot retrieve reseller data right now.",
        nl: "Ik kan de lijst met resellers momenteel niet ophalen.",
        pl: "Nie moge teraz pobrac listy sprzedawcow.",
      };
      const amazonSection = buildAmazonSection(locale, {
        productName: null,
        amazonUrl: getAmazonDefaultUrl(locale, null),
      });
      const response = [resellerSection || fallbackMessageByLocale[locale], amazonSection].filter(Boolean).join("\n\n");
      startSse(res);
      sseWriteWithSession(res, sessionId, { delta: response, sessionId, audience: ctx.audience }, "chunk");
      await saveMessage(sessionId, "assistant", response);
      fireAndForget(
        logQuery({
          sessionId,
          locale,
          audience: ctx.audience,
          fluidType: ctx.fluidHint,
          query: message,
          responseMs: Date.now() - startedAt,
          status: resellerSection ? "reseller_success" : "reseller_unavailable",
        }),
        "logQuery.reseller",
      );
      sseWriteWithSession(res, sessionId, { done: true, sessionId, audience: ctx.audience, handoff: ctx.handoff, geoCountry: ctx.effectiveGeoCountry }, "done");
      ctx.completed = true;
    res.end();
    return;
    }

    if (ctx.detectedAudience && isProfileOnlyMessage(message)) {
      const followUp = THEME_QUESTION_BY_LOCALE[locale];
      startSse(res);
      sseWriteWithSession(res, sessionId, { delta: followUp, sessionId, audience: ctx.audience, showThemeReplies: true }, "chunk");
      await saveMessage(sessionId, "assistant", followUp);
      fireAndForget(
        logQuery({
        sessionId,
        locale,
        audience: ctx.audience,
        fluidType: ctx.fluidHint,
        query: message,
        responseMs: Date.now() - startedAt,
        status: "profile_set",
        }),
        "logQuery.profile_set",
      );
      sseWriteWithSession(res, sessionId, { done: true, sessionId, audience: ctx.audience, handoff: ctx.handoff, geoCountry: ctx.effectiveGeoCountry }, "done");
      ctx.completed = true;
    res.end();
    return;
    }

    ctx.detectedTheme = detectTheme(message);
    ctx.sessionTheme = await getSessionTheme(sessionId);
    ctx.themeFromBody = VALID_THEMES.includes(body.theme as ProductTheme) ? (body.theme as ProductTheme) : null;
    ctx.explicitTheme = ctx.themeFromBody ?? ctx.sessionTheme;
    ctx.effectiveTheme = ctx.themeFromBody ?? ctx.detectedTheme ?? ctx.sessionTheme;

    if (ctx.detectedTheme && isThemeOnlyMessage(message)) {
      await updateSessionTheme(sessionId, ctx.detectedTheme);
      const followUp = NEXT_QUESTION_AFTER_THEME[locale];
      startSse(res);
      sseWriteWithSession(res, sessionId, { delta: followUp, sessionId, audience: ctx.audience, theme: ctx.detectedTheme }, "chunk");
      await saveMessage(sessionId, "assistant", followUp);
      fireAndForget(
        logQuery({
        sessionId,
        locale,
        audience: ctx.audience,
        fluidType: ctx.fluidHint,
        query: message,
        responseMs: Date.now() - startedAt,
        status: "theme_set",
        }),
        "logQuery.theme_set",
      );
      sseWriteWithSession(res, sessionId, { done: true, sessionId, audience: ctx.audience, theme: ctx.detectedTheme, handoff: ctx.handoff, geoCountry: ctx.effectiveGeoCountry }, "done");
      ctx.completed = true;
    res.end();
    return;
    }

    if (isThemeUncertaintyMessage(message) && !ctx.effectiveTheme) {
      const reply = buildThemeUncertaintyReply(locale);
      startSse(res);
      sseWriteWithSession(res, sessionId, { delta: reply, sessionId, audience: ctx.audience, showThemeReplies: true }, "chunk");
      await saveMessage(sessionId, "assistant", reply);
      fireAndForget(
        logQuery({
          sessionId,
          locale,
          audience: ctx.audience,
          fluidType: ctx.fluidHint,
          query: message,
          responseMs: Date.now() - startedAt,
          status: "theme_uncertainty",
        }),
        "logQuery.theme_uncertainty",
      );
      sseWriteWithSession(res, sessionId, { done: true, sessionId, audience: ctx.audience, handoff: ctx.handoff, geoCountry: ctx.effectiveGeoCountry }, "done");
      ctx.completed = true;
    res.end();
    return;
    }

    ctx.specificClarification = getSpecificClarification(message, locale);
    if (ctx.specificClarification) {
      console.log("[/api/chat] specific_clarification", { sessionId, message });
      startSse(res);
      sseWriteWithSession(res, sessionId, { delta: ctx.specificClarification, sessionId, audience: ctx.audience }, "chunk");
      await saveMessage(sessionId, "assistant", ctx.specificClarification);
      fireAndForget(
        logQuery({
        sessionId,
        locale,
        audience: ctx.audience,
        fluidType: ctx.fluidHint,
        query: message,
        responseMs: Date.now() - startedAt,
        status: "specific_clarification_required",
        }),
        "logQuery.specific_clarification_required",
      );
      sseWriteWithSession(res, sessionId, { done: true, sessionId, audience: ctx.audience, handoff: ctx.handoff, geoCountry: ctx.effectiveGeoCountry }, "done");
      ctx.completed = true;
    res.end();
    return;
    }

    ctx.jointPasteContext = resolveJointPasteClarificationContext(message, ctx.historyMessages);
    ctx.legacyClarificationContext = resolveClarificationContext(message, ctx.historyMessages);
    ctx.clarificationContext = ctx.jointPasteContext ?? ctx.legacyClarificationContext;
    ctx.effectiveQuery = ctx.clarificationContext
      ? ctx.jointPasteContext
        ? `${ctx.jointPasteContext.effectiveQuestion}\n${message.trim()}`.trim()
        : `${ctx.legacyClarificationContext!.effectiveQuestion}\n${message.trim()}`.trim()
      : message;
    ctx.fluid = 
      ctx.jointPasteContext?.parsedFluid.metadataFluid ??
      ctx.legacyClarificationContext?.fluid ??
      extractFluid(message);
    ctx.queryForRetrieval = enrichRetrievalQuery(ctx.effectiveQuery, ctx.historyMessages, message);
    ctx.expandedRetrievalQuery = 
      ctx.purchaseFollowUp || (ctx.sessionDiscussedProduct && isProductFollowUpQuestion(message, ctx.historyMessages))
        ? ctx.queryForRetrieval.trim()
        : await expandRetrievalQueryWithLlm(ctx.queryForRetrieval, ctx.historyMessages, locale);
    if (ctx.expandedRetrievalQuery !== ctx.queryForRetrieval.trim()) {
      console.log("[/api/chat] retrieval_query_expanded", {
        sessionId,
        before: ctx.queryForRetrieval.slice(0, 80),
        after: ctx.expandedRetrievalQuery.slice(0, 160),
      });
    }
    if (ctx.queryForRetrieval !== ctx.effectiveQuery.trim()) {
      console.log("[/api/chat] retrieval_query_enriched", {
        sessionId,
        wasThin: true,
        queryForRetrievalPreview: ctx.queryForRetrieval.slice(0, 160),
      });
    }
}
