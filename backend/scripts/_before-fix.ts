import type { Request, Response } from "express";
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
} from "../../src/modules/retrieval/product-knowledge/index.js";
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
import { answerProvidesProductGuidance, answerContradictsRecommendation, buildComplementaryFollowUp, buildComplementarySuggestion, buildDirectCitedProductReply, buildDirectTechnicalSheetReply, buildEscalationSection, buildGratitudeReply, buildHandoff, buildPurchaseAvailabilityIntro, buildResellerSection, buildMoreDetailsForProductRequest, buildPersonalDrinkwareOutOfScopeReply, compactProductFollowUpAnswer, containsOffTopicSink, extractComplementaryQuestionBlock, isComplementaryQuestion, isGratitudeOrClosingMessage, isResellerIntent, isYesNoAnswer, removeComplementaryQuestionBlocks, sanitizeDocumentationLinks, buildPipeGasClarification, hasStoreSection, stripAnswerWithoutProductRecommendation, stripContradictoryProductRecommendation, stripLeadingConversationGreeting } from "../../src/utils/response/index.js";
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
import { buildAnswerCacheKey, filterRetrievalNodesByFeedbackPenalties } from "./chat-helpers.js";

export async function runRetrievalPipeline(ctx: ChatPipelineBindings): Promise<void> {
  if (ctx.completed) return;
  const { req, res, deps, startedAt, body, message, locale, profileFromMetadata, sessionId, geoConsentFromBody, geoCountryFromBody } = ctx;

    // ÔöÇÔöÇ ML-based Intent & Metadata Extraction (replaces legacy regex gates) ÔöÇÔöÇ
    ctx.preAnalysisTranscript = buildPreAnalysisTranscript(ctx.historyMessages, message);
    ctx.userCitationScanText = buildUserCitationScanText(ctx.historyMessages, message);
    ctx.citationScanText = `${preAnalysisTranscript}\n${message}`;
    const diagnosticResult: DiagnosticAnalysis = await runDiagnosticAnalysis(
      ctx.preAnalysisTranscript,
      locale,
      message,
    );
    ctx.extractedMeta = { ...diagnosticResult.metadata };
    if (ctx.jointPasteContext) {
      ctx.extractedMeta.fluid = ctx.jointPasteContext.parsedFluid.metadataFluid;
      ctx.extractedMeta.missing_params = ctx.extractedMeta.missing_params.filter((p) => p !== "joint_service_fluid");
      if (ctx.extractedMeta.missing_params.length === 0) {
        ctx.extractedMeta.needs_clarification = false;
      }
      const pollutantSynonym =
        /desembou|inhibiteur|\bg3\b|g70|embouage|radiateur|collafeu|gebsoplast|colle\s+pvc|detecteur|debouch/i;
      ctx.extractedMeta.synonyms = ctx.extractedMeta.synonyms.filter((s) => !pollutantSynonym.test(s));
    }
    ctx.descalingPollutant = 
      /fuite|colmat|patch|reparation_fuite|collafeu|propfeu|tresse|desembou|embouage|inhibiteur|\bg3\b/i;
    if (hasDescalingContext(`${preAnalysisTranscript}\n${message}`)) {
      ctx.extractedMeta.synonyms = ctx.extractedMeta.synonyms.filter((s) => !ctx.descalingPollutant.test(s));
    }
    console.log("[/api/chat] intent_extraction", {
      sessionId,
      intent: ctx.extractedMeta.intent,
      method: ctx.extractedMeta.method,
      confidence: ctx.extractedMeta.confidence,
      needs_clarification: ctx.extractedMeta.needs_clarification,
      missing_params: ctx.extractedMeta.missing_params,
    });

    ctx.conversationFull = `${preAnalysisTranscript}\n${message}`;
    if (
      ctx.extractedMeta.needs_clarification &&
      (isBuildingSurfaceSealingContext(ctx.conversationFull) || isBuildingEnvelopeLeakContext(ctx.conversationFull)) &&
      ctx.extractedMeta.missing_params.every((p) =>
        ["fluid", "joint_service_fluid"].includes(p),
      )
    ) {
      ctx.extractedMeta.needs_clarification = false;
      ctx.extractedMeta.missing_params = [];
      ctx.extractedMeta.fluid = null;
      if (
        ["leak_repair", "pipe_repair", "inaccessible_leak", "general_technical", "silicone_application"].includes(
          ctx.extractedMeta.intent,
        )
      ) {
        ctx.extractedMeta.intent = "sealing_assembly";
      }
      console.log("[/api/chat] building_envelope_bypass", { sessionId, intent: ctx.extractedMeta.intent });
    }

    if (
      ctx.extractedMeta.needs_clarification &&
      hasHeatingCircuitContext(ctx.conversationFull) &&
      ctx.extractedMeta.missing_params.every((p) => p === "joint_service_fluid" || p === "fluid")
    ) {
      ctx.extractedMeta.needs_clarification = false;
      ctx.extractedMeta.missing_params = [];
      if (!ctx.extractedMeta.fluid) ctx.extractedMeta.fluid = "chauffage";
      if (/\b(universel|plus\s+universel|alternative|compar)\b/i.test(message)) {
        ctx.extractedMeta.intent = "product_info";
        ctx.extractedMeta.synonyms = [
          ...new Set([...extractedMeta.synonyms, "G110", "inhibiteur universel", "universel"]),
        ];
      }
      console.log("[/api/chat] heating_circuit_clarification_bypass", { sessionId, intent: ctx.extractedMeta.intent });
    }

    if (isPersonalDrinkwareOutOfCatalog(ctx.conversationFull)) {
      const drinkwareReply = buildPersonalDrinkwareOutOfScopeReply(locale, ctx.audience);
      const escalationSection = buildEscalationSection(locale, ctx.audience);
      const drinkwareResponse = [drinkwareReply, escalationSection].filter(Boolean).join("\n\n");
      const drinkwareHandoff = buildHandoff(locale, ctx.audience);
      startSse(res);
      sseWriteWithSession(res, sessionId, { delta: drinkwareResponse, sessionId,audience: ctx.audience}, "chunk");
      await saveMessage(sessionId, "assistant", drinkwareResponse, {
        metadata_extracted: ctx.extractedMeta,
        intent: ctx.extractedMeta.intent,
      });
      fireAndForget(
        logQuery({
          sessionId,
          locale,
          audience: ctx.audience,
          fluidType: "eau",
          query: message,
          responseMs: Date.now() - startedAt,
          status: "out_of_catalog_drinkware",
        }),
        "logQuery.out_of_catalog_drinkware",
      );
      sseWriteWithSession(
        res,
        sessionId,
        { done: true, ctx.audience, handoff: drinkwareHandoff, geoCountry: ctx.effectiveGeoCountry },
        "done",
      );
      ctx.completed = true;
    res.end();
    return;
    }

    ctx.pkLocaleEarly = productKnowledgeLocale(locale);
    ctx.catalogSizeEarly = await countProductKnowledge(ctx.pkLocaleEarly).catch(() => 0);
    ctx.catalogCitation = 
      env.PRODUCT_KNOWLEDGE_ENABLED && ctx.catalogSizeEarly > 0
        ? await detectCatalogProductCitations({
            locale: ctx.pkLocaleEarly,
            text: ctx.userCitationScanText,
            ctx.audience,
            limit: env.PRODUCT_KNOWLEDGE_MAX_PRODUCTS,
          }).catch(() => ({ products: [], best: null, bestScore: 0 }))
        : { products: [], best: null, bestScore: 0 };
    ctx.hasCatalogCitation = ctx.catalogCitation.products.length > 0;
    ctx.explicitProductTargeted = 
      ctx.hasCatalogCitation ||
      isExplicitProductTargeted([ctx.citationScanText, ctx.effectiveQuery, message, ctx.queryForRetrieval]);
    ctx.citeNorm = ctx.citationScanText
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    if (
      ctx.hasCatalogCitation &&
      (isFactualProductQuestion(ctx.citationScanText) || ctx.catalogCitation.bestScore >= EXPLICIT_PRODUCT_MATCH_MIN)
    ) {
      ctx.extractedMeta.needs_clarification = false;
      ctx.extractedMeta.missing_params = [];
      if (isFactualProductQuestion(ctx.citationScanText)) ctx.extractedMeta.intent = "product_info";
      if (!ctx.extractedMeta.material && /\bpvc\b/.test(ctx.citeNorm)) ctx.extractedMeta.material = "pvc";
      if (!ctx.extractedMeta.pressure && /\bsous\s+pression\b/.test(ctx.citeNorm)) ctx.extractedMeta.pressure = "pressurized";
      if (!ctx.extractedMeta.fluid && /\b(canalisation|tuyau|eau|potable)\b/.test(ctx.citeNorm)) {
        if (!isBuildingSurfaceSealingContext(ctx.citationScanText)) {
          ctx.extractedMeta.fluid = "eau";
        }
      }
      console.log("[/api/chat] catalog_citation_bypass", {
        sessionId,
        slugs: ctx.catalogCitation.products.map((p) => p.slug),
        bestScore: ctx.catalogCitation.bestScore,
        factual: isFactualProductQuestion(ctx.citationScanText),
      });
    }

    ctx.vectorRagLite = resolveVectorRagLite(ctx.catalogSizeEarly);

    // Build search query enriched with synonyms and technical terms from metadata.
    // When a theme filter is active, use theme-aware enrichment and suppress ctx.fluid
    // terms that pollute automotive queries (e.g. "eau potable").
    ctx.metadataForSearch = 
      ctx.effectiveTheme === "automobile" ? { ...extractedMeta, fluid: null } : ctx.extractedMeta;
    ctx.retrievalQueryBase = ctx.expandedRetrievalQuery || ctx.queryForRetrieval;
    ctx.searchQuery = ctx.effectiveTheme
      ? buildThemeAwareSearchQuery(
          buildEnrichedSearchQuery(
            buildSearchQuery(ctx.retrievalQueryBase, ctx.metadataForSearch.fluid ?? ctx.fluid),
            metadataForSearch: ctx.metadataForSearch,
            { lite: ctx.vectorRagLite },
          ),
          effectiveTheme: ctx.effectiveTheme,
        )
      : buildEnrichedSearchQuery(
          buildSearchQuery(ctx.retrievalQueryBase, ctx.extractedMeta.fluid ?? ctx.fluid),
          extractedMeta: ctx.extractedMeta,
          { lite: ctx.vectorRagLite },
        );

    if (
      ctx.extractedMeta.needs_clarification &&
      diagnosticResult.clarification_message &&
      !ctx.hasCatalogCitation
    ) {
      const informationalQuestion =
        isInformationalProductQuestion(ctx.queryForRetrieval) ||
        isInformationalProductQuestion(message) ||
        isInformationalProductQuestion(ctx.effectiveQuery);
      let faqPreMatch: Awaited<ReturnType<typeof searchFaqKnowledgeMatch>> | null = null;

      if (informationalQuestion) {
        ctx.extractedMeta.needs_clarification = false;
        ctx.extractedMeta.missing_params = ctx.extractedMeta.missing_params.filter(
          (p) => !["fluid", "diameter", "pressure", "joint_service_fluid"].includes(p),
        );
        if (ctx.extractedMeta.missing_params.length === 0) {
          ctx.extractedMeta.needs_clarification = false;
        }
        if (["leak_repair", "pipe_repair", "inaccessible_leak", "sealing_assembly"].includes(ctx.extractedMeta.intent)) {
          ctx.extractedMeta.intent = "general_technical";
        }
        console.log("[/api/chat] informational_clarification_bypass", {
          sessionId,
          intent: ctx.extractedMeta.intent,
          missing_params: ctx.extractedMeta.missing_params,
        });
      } else {
        faqPreMatch = await searchFaqKnowledgeMatch(deps.index, ctx.queryForRetrieval, locale).catch(() => null);
        if (faqPreMatch?.matched) {
          ctx.extractedMeta.needs_clarification = false;
          ctx.extractedMeta.missing_params = [];
          if (ctx.extractedMeta.intent === "unknown") ctx.extractedMeta.intent = "general_technical";
          console.log("[/api/chat] faq_clarification_bypass", {
            sessionId,
            topScore: faqPreMatch.topScore,
            chunks: faqPreMatch.nodes.length,
          });
        }
      }

      if (ctx.extractedMeta.needs_clarification) {
      const response = diagnosticResult.clarification_message;
      startSse(res);
      sseWriteWithSession(res, sessionId, { delta: response, sessionId,audience: ctx.audience}, "chunk");
      ctx.assistantMsgId = await saveMessage(sessionId, "assistant", response, {
        metadata_extracted: ctx.extractedMeta,
        intent: ctx.extractedMeta.intent,
      });
      fireAndForget(
        logQuery({
          sessionId,
          locale,
          audience: ctx.audience,
          fluidType: ctx.extractedMeta.fluid ?? ctx.fluid,
          query: message,
          responseMs: Date.now() - startedAt,
          status: "diagnostic_clarification",
        }),
        "logQuery.diagnostic_clarification",
      );
      sseWriteWithSession(
        res,
        sessionId,
        { done: true, ctx.audience, ctx.handoff, geoCountry: ctx.effectiveGeoCountry, messageId: ctx.assistantMsgId },
        "done",
      );
      ctx.completed = true;
    res.end();
    return;
      }
    }

    ctx.informationalRetrievalQuestion = 
      isInformationalProductQuestion(ctx.queryForRetrieval) ||
      isInformationalProductQuestion(message) ||
      isInformationalProductQuestion(ctx.effectiveQuery);
    let faqContextNodes: unknown[] = [];

    ctx.ongoingConversationEarly = hasOngoingConversation(ctx.historyMessages);
    ctx.feedbackCorrection = resolveAnyProductCorrectionContext(ctx.historyMessages, message);

    if (
      ctx.feedbackCorrection &&
      env.PRODUCT_KNOWLEDGE_ENABLED &&
      ctx.catalogSizeEarly > 0
    ) {
      const correctionCitation = await detectCatalogProductCitations({
        locale: ctx.pkLocaleEarly,
        text: message,
        ctx.audience,
        limit: 3,
      });
      const correctionProduct =
        correctionCitation.best ??
        (await lookupCitedCatalogProductForRecommendation({
          locale: ctx.pkLocaleEarly,
          userQuery: resolveProductCitationQuery(message, message),
          ctx.audience,
        }));
      if (correctionProduct) {
        console.log("[/api/chat] feedback_product_correction", {
          sessionId,
          slug: correctionProduct.slug,
          trainingQuery: ctx.feedbackCorrection.trainingQuery.slice(0, 120),
          penalizedSlugs: ctx.feedbackCorrection.dislikedProductSlugs,
        });
        ctx.extractedMeta.needs_clarification = false;
        ctx.extractedMeta.missing_params = [];
        ctx.extractedMeta.intent = "product_info";
        const resellerPromiseCorrection =
          locale === "pl" ? Promise.resolve<Reseller[]>([]) : getCachedResellers().catch(() => []);
        const cacheKeyCorrection = `${ANSWER_CACHE_VERSION}|${locale}|${audience}|${effectiveTheme ?? "none"}|fb:${feedbackCorrection.trainingQuery.toLowerCase()}|${correctionProduct.slug}`;
        await deliverDirectTechnicalSheetTurn({
          res,
          sessionId,
          locale,
          audience: ctx.audience,
          handoff: ctx.handoff,
          geoCountry: ctx.effectiveGeoCountry,
          product: correctionProduct,
          extractedMeta: ctx.extractedMeta,
          queryForRetrieval: ctx.feedbackCorrection.trainingQuery,
          trainingQuery: ctx.feedbackCorrection.trainingQuery,
          cacheKey: cacheKeyCorrection,
          startedAt,
          resellerPromise: resellerPromiseCorrection,
          ongoingConversation: ctx.ongoingConversationEarly,
          buildReply: buildDirectCitedProductReply,
          logStatus: "direct_cited_product",
          sessionTheme: ctx.effectiveTheme,
        });
        return;
      }
    }

    if (
      env.PRODUCT_KNOWLEDGE_ENABLED &&
      ctx.catalogSizeEarly > 0 &&
      isExplicitProductLookupQuery(ctx.effectiveQuery)
    ) {
      const directSheetProductEarly = await lookupExplicitCatalogProductForSheet({
        locale: ctx.pkLocaleEarly,
        userQuery: ctx.effectiveQuery,
        contextQuery: ctx.queryForRetrieval,
        audience: ctx.audience,
      });
      if (directSheetProductEarly) {
        console.log("[/api/chat] direct_technical_sheet_early", {
          sessionId,
          slug: directSheetProductEarly.slug,
          name: directSheetProductEarly.canonical_name,
        });
        const resellerPromiseEarly =
          locale === "pl" ? Promise.resolve<Reseller[]>([]) : getCachedResellers().catch(() => []);
        const cacheKeyEarly = `${ANSWER_CACHE_VERSION}|${locale}|${audience}|${effectiveTheme ?? "none"}|${queryForRetrieval.toLowerCase()}`;
        await deliverDirectTechnicalSheetTurn({
          res,
          sessionId,
          locale,
          audience: ctx.audience,
          handoff: ctx.handoff,
          geoCountry: ctx.effectiveGeoCountry,
          product: directSheetProductEarly,
          extractedMeta: ctx.extractedMeta,
          queryForRetrieval: ctx.queryForRetrieval,
          cacheKey: cacheKeyEarly,
          startedAt,
          resellerPromise: resellerPromiseEarly,
          ongoingConversation: ctx.ongoingConversationEarly,
          sessionTheme: ctx.effectiveTheme,
        });
        return;
      }
    }

    if (
      env.PRODUCT_KNOWLEDGE_ENABLED &&
      ctx.catalogSizeEarly > 0 &&
      !isExplicitProductLookupQuery(ctx.effectiveQuery) &&
      !isFactualProductQuestion(ctx.citationScanText) &&
      !isThemeUncertaintyMessage(message)
    ) {
      const productCitationQuery = resolveProductCitationQuery(message, ctx.queryForRetrieval);
      const strongUserProductCitation =
        ctx.hasCatalogCitation &&
        ctx.catalogCitation.best != null &&
        computeExplicitProductMatchScore(ctx.catalogCitation.best, [message]) >=
          EXPLICIT_PRODUCT_NAME_PRIORITY_MIN;
      const citedProductEarly =
        (strongUserProductCitation && productCitationQuery === message.trim()
          ? ctx.catalogCitation.best
          : null) ??
        (await lookupCitedCatalogProductForRecommendation({
          locale: ctx.pkLocaleEarly,
          userQuery: productCitationQuery,
          audience: ctx.audience,
        }));
      if (citedProductEarly) {
        console.log("[/api/chat] direct_cited_product_early", {
          sessionId,
          slug: citedProductEarly.slug,
          name: citedProductEarly.canonical_name,
        });
        const resellerPromiseEarly =
          locale === "pl" ? Promise.resolve<Reseller[]>([]) : getCachedResellers().catch(() => []);
        const cacheKeyEarly = `${ANSWER_CACHE_VERSION}|${locale}|${audience}|${effectiveTheme ?? "none"}|${queryForRetrieval.toLowerCase()}`;
        await deliverDirectTechnicalSheetTurn({
          res,
          sessionId,
          locale,
          audience: ctx.audience,
          handoff: ctx.handoff,
          geoCountry: ctx.effectiveGeoCountry,
          product: citedProductEarly,
          extractedMeta: ctx.extractedMeta,
          queryForRetrieval: ctx.queryForRetrieval,
          cacheKey: cacheKeyEarly,
          startedAt,
          resellerPromise: resellerPromiseEarly,
          ongoingConversation: ctx.ongoingConversationEarly,
          buildReply: buildDirectCitedProductReply,
          logStatus: "direct_cited_product",
          sessionTheme: ctx.effectiveTheme,
        });
        return;
      }
    }

    ctx.resellerPromise = locale === "pl" ? Promise.resolve<Reseller[]>([]) : getCachedResellers().catch(() => []);

    ctx.history = toHistoryPrompt(ctx.historyMessages);
    ctx.ongoingConversation = hasOngoingConversation(ctx.historyMessages);
    ctx.priorRecommendedProduct = ctx.sessionDiscussedProduct;
    ctx.productFollowUp = isProductFollowUpQuestion(message, ctx.historyMessages);
    ctx.compatibilitySpecQuestion = isCompatibilitySpecQuestion(ctx.queryForRetrieval);
    if (
      ctx.productFollowUp ||
      ctx.compatibilitySpecQuestion ||
      (hasNamedProductCitation(message) && isInformationalProductQuestion(ctx.queryForRetrieval))
    ) {
      ctx.extractedMeta.missing_params = ctx.extractedMeta.missing_params.filter(
        (p) => !["fluid", "diameter", "pressure", "joint_service_fluid"].includes(p),
      );
      if (ctx.extractedMeta.missing_params.length === 0) {
        ctx.extractedMeta.needs_clarification = false;
      }
    }
    ctx.baseFilters = [{ key: "locale", value: locale, operator: "==" as const }];
    ctx.applyThemeHardFilter = Boolean(ctx.effectiveTheme) && !ctx.explicitProductTargeted;
    ctx.themeFilters = 
      ctx.applyThemeHardFilter && ctx.effectiveTheme
        ? [{ key: "theme", value: ctx.effectiveTheme, operator: "==" as const }]
        : [];
    ctx.policyFilters = ctx.allowFrenchStandards
      ? []
      : [{ key: "regulatory_scope", value: "GLOBAL", operator: "==" as const }];
    ctx.preFilters = ctx.applyThemeHardFilter
      ? {
          filters: [...baseFilters, ...themeFilters, ...policyFilters],
          condition: "and" as const,
        }
      : ctx.audience
        ? {
            filters: [...baseFilters, { key: "audience", value: ctx.audience, operator: "==" as const }, ...policyFilters],
            condition: "and" as const,
          }
        : {
            filters: [...baseFilters, ...policyFilters],
            condition: "and" as const,
          };
    if (ctx.explicitProductTargeted && ctx.effectiveTheme) {
      console.log("[/api/chat] soft_theme_filter", {
        sessionId,
        theme: ctx.effectiveTheme,
        catalogCitationSlugs: ctx.catalogCitation.products.map((p) => p.slug),
      });
    }

    ctx.pkLocale = ctx.pkLocaleEarly;
    ctx.catalogSize = ctx.catalogSizeEarly;
    let resolvedNodes: unknown[] = [];
    let retrievalPath: "product_knowledge" | "vector_rag" = "vector_rag";
    ctx.retrievalCount = 0;
    ctx.preTechnicalFilterCount = 0;
    let pkRouteTags: string[] = [];
    let pkProductSlugs: string[] = [];
    let pkResolvedProducts: ProductKnowledgeRow[] = [...catalogCitation.products];
    ctx.pkRenderContext = { sessionAudience: ctx.audience, sessionTheme: ctx.effectiveTheme, locale };

    ctx.feedbackQuery = 
      ctx.productFollowUp || ctx.purchaseFollowUp
        ? message.trim()
        : `${queryForRetrieval}\n${searchQuery}`.trim();
    ctx.feedbackCtx = await resolveFeedbackRetrievalContext(ctx.feedbackQuery, locale, sessionId).catch(
      () => ({
        boostSlugs: [] as string[],
        sessionBoostSlugs: [] as string[],
        penalizeSlugs: [] as string[],
        sessionPenalizeSlugs: [] as string[],
        crossSessionPenalizeSlugs: [] as string[],
        crossSessionBoostSlugs: [] as string[],
        goldenExamples: [] as Array<{ userQuery: string; assistantReply: string }>,
        negativeExamples: [] as Array<{
          userQuery: string;
          productSlugs: string[];
          retrievalPath: string | null;
          recommendedProduct: string | null;
        }>,
      }),
    );
    ctx.feedbackAdjustments = {
      boostSlugs: ctx.feedbackCtx.boostSlugs,
      sessionBoostSlugs: ctx.feedbackCtx.sessionBoostSlugs,
      penalizeSlugs: ctx.feedbackCtx.penalizeSlugs,
      sessionPenalizeSlugs: ctx.feedbackCtx.sessionPenalizeSlugs,
      crossSessionPenalizeSlugs: ctx.feedbackCtx.crossSessionPenalizeSlugs,
      crossSessionBoostSlugs: ctx.feedbackCtx.crossSessionBoostSlugs,
    };
    ctx.feedbackHardPenalties = hardPenalizeSlugs(ctx.feedbackAdjustments);
    ctx.feedbackHardBoosts = hardBoostSlugs(ctx.feedbackAdjustments);
    ctx.allPenalizedSlugs = [
      ...new Set([
        ...feedbackCtx.penalizeSlugs,
        ...feedbackHardPenalties,
      ]),
    ];
    if (
      ctx.feedbackCtx.boostSlugs.length > 0 ||
      ctx.feedbackCtx.sessionBoostSlugs.length > 0 ||
      ctx.feedbackCtx.crossSessionBoostSlugs.length > 0 ||
      ctx.feedbackCtx.penalizeSlugs.length > 0 ||
      ctx.feedbackCtx.sessionPenalizeSlugs.length > 0 ||
      ctx.feedbackCtx.crossSessionPenalizeSlugs.length > 0 ||
      ctx.feedbackCtx.goldenExamples.length > 0 ||
      ctx.feedbackCtx.negativeExamples.length > 0
    ) {
      console.log("[/api/chat] feedback_retrieval", {
        sessionId,
        boost: ctx.feedbackCtx.boostSlugs,
        sessionBoost: ctx.feedbackCtx.sessionBoostSlugs,
        crossSessionBoost: ctx.feedbackCtx.crossSessionBoostSlugs,
        penalize: ctx.feedbackCtx.penalizeSlugs,
        sessionPenalize: ctx.feedbackCtx.sessionPenalizeSlugs,
        crossSessionPenalize: ctx.feedbackCtx.crossSessionPenalizeSlugs,
        golden: ctx.feedbackCtx.goldenExamples.length,
        negative: ctx.feedbackCtx.negativeExamples.length,
      });
    }

    ctx.cacheKey = buildAnswerCacheKey(
      locale,
      audience: ctx.audience,
      effectiveTheme: ctx.effectiveTheme,
      queryForRetrieval: ctx.queryForRetrieval,
      allPenalizedSlugs: ctx.allPenalizedSlugs,
      feedbackHardBoosts: ctx.feedbackHardBoosts,
    );
    ctx.cached = answerCache.get(ctx.cacheKey);
    ctx.cachedContainsDeprecatedStoreLink = 
      ctx.cached?.value.includes("amazon.fr/stores/") || ctx.cached?.value.includes("amazon.nl/stores/");
    if (ctx.cached && ctx.cached.expiresAt > Date.now() && !ctx.cachedContainsDeprecatedStoreLink) {
      const recommendation = resolveAmazonRecommendation(ctx.cached.value, locale);
      const productType = await classifyProblemTypeWithLlm(ctx.searchQuery, locale);
      startSse(res);
      sseWriteWithSession(res, sessionId, { delta: ctx.cached.value, sessionId,audience: ctx.audience}, "chunk");
      await saveMessage(sessionId, "assistant", ctx.cached.value);
      fireAndForget(
        logQuery({
          sessionId,
          locale,
          audience: ctx.audience,
          fluidType: ctx.fluid,
          query: ctx.queryForRetrieval,
          responseMs: Date.now() - startedAt,
          status: "cache_hit",
        }),
        "logQuery.cache_hit",
      );
      fireAndForget(
        logProductAnalytics({
          sessionId,
          locale,
          ctx.audience,
          query: ctx.queryForRetrieval,
          recommendedProduct: recommendation.productName,
          amazonUrl: recommendation.amazonUrl,
          problemType: productType.problemType,
          status: "cache_hit",
        }),
        "logProductAnalytics.cache_hit",
      );
      sseWriteWithSession(res, sessionId, { done: true, sessionId,audience: ctx.audience,handoff: ctx.handoff, geoCountry: ctx.effectiveGeoCountry }, "done");
      ctx.completed = true;
    res.end();
    return;
    }

    ctx.factualProductMode = 
      isFactualProductQuestion(ctx.citationScanText) && ctx.catalogCitation.best != null;

    if (env.PRODUCT_KNOWLEDGE_ENABLED && ctx.catalogSize > 0) {
      if (ctx.factualProductMode) {
        pkResolvedProducts = filterProductKnowledgeByQueryContext(
          filterProductKnowledgeByPenalties(
            ctx.catalogCitation.best ? [ctx.catalogCitation.best] : ctx.catalogCitation.products.slice(0, 1),
            ctx.feedbackCtx.sessionPenalizeSlugs,
            ctx.feedbackCtx.penalizeSlugs,
            ctx.feedbackCtx.crossSessionPenalizeSlugs,
          ),
          ctx.queryForRetrieval,
          ctx.effectiveTheme,
        );
        pkResolvedProducts = await injectFeedbackBoostProducts(
          pkResolvedProducts,
          ctx.feedbackHardBoosts,
          ctx.pkLocale,
        );
        pkProductSlugs = pkResolvedProducts.map((p) => p.slug);
        resolvedNodes = buildRetrieverNodesFromProductKnowledge(pkResolvedProducts, ctx.pkRenderContext);
        retrievalPath = "product_knowledge";
        ctx.retrievalCount = resolvedNodes.length;
        ctx.preTechnicalFilterCount = ctx.retrievalCount;
        console.log("[/api/chat] factual_catalog_citation_route", {
          sessionId,
          slugs: pkProductSlugs,
          best: ctx.catalogCitation.best?.canonical_name,
          bestScore: ctx.catalogCitation.bestScore,
        });
      } else {
        const pkRoute = await routeProductKnowledge({
          locale,
          query: ctx.retrievalQueryBase,
          searchQuery: ctx.searchQuery,
          userQuery: ctx.effectiveQuery,
          theme: ctx.effectiveTheme,
          metadata: ctx.extractedMeta,
          limit: env.PRODUCT_KNOWLEDGE_MAX_PRODUCTS,
          audience: ctx.audience,
          feedbackAdjustments: ctx.feedbackAdjustments,
        });
        pkRouteTags = pkRoute.tags;
        pkResolvedProducts = filterProductKnowledgeByQueryContext(
          filterProductKnowledgeByPenalties(
            pkRoute.products,
            ctx.feedbackCtx.sessionPenalizeSlugs,
            ctx.feedbackCtx.penalizeSlugs,
            ctx.feedbackCtx.crossSessionPenalizeSlugs,
          ),
          queryForRetrieval: ctx.queryForRetrieval,
          effectiveTheme: ctx.effectiveTheme,
        );
        pkResolvedProducts = await injectFeedbackBoostProducts(
          pkResolvedProducts,
          feedbackHardBoosts: ctx.feedbackHardBoosts,
          pkLocale: ctx.pkLocale,
        );
        if (pkResolvedProducts.length > 0) {
          pkProductSlugs = pkResolvedProducts.map((p) => p.slug);
          resolvedNodes = buildRetrieverNodesFromProductKnowledge(pkResolvedProducts, ctx.pkRenderContext);
          retrievalPath = "product_knowledge";
          ctx.retrievalCount = resolvedNodes.length;
          ctx.preTechnicalFilterCount = ctx.retrievalCount;
          console.log("[/api/chat] product_knowledge_route", {
            sessionId,
            catalogSize: ctx.catalogSize,
            retrievalCount: ctx.retrievalCount,
            slugs: pkProductSlugs,
            resolvedTags: pkRouteTags,
            productTags: pkResolvedProducts.flatMap((p) => p.use_case_tags),
            feedbackBoost: ctx.feedbackHardBoosts,
          });
          const debugNodes = pkResolvedProducts.map((p) => summarizeProductKnowledgeForDebug(p));
          console.log("[/api/chat] retrieval_debug_product_knowledge", {
            sessionId,
            query: ctx.searchQuery,
            debugNodes,
          });
        }
      }
    }

    if (retrievalPath === "vector_rag") {
      const retrievalPoolK = Math.max(env.TOP_K, Math.round(env.TOP_K * env.RETRIEVAL_POOL_MULTIPLIER));
      const retriever = deps.index.asRetriever({
        similarityTopK: retrievalPoolK,
        filters: ctx.preFilters,
      });
      console.log("Vector store initialized:", Boolean(deps.vectorStore));
      console.log("Starting vector search...", { sessionId, profileFilter: ctx.audience ?? "none", theme: ctx.effectiveTheme ?? "none", retrievalPoolK });
      const retrievedNodes = await withTimeout(
        retriever.retrieve(ctx.searchQuery),
        VECTOR_SEARCH_TIMEOUT_MS,
        "SUPABASE_VECTOR_SEARCH",
      );
      resolvedNodes = Array.isArray(retrievedNodes) ? retrievedNodes : [];
      ctx.retrievalCount = resolvedNodes.length;

      if ((ctx.retrievalCount < 3 || ctx.retrievalCount === 0) && ctx.effectiveTheme && ctx.applyThemeHardFilter) {
        console.log("[/api/chat] theme filter yielded few results, retrying without theme filter", { sessionId, theme: ctx.effectiveTheme,retrievalCount: ctx.retrievalCount});
        const noThemeFilters = {
          filters: [...baseFilters, ...policyFilters],
          condition: "and" as const,
        };
        const fallbackRetriever = deps.index.asRetriever({
          similarityTopK: retrievalPoolK,
          filters: noThemeFilters,
        });
        const fallbackNodes = await withTimeout(
          fallbackRetriever.retrieve(ctx.searchQuery),
          VECTOR_SEARCH_TIMEOUT_MS,
          "SUPABASE_VECTOR_SEARCH_FALLBACK",
        );
        if (Array.isArray(fallbackNodes) && fallbackNodes.length > ctx.retrievalCount) {
          resolvedNodes = fallbackNodes;
          ctx.retrievalCount = resolvedNodes.length;
        }
      }

      if (ctx.retrievalCount === 0 && ctx.audience) {
        const localeOnlyRetriever = deps.index.asRetriever({
          similarityTopK: retrievalPoolK,
          filters: {
            filters: [...baseFilters, ...policyFilters],
            condition: "and" as const,
          },
        });
        const localeNodes = await withTimeout(
          localeOnlyRetriever.retrieve(ctx.searchQuery),
          VECTOR_SEARCH_TIMEOUT_MS,
          "SUPABASE_VECTOR_SEARCH_LOCALE_ONLY",
        );
        resolvedNodes = Array.isArray(localeNodes) ? localeNodes : [];
        ctx.retrievalCount = resolvedNodes.length;
      }
      if (!ctx.allowFrenchStandards) {
        resolvedNodes = resolvedNodes.filter((item) => {
          const metadata = (item as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
          return metadata.regulatory_scope !== "FR";
        });
        ctx.retrievalCount = resolvedNodes.length;
      }

      if (
        !ctx.vectorRagLite &&
        isAutomotiveExhaustContext(ctx.queryForRetrieval, ctx.searchQuery) &&
        !hasExhaustProductInNodes(resolvedNodes)
      ) {
        console.log("[/api/chat] supplementing exhaust-specific retrieval", { sessionId });
        const supplementRetriever = deps.index.asRetriever({
          similarityTopK: 8,
          filters: {
            filters: [...baseFilters, ...policyFilters],
            condition: "and" as const,
          },
        });
        const supplementNodes = await withTimeout(
          supplementRetriever.retrieve(AUTOMOTIVE_EXHAUST_SUPPLEMENT_QUERY),
          VECTOR_SEARCH_TIMEOUT_MS,
          "SUPABASE_VECTOR_SEARCH_EXHAUST_SUPPLEMENT",
        );
        if (Array.isArray(supplementNodes) && supplementNodes.length > 0) {
          resolvedNodes = mergeRetrievalNodes(resolvedNodes, supplementNodes);
          ctx.retrievalCount = resolvedNodes.length;
        }
      }

      resolvedNodes = dynamicRerank(
        resolvedNodes,
        queryForRetrieval: ctx.queryForRetrieval,
        searchQuery: ctx.searchQuery,
        extractedMeta: ctx.extractedMeta,
        effectiveTheme: ctx.effectiveTheme,
        {
          lite: ctx.vectorRagLite,
          softThemeFilter: ctx.explicitProductTargeted,
          explicitProductSlugs: [
            ...new Set([
              ...catalogCitation.products.map((p) => p.slug),
              ...pkResolvedProducts.map((p) => p.slug),
            ]),
          ],
        },
      );
      resolvedNodes = filterRetrievalNodesByFeedbackPenalties(
        resolvedNodes,
        ctx.feedbackCtx.penalizeSlugs,
        feedbackHardPenalties: ctx.feedbackHardPenalties,
      );
      ctx.preTechnicalFilterCount = ctx.retrievalCount;

      const catalogAnchor = await searchProductKnowledge({
        locale: ctx.pkLocale,
        theme: ctx.effectiveTheme,
        tags: pkRouteTags,
        material: ctx.extractedMeta.material,
        fluid: ctx.extractedMeta.fluid,
        query: ctx.retrievalQueryBase,
        searchQuery: ctx.searchQuery,
        userQuery: ctx.effectiveQuery,
        limit: env.PRODUCT_KNOWLEDGE_MAX_PRODUCTS,
        audience: ctx.audience,
      }).catch(() => [] as Awaited<ReturnType<typeof searchProductKnowledge>>);

      if (catalogAnchor.length > 0) {
        const catalogNodes = buildRetrieverNodesFromProductKnowledge(catalogAnchor, ctx.pkRenderContext);
        const pdfNodes = resolvedNodes.filter((node) => {
          const meta = (node as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
          return meta.type !== "product_knowledge";
        });
        resolvedNodes = [...catalogNodes, ...pdfNodes];
        retrievalPath = "product_knowledge";
        pkProductSlugs = catalogAnchor.map((p) => p.slug);
        console.log("[/api/chat] catalog_anchor_over_pdf", {
          sessionId,
          slugs: pkProductSlugs,
          catalogBlocks: catalogNodes.length,
        });
      }

      if (ctx.preTechnicalFilterCount > 0) {
        const debugNodes = resolvedNodes.slice(0, 6).map((node) => summarizeNodeForDebug(node));
        console.log("[/api/chat] retrieval_debug_before_technical_filter", {
          sessionId,
          query: ctx.searchQuery,
          preTechnicalFilterCount: ctx.preTechnicalFilterCount,
          debugNodes,
        });
      }
      resolvedNodes = prioritizeTechnicalSheets(resolvedNodes);
      resolvedNodes = capContextNodes(resolvedNodes, env.DIAGNOSTIC_MAX_CONTEXT_NODES);
      ctx.retrievalCount = resolvedNodes.length;
    } else {
      ctx.retrievalCount = resolvedNodes.length;
    }

    ctx.pdfSupplementSlugs = ctx.factualProductMode
      ? pkProductSlugs.slice(0, 2)
      : [...new Set([...pkProductSlugs, ...catalogCitation.products.map((p) => p.slug)])].slice(0, 4);
    if (ctx.pdfSupplementSlugs.length > 0) {
      try {
        const pdfNodes = await retrievePdfChunksForSlugs(deps.index, ctx.pdfSupplementSlugs, ctx.pkLocale, {
          materialKeyword: ctx.extractedMeta.material,
          queryText: ctx.factualProductMode ? citationScanText : ctx.searchQuery,
        });
        if (pdfNodes.length > 0) {
          resolvedNodes = mergeRetrievalNodes(resolvedNodes, pdfNodes);
          resolvedNodes = prioritizeTechnicalSheets(resolvedNodes);
          resolvedNodes = capContextNodes(resolvedNodes, env.DIAGNOSTIC_MAX_CONTEXT_NODES);
          ctx.retrievalCount = resolvedNodes.length;
          console.log("[/api/chat] catalog_pdf_supplement", {
            sessionId,
            slugs: ctx.pdfSupplementSlugs,
            pdfChunks: pdfNodes.length,
            totalNodes: ctx.retrievalCount,
          });
        }
      } catch (err) {
        console.warn("[/api/chat] catalog_pdf_supplement_failed", { sessionId, err });
      }
    }

    if (ctx.informationalRetrievalQuestion || ctx.extractedMeta.intent === "general_technical") {
      faqContextNodes = await retrieveFaqKnowledgeChunks(deps.index, ctx.queryForRetrieval, locale, {
        topK: 6,
      }).catch(() => []);
      if (faqContextNodes.length > 0) {
        console.log("[/api/chat] faq_context_prefetch", {
          sessionId,
          chunks: faqContextNodes.length,
        });
      }
    }

    if (
      env.PRODUCT_KNOWLEDGE_ENABLED &&
      ctx.catalogSize > 0 &&
      ctx.hasCatalogCitation &&
      !ctx.factualProductMode
    ) {
      const citedProducts = ctx.catalogCitation.products;
      if (citedProducts.length > 0) {
        const citedNodes = buildRetrieverNodesFromProductKnowledge(citedProducts, ctx.pkRenderContext);
        resolvedNodes = mergeRetrievalNodes(citedNodes, resolvedNodes);
        pkResolvedProducts = [
          ...citedProducts,
          ...pkResolvedProducts.filter((p) => !citedProducts.some((c) => c.slug === p.slug)),
        ];
        pkProductSlugs = [...new Set([...citedProducts.map((p) => p.slug), ...pkProductSlugs])];
        retrievalPath = "product_knowledge";
        console.log("[/api/chat] cited_product_injected", {
          sessionId,
          slugs: citedProducts.map((p) => p.slug),
          message: message.slice(0, 80),
        });
      }
    }

    if (faqContextNodes.length > 0) {
      resolvedNodes = mergeRetrievalNodes(faqContextNodes, resolvedNodes);
      console.log("[/api/chat] faq_context_injected", {
        sessionId,
        chunks: faqContextNodes.length,
        totalNodes: resolvedNodes.length,
      });
    }

    resolvedNodes = prioritizeTechnicalSheets(resolvedNodes);
    resolvedNodes = capContextNodes(resolvedNodes, env.DIAGNOSTIC_MAX_CONTEXT_NODES);
    ctx.retrievalCount = resolvedNodes.length;

    console.log(`Context found: [${retrievalCount}]`, {
      sessionId,
      query: ctx.searchQuery,
      retrievalCount: ctx.retrievalCount,
      preTechnicalFilterCount: ctx.preTechnicalFilterCount,
      retrievalPath,
      vectorRagLite: ctx.vectorRagLite,
    });
    if (ctx.retrievalCount === 0) {
      const noContextReply = buildNoContextFallback(locale, ctx.queryForRetrieval, ctx.fluid);
      const resellers = locale === "pl" ? [] : await ctx.resellerPromise;
      const resellerSection = locale === "pl" ? "" : buildResellerSection(locale, resellers);
      const amazonSection = buildAmazonSection(locale, {
        productName: null,
        amazonUrl: getAmazonDefaultUrl(locale, null),
      });
      const escalationSection = buildEscalationSection(locale, ctx.audience);
      const noContextResponse = [noContextReply, amazonSection, resellerSection, escalationSection].filter(Boolean).join("\n\n");
      const noContextHandoff = buildHandoff(locale, ctx.audience);
      startSse(res);
      sseWriteWithSession(res, sessionId, { delta: noContextResponse, sessionId,audience: ctx.audience}, "chunk");
      await saveMessage(sessionId, "assistant", noContextResponse);
      const noContextClassification = await classifyProblemTypeWithLlm(ctx.searchQuery, locale);
      fireAndForget(
        logQuery({
          sessionId,
          locale,
          audience: ctx.audience,
          fluidType: ctx.fluid,
          query: ctx.searchQuery,
          responseMs: Date.now() - startedAt,
          status: "no_context",
        }),
        "logQuery.no_context",
      );
      fireAndForget(
        logProductAnalytics({
          sessionId,
          locale,
          ctx.audience,
          query: ctx.searchQuery,
          recommendedProduct: null,
          amazonUrl: getAmazonDefaultUrl(locale, null),
          problemType: noContextClassification.problemType,
          status: "no_context",
        }),
        "logProductAnalytics.no_context",
      );
      fireAndForget(
        logProblemEvent({
          sessionId,
          locale,
          ctx.audience,
          geoCountry: ctx.effectiveGeoCountry,
          problemType: noContextClassification.problemType,
          confidence: noContextClassification.confidence,
          method: noContextClassification.method,
        }),
        "logProblemEvent.no_context",
      );
      answerCache.set(ctx.cacheKey, {
        value: noContextResponse,
        expiresAt: Date.now() + env.QUERY_CACHE_TTL_MS,
      });
      sseWriteWithSession(res, sessionId, { done: true, sessionId,audience: ctx.audience, handoff: noContextHandoff, geoCountry: ctx.effectiveGeoCountry }, "done");
      ctx.completed = true;
    res.end();
    return;
    }

    ctx.sourceUrls = extractSourceUrlsFromNodes(resolvedNodes);
    ctx.conversationTranscript = buildPreAnalysisTranscript(ctx.historyMessages, message);
    ctx.goldenExamples = ctx.feedbackCtx.goldenExamples;
    ctx.negativeExamples = ctx.feedbackCtx.negativeExamples;
    ctx.retrieverForAnswer = deps.index.asRetriever({
      similarityTopK: env.TOP_K,
      filters: ctx.preFilters,
    });
    ctx.retrieverForAnswer.retrieve = async () => resolvedNodes as Awaited<ReturnType<typeof ctx.retrieverForAnswer.retrieve>>;
    ctx.catalogAnchorReminder = 
      retrievalPath === "product_knowledge"
        ? "\nSTRUCTURED_CATALOG_PRIORITY: Le catalogue structur├® guide le CHOIX du produit. Les extraits FT/FDS PDF sont la source pour compatibilit├® mat├®riaux/fluides/pressions ÔÇö en cas d'├®cart, suivre le PDF.\n"
        : "";
    ctx.comparisonEligible = 
      pkResolvedProducts.length >= 2 &&
      retrievalPath === "product_knowledge" &&
      !ctx.productFollowUp &&
      !ctx.hasCatalogCitation &&
      !isFactualProductQuestion(ctx.citationScanText);
    ctx.fullQuery = `${buildSystemPrompt(
      locale,
      audience,
      history,
      disallowFrenchStandards,
      extractedMeta,
      retrievalPath,
      goldenExamples,
      { geoCountry: effectiveGeoCountry, geoConsent: effectiveGeoConsent },
      negativeExamples,
      ongoingConversation,
      productFollowUp && priorRecommendedProduct ? { priorProduct: priorRecommendedProduct } : null,
      comparisonEligible
        ? { eligible: true, productCount: pkResolvedProducts.length }
        : null,
    )}${catalogAnchorReminder}

METADATA_PROFIL: ${toAudienceLabel(audience)}
LOCALE_SESSION: ${locale}
FLUID_TYPE: ${fluid ?? "inconnu"}
SEARCH_QUERY: ${searchQuery}
RETRIEVAL_PATH: ${retrievalPath}
FICHES_TECHNIQUES_PDF (use ONLY in "Documentation Officielle" section, NEVER as purchase/availability links):
${sourceUrls.length > 0 ? sourceUrls.map((url) => `- ${url}`).join("\n") : "- aucune"}

QUESTION UTILISATEUR: ${queryForRetrieval}
${productFollowUp && priorRecommendedProduct ? `\nTYPE_QUESTION: product_follow_up ÔÇö MODE 1 OBLIGATOIRE. Produit d├®j├á conseill├® : ${priorRecommendedProduct}. R├®ponds UNIQUEMENT ├á la nouvelle question en prose courte ; ne r├®p├¿te PAS la fiche produit ni les liens FT/FDS.` : ""}
${isFactualProductQuestion(citationScanText) && hasCatalogCitation ? "\nTYPE_QUESTION: factual_product ÔÇö MODE 1: r├®pondez factuellement (oui/non, limites) depuis FT/FDS du produit identifi├®. Ne pivotez pas vers un autre SKU." : ""}
${!productFollowUp && !isFactualProductQuestion(citationScanText) && !hasCatalogCitation && isInformationalProductQuestion(queryForRetrieval) ? "\nTYPE_QUESTION: informational_faq ÔÇö MODE 1: r├®ponds DIRECTEMENT ├á la question en prose naturelle avec les faits de la fiche." : ""}
${hasCatalogCitation && !isFactualProductQuestion(citationScanText) ? "\nTYPE_QUESTION: cited_product ÔÇö MODE 2 sur le produit catalogue identifi├® (profil/domaine ignor├®s si la fiche correspond)." : ""}
${comparisonEligible ? `\nTYPE_QUESTION: open_recommendation_comparison ÔÇö MODE 3 OBLIGATOIRE. ${pkResolvedProducts.length} produits catalogue r├®cup├®r├®s : comparez-les (Option A/B${pkResolvedProducts.length >= 3 ? "/C" : ""}) avec Avantages et Limites issus des champs catalogue ; ne recommandez pas un seul SKU.` : ""}
${formatNamedProductCitationPrompt(citationScanText, catalogCitation.best?.canonical_name)}

RAPPEL_DIAGNOSTIC: Les extraits peuvent melanger fiches techniques (TDS / limites d'application: pression, fluides, temperatures) et fiches de securite (SDS ou FDS / compatibilite chimique, dangers). Croiser les deux familles de documents uniquement lorsque leurs contenus sont presents dans les extraits ci-dessous.

Instruction finale: reponse courte ; cite au plus une URL source du contexte si disponible (lien seul, sans paragraphe sur la citation).`;
}
