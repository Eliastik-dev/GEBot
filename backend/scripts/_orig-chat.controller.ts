import type { Request, Response } from "express";
import { buildEnrichedSearchQuery, dynamicRerank, hasExhaustProductInNodes, isAutomotiveExhaustContext } from "../dynamic-reranker.js";
import { runDiagnosticAnalysis, type DiagnosticAnalysis } from "../intent-extractor.js";
import { ANSWER_CACHE_VERSION, answerCache, NEXT_QUESTION_AFTER_THEME, ONBOARDING_QUESTION_BY_LOCALE, THEME_QUESTION_BY_LOCALE, TTFT_TARGET_MS, VALID_THEMES, VECTOR_SEARCH_TIMEOUT_MS } from "../config/constants.js";
import { env } from "../config/env.js";
import { resolveVectorRagLite } from "../config/retrieval.js";
import {
  buildSystemPrompt,
  buildPreAnalysisTranscript,
  classifyProblemTypeWithLlm,
  expandRetrievalQueryWithLlm,
  queryWithRetryAndFallback,
} from "../services/ai.service.js";
import { hardBoostSlugs, hardPenalizeSlugs, resolveFeedbackRetrievalContext } from "../services/feedback-retrieval.service.js";
import { ensureSession, getSessionTheme, loadRecentMessages, logProblemEvent, logProductAnalytics, logQuery, saveMessage, updateSessionAudience, updateSessionTheme } from "../services/database.service.js";
import { scheduleJudgeEvaluation, type JudgeInput } from "../services/judge.service.js";
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
} from "../services/rag.service.js";
import { hasDescalingContext, hasHeatingCircuitContext, isBuildingEnvelopeLeakContext, isBuildingSurfaceSealingContext, isPersonalDrinkwareOutOfCatalog } from "../utils/diagnostic-rules.js";
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
} from "../src/modules/retrieval/product-knowledge/index.js";
import { deliverDirectTechnicalSheetTurn } from "../services/direct-sheet.service.js";
import {
  buildRetrieverNodesFromProductKnowledge,
  productKnowledgeLocale,
  routeProductKnowledge,
  summarizeProductKnowledgeForDebug,
} from "../services/product-router.service.js";
import type { Audience, ChatRequestBody, Locale, ProductTheme, Reseller } from "../types/index.js";
import type { ProductKnowledgeRow } from "../types/product-knowledge.js";
import { fireAndForget, withTimeout } from "../utils/async.js";
import { getAmazonDefaultUrl, getProductHintFromNodes, getProductSlugHintFromNodes, resolveAmazonRecommendation, extractRecommendedProduct, hasAmazonSection, hasFallbackAmazonSearchUrl, hasValidRecommendedProduct, removeAmazonSections, buildAmazonSection } from "../utils/amazon.js";
import { resolveAnyProductCorrectionContext, resolveProductCitationQuery, buildUserCitationScanText } from "../utils/feedback-correction.js";
import { detectAudience, detectTheme, getSpecificClarification, isProfileOnlyMessage, isThemeOnlyMessage, isThemeUncertaintyMessage, buildThemeUncertaintyReply, normalizeAudience, normalizeLocale } from "../utils/locale.js";
import { answerProvidesProductGuidance, answerContradictsRecommendation, buildComplementaryFollowUp, buildComplementarySuggestion, buildDirectCitedProductReply, buildDirectTechnicalSheetReply, buildEscalationSection, buildGratitudeReply, buildHandoff, buildPurchaseAvailabilityIntro, buildResellerSection, buildMoreDetailsForProductRequest, buildPersonalDrinkwareOutOfScopeReply, compactProductFollowUpAnswer, containsOffTopicSink, extractComplementaryQuestionBlock, isComplementaryQuestion, isGratitudeOrClosingMessage, isResellerIntent, isYesNoAnswer, removeComplementaryQuestionBlocks, sanitizeDocumentationLinks, buildPipeGasClarification, hasStoreSection, stripAnswerWithoutProductRecommendation, stripContradictoryProductRecommendation, stripLeadingConversationGreeting } from "../utils/response.js";
import {
  getLastDiscussedProductFromHistory,
  getLastDiscussedProductSlugFromHistory,
  isProductFollowUpQuestion,
  isPurchaseAvailabilityQuestion,
} from "../utils/conversation-context.js";
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
} from "../utils/product-mention.js";
import { containsCompetitorBrandMention, sanitizeCompetitorBrandMentions } from "../utils/brand-policy.js";
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
} from "../utils/text.js";
import { resolveJointPasteClarificationContext } from "../utils/joint-paste.js";
import { safeErrorPayload, isProduction } from "../utils/http.js";
import { getIncomingSessionId } from "../utils/session.js";
import { startSse, sseWriteWithSession } from "../utils/sse.js";
import type { chatBodySchema } from "../validation/schemas.js";
import type { VectorStoreIndex } from "llamaindex";
import type { z } from "zod";

type ValidatedChatBody = z.infer<typeof chatBodySchema>;

export type ChatDeps = { index: VectorStoreIndex; vectorStore: unknown };

function nodeSlugFromRetrievalItem(item: unknown): string {
  const metadata = (item as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
  return String(metadata.slug ?? "");
}

function filterRetrievalNodesByFeedbackPenalties(
  nodes: unknown[],
  penalizeSlugs: string[],
  hardPenalizeSlugsList: string[] = [],
): unknown[] {
  if (nodes.length === 0) return nodes;

  if (hardPenalizeSlugsList.length > 0) {
    const withoutHard = nodes.filter((item) => {
      const slug = nodeSlugFromRetrievalItem(item);
      if (!slug) return true;
      return !hardPenalizeSlugsList.some((target) => slug.includes(target) || target.includes(slug));
    });
    if (withoutHard.length > 0) return withoutHard;
  }

  if (penalizeSlugs.length === 0) return nodes;
  const filtered = nodes.filter((item) => {
    const slug = nodeSlugFromRetrievalItem(item);
    if (!slug) return true;
    return !penalizeSlugs.some((target) => slug.includes(target) || target.includes(slug));
  });
  return filtered.length > 0 ? filtered : nodes;
}

function buildAnswerCacheKey(
  locale: string,
  audience: Audience | null,
  theme: ProductTheme | null | undefined,
  queryForRetrieval: string,
  penaltySlugs: string[] = [],
  boostSlugs: string[] = [],
): string {
  const penaltyKey =
    penaltySlugs.length > 0 ? penaltySlugs.slice().sort().join("|") : "none";
  const boostKey = boostSlugs.length > 0 ? boostSlugs.slice().sort().join("|") : "none";
  return `${ANSWER_CACHE_VERSION}|${locale}|${audience}|${theme ?? "none"}|${queryForRetrieval.toLowerCase()}|pen:${penaltyKey}|boost:${boostKey}`;
}

export async function postChat(req: Request, res: Response, deps: ChatDeps) {
    const startedAt = Date.now();
    const body = req.body as ValidatedChatBody;
    const message = body.message;
    const locale = normalizeLocale(body.locale);
    const profileFromMetadata = normalizeAudience(body.profile ?? undefined);
    const sessionId = getIncomingSessionId(req, body as ChatRequestBody);
    const geoConsentFromBody = body.geoConsent;
    const geoCountryFromBody = body.geoCountry ?? null;

    try {
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
      const ttftElapsed = Date.now() - startedAt;
      if (ttftElapsed > TTFT_TARGET_MS) {
        console.warn("[/api/chat] TTFT target exceeded before retrieval", { sessionId, ttftElapsed });
      }
      const sessionContext = await ensureSession(sessionId, locale, geoConsentFromBody, geoCountryFromBody);
      const persistedAudience = sessionContext.audience;
      const detectedAudience = detectAudience(message);
      const audience = profileFromMetadata ?? detectedAudience ?? persistedAudience;
      const audienceForPersistence = profileFromMetadata ?? detectedAudience;
      const effectiveGeoCountry = geoCountryFromBody ?? sessionContext.geoCountry;
      const effectiveGeoConsent = geoConsentFromBody ?? sessionContext.geoConsent;
      const allowFrenchStandards = effectiveGeoConsent === true && effectiveGeoCountry === "FR";
      const disallowFrenchStandards = !allowFrenchStandards;
      const handoff = buildHandoff(locale, audience);
      if (audienceForPersistence) {
        await updateSessionAudience(sessionId, audienceForPersistence, locale);
      }

      await saveMessage(sessionId, "user", message);
      const historyMessages = await loadRecentMessages(sessionId);
      /** Only for analytics on paths that return before clarificationContext exists */
      const fluidHint = extractFluid(message);
      const yesNo = isYesNoAnswer(message);
      const previousAssistant = [...historyMessages].reverse().find((row) => row.role === "assistant");
      const previousUserContext =
        [...historyMessages]
          .reverse()
          .find((row) => row.role === "user" && !isYesNoAnswer(row.content) && !isProfileOnlyMessage(row.content) && !isThemeOnlyMessage(row.content))?.content ??
        "";

      if (!audience) {
        const onboardingQuestion = ONBOARDING_QUESTION_BY_LOCALE[locale];
        startSse(res);
        sseWriteWithSession(res, sessionId, { delta: onboardingQuestion, sessionId }, "chunk");
        await saveMessage(sessionId, "assistant", onboardingQuestion);
        fireAndForget(
          logQuery({
          sessionId,
          locale,
          audience: null,
          fluidType: fluidHint,
          query: message,
          responseMs: Date.now() - startedAt,
          status: "awaiting_profile",
          }),
          "logQuery.awaiting_profile",
        );
        sseWriteWithSession(res, sessionId, { done: true, sessionId, geoCountry: effectiveGeoCountry }, "done");
        res.end();
        return;
      }

      if (hasOngoingConversation(historyMessages) && isGratitudeOrClosingMessage(message)) {
        const response = buildGratitudeReply(locale, audience);
        startSse(res);
        sseWriteWithSession(res, sessionId, { delta: response, sessionId, audience }, "chunk");
        await saveMessage(sessionId, "assistant", response);
        fireAndForget(
          logQuery({
            sessionId,
            locale,
            audience,
            fluidType: fluidHint,
            query: message,
            responseMs: Date.now() - startedAt,
            status: "gratitude_closing",
          }),
          "logQuery.gratitude_closing",
        );
        sseWriteWithSession(res, sessionId, { done: true, sessionId, audience, handoff, geoCountry: effectiveGeoCountry }, "done");
        res.end();
        return;
      }

      const sessionDiscussedProduct = getLastDiscussedProductFromHistory(historyMessages);
      const sessionDiscussedSlug = getLastDiscussedProductSlugFromHistory(historyMessages);
      const purchaseFollowUp =
        hasOngoingConversation(historyMessages) &&
        sessionDiscussedProduct &&
        isPurchaseAvailabilityQuestion(message);

      if (purchaseFollowUp) {
        const pkLocalePurchase = productKnowledgeLocale(locale);
        let purchaseProduct: ProductKnowledgeRow | null = null;
        if (sessionDiscussedSlug) {
          purchaseProduct = await getProductKnowledgeBySlug(sessionDiscussedSlug, pkLocalePurchase).catch(() => null);
        }
        if (!purchaseProduct) {
          const cited = await lookupCatalogProductsByCitation({
            locale: pkLocalePurchase,
            userQuery: sessionDiscussedProduct!,
            audience,
            limit: 1,
          }).catch(() => []);
          purchaseProduct = cited[0] ?? null;
        }
        const productLabel = purchaseProduct?.canonical_name ?? sessionDiscussedProduct!;
        const productSlug = purchaseProduct?.slug ?? sessionDiscussedSlug;
        const recommendation = resolveAmazonRecommendation("", locale, productLabel, productSlug);
        const resellers = locale === "pl" ? [] : await getCachedResellers().catch(() => []);
        const resellerSection = locale === "pl" ? "" : buildResellerSection(locale, resellers);
        const amazonSection = buildAmazonSection(locale, recommendation);
        const response = [buildPurchaseAvailabilityIntro(locale, productLabel), amazonSection, resellerSection]
          .filter(Boolean)
          .join("\n\n");
        sseWriteWithSession(res, sessionId, { delta: response, sessionId, audience }, "chunk");
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
            audience,
            fluidType: fluidHint,
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
            audience,
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
          { done: true, audience, handoff, geoCountry: effectiveGeoCountry },
          "done",
        );
        res.end();
        return;
      }

      if (yesNo && previousAssistant && isComplementaryQuestion(previousAssistant.content)) {
        const followUp = buildComplementaryFollowUp(locale, yesNo, previousUserContext);
        const amazonSection = buildAmazonSection(locale, {
          productName: null,
          amazonUrl: getAmazonDefaultUrl(locale, null),
        });
        const response = [followUp, amazonSection].filter(Boolean).join("\n\n");
        startSse(res);
        sseWriteWithSession(res, sessionId, { delta: response, sessionId, audience }, "chunk");
        await saveMessage(sessionId, "assistant", response);
        fireAndForget(
          logQuery({
            sessionId,
            locale,
            audience,
            fluidType: fluidHint,
            query: message,
            responseMs: Date.now() - startedAt,
            status: yesNo === "yes" ? "complementary_yes" : "complementary_no",
          }),
          "logQuery.complementary",
        );
        sseWriteWithSession(res, sessionId, { done: true, sessionId, audience, handoff, geoCountry: effectiveGeoCountry }, "done");
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
        sseWriteWithSession(res, sessionId, { delta: response, sessionId, audience }, "chunk");
        await saveMessage(sessionId, "assistant", response);
        fireAndForget(
          logQuery({
            sessionId,
            locale,
            audience,
            fluidType: fluidHint,
            query: message,
            responseMs: Date.now() - startedAt,
            status: resellerSection ? "reseller_success" : "reseller_unavailable",
          }),
          "logQuery.reseller",
        );
        sseWriteWithSession(res, sessionId, { done: true, sessionId, audience, handoff, geoCountry: effectiveGeoCountry }, "done");
        res.end();
        return;
      }

      if (detectedAudience && isProfileOnlyMessage(message)) {
        const followUp = THEME_QUESTION_BY_LOCALE[locale];
        startSse(res);
        sseWriteWithSession(res, sessionId, { delta: followUp, sessionId, audience, showThemeReplies: true }, "chunk");
        await saveMessage(sessionId, "assistant", followUp);
        fireAndForget(
          logQuery({
          sessionId,
          locale,
          audience,
          fluidType: fluidHint,
          query: message,
          responseMs: Date.now() - startedAt,
          status: "profile_set",
          }),
          "logQuery.profile_set",
        );
        sseWriteWithSession(res, sessionId, { done: true, sessionId, audience, handoff, geoCountry: effectiveGeoCountry }, "done");
        res.end();
        return;
      }

      const detectedTheme = detectTheme(message);
      const sessionTheme = await getSessionTheme(sessionId);
      const themeFromBody = VALID_THEMES.includes(body.theme as ProductTheme) ? (body.theme as ProductTheme) : null;
      const explicitTheme = themeFromBody ?? sessionTheme;
      const effectiveTheme = themeFromBody ?? detectedTheme ?? sessionTheme;

      if (detectedTheme && isThemeOnlyMessage(message)) {
        await updateSessionTheme(sessionId, detectedTheme);
        const followUp = NEXT_QUESTION_AFTER_THEME[locale];
        startSse(res);
        sseWriteWithSession(res, sessionId, { delta: followUp, sessionId, audience, theme: detectedTheme }, "chunk");
        await saveMessage(sessionId, "assistant", followUp);
        fireAndForget(
          logQuery({
          sessionId,
          locale,
          audience,
          fluidType: fluidHint,
          query: message,
          responseMs: Date.now() - startedAt,
          status: "theme_set",
          }),
          "logQuery.theme_set",
        );
        sseWriteWithSession(res, sessionId, { done: true, sessionId, audience, theme: detectedTheme, handoff, geoCountry: effectiveGeoCountry }, "done");
        res.end();
        return;
      }

      if (isThemeUncertaintyMessage(message) && !effectiveTheme) {
        const reply = buildThemeUncertaintyReply(locale);
        startSse(res);
        sseWriteWithSession(res, sessionId, { delta: reply, sessionId, audience, showThemeReplies: true }, "chunk");
        await saveMessage(sessionId, "assistant", reply);
        fireAndForget(
          logQuery({
            sessionId,
            locale,
            audience,
            fluidType: fluidHint,
            query: message,
            responseMs: Date.now() - startedAt,
            status: "theme_uncertainty",
          }),
          "logQuery.theme_uncertainty",
        );
        sseWriteWithSession(res, sessionId, { done: true, sessionId, audience, handoff, geoCountry: effectiveGeoCountry }, "done");
        res.end();
        return;
      }

      const specificClarification = getSpecificClarification(message, locale);
      if (specificClarification) {
        console.log("[/api/chat] specific_clarification", { sessionId, message });
        startSse(res);
        sseWriteWithSession(res, sessionId, { delta: specificClarification, sessionId, audience }, "chunk");
        await saveMessage(sessionId, "assistant", specificClarification);
        fireAndForget(
          logQuery({
          sessionId,
          locale,
          audience,
          fluidType: fluidHint,
          query: message,
          responseMs: Date.now() - startedAt,
          status: "specific_clarification_required",
          }),
          "logQuery.specific_clarification_required",
        );
        sseWriteWithSession(res, sessionId, { done: true, sessionId, audience, handoff, geoCountry: effectiveGeoCountry }, "done");
        res.end();
        return;
      }

      const jointPasteContext = resolveJointPasteClarificationContext(message, historyMessages);
      const legacyClarificationContext = resolveClarificationContext(message, historyMessages);
      const clarificationContext = jointPasteContext ?? legacyClarificationContext;
      const effectiveQuery = clarificationContext
        ? jointPasteContext
          ? `${jointPasteContext.effectiveQuestion}\n${message.trim()}`.trim()
          : `${legacyClarificationContext!.effectiveQuestion}\n${message.trim()}`.trim()
        : message;
      const fluid =
        jointPasteContext?.parsedFluid.metadataFluid ??
        legacyClarificationContext?.fluid ??
        extractFluid(message);
      const queryForRetrieval = enrichRetrievalQuery(effectiveQuery, historyMessages, message);
      const expandedRetrievalQuery =
        purchaseFollowUp || (sessionDiscussedProduct && isProductFollowUpQuestion(message, historyMessages))
          ? queryForRetrieval.trim()
          : await expandRetrievalQueryWithLlm(queryForRetrieval, historyMessages, locale);
      if (expandedRetrievalQuery !== queryForRetrieval.trim()) {
        console.log("[/api/chat] retrieval_query_expanded", {
          sessionId,
          before: queryForRetrieval.slice(0, 80),
          after: expandedRetrievalQuery.slice(0, 160),
        });
      }
      if (queryForRetrieval !== effectiveQuery.trim()) {
        console.log("[/api/chat] retrieval_query_enriched", {
          sessionId,
          wasThin: true,
          queryForRetrievalPreview: queryForRetrieval.slice(0, 160),
        });
      }

      // ÔöÇÔöÇ ML-based Intent & Metadata Extraction (replaces legacy regex gates) ÔöÇÔöÇ
      const preAnalysisTranscript = buildPreAnalysisTranscript(historyMessages, message);
      const userCitationScanText = buildUserCitationScanText(historyMessages, message);
      const citationScanText = `${preAnalysisTranscript}\n${message}`;
      const diagnosticResult: DiagnosticAnalysis = await runDiagnosticAnalysis(
        preAnalysisTranscript,
        locale,
        message,
      );
      const extractedMeta = { ...diagnosticResult.metadata };
      if (jointPasteContext) {
        extractedMeta.fluid = jointPasteContext.parsedFluid.metadataFluid;
        extractedMeta.missing_params = extractedMeta.missing_params.filter((p) => p !== "joint_service_fluid");
        if (extractedMeta.missing_params.length === 0) {
          extractedMeta.needs_clarification = false;
        }
        const pollutantSynonym =
          /desembou|inhibiteur|\bg3\b|g70|embouage|radiateur|collafeu|gebsoplast|colle\s+pvc|detecteur|debouch/i;
        extractedMeta.synonyms = extractedMeta.synonyms.filter((s) => !pollutantSynonym.test(s));
      }
      const descalingPollutant =
        /fuite|colmat|patch|reparation_fuite|collafeu|propfeu|tresse|desembou|embouage|inhibiteur|\bg3\b/i;
      if (hasDescalingContext(`${preAnalysisTranscript}\n${message}`)) {
        extractedMeta.synonyms = extractedMeta.synonyms.filter((s) => !descalingPollutant.test(s));
      }
      console.log("[/api/chat] intent_extraction", {
        sessionId,
        intent: extractedMeta.intent,
        method: extractedMeta.method,
        confidence: extractedMeta.confidence,
        needs_clarification: extractedMeta.needs_clarification,
        missing_params: extractedMeta.missing_params,
      });

      const conversationFull = `${preAnalysisTranscript}\n${message}`;
      if (
        extractedMeta.needs_clarification &&
        (isBuildingSurfaceSealingContext(conversationFull) || isBuildingEnvelopeLeakContext(conversationFull)) &&
        extractedMeta.missing_params.every((p) =>
          ["fluid", "joint_service_fluid"].includes(p),
        )
      ) {
        extractedMeta.needs_clarification = false;
        extractedMeta.missing_params = [];
        extractedMeta.fluid = null;
        if (
          ["leak_repair", "pipe_repair", "inaccessible_leak", "general_technical", "silicone_application"].includes(
            extractedMeta.intent,
          )
        ) {
          extractedMeta.intent = "sealing_assembly";
        }
        console.log("[/api/chat] building_envelope_bypass", { sessionId, intent: extractedMeta.intent });
      }

      if (
        extractedMeta.needs_clarification &&
        hasHeatingCircuitContext(conversationFull) &&
        extractedMeta.missing_params.every((p) => p === "joint_service_fluid" || p === "fluid")
      ) {
        extractedMeta.needs_clarification = false;
        extractedMeta.missing_params = [];
        if (!extractedMeta.fluid) extractedMeta.fluid = "chauffage";
        if (/\b(universel|plus\s+universel|alternative|compar)\b/i.test(message)) {
          extractedMeta.intent = "product_info";
          extractedMeta.synonyms = [
            ...new Set([...extractedMeta.synonyms, "G110", "inhibiteur universel", "universel"]),
          ];
        }
        console.log("[/api/chat] heating_circuit_clarification_bypass", { sessionId, intent: extractedMeta.intent });
      }

      if (isPersonalDrinkwareOutOfCatalog(conversationFull)) {
        const drinkwareReply = buildPersonalDrinkwareOutOfScopeReply(locale, audience);
        const escalationSection = buildEscalationSection(locale, audience);
        const drinkwareResponse = [drinkwareReply, escalationSection].filter(Boolean).join("\n\n");
        const drinkwareHandoff = buildHandoff(locale, audience);
        startSse(res);
        sseWriteWithSession(res, sessionId, { delta: drinkwareResponse, sessionId, audience }, "chunk");
        await saveMessage(sessionId, "assistant", drinkwareResponse, {
          metadata_extracted: extractedMeta,
          intent: extractedMeta.intent,
        });
        fireAndForget(
          logQuery({
            sessionId,
            locale,
            audience,
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
          { done: true, audience, handoff: drinkwareHandoff, geoCountry: effectiveGeoCountry },
          "done",
        );
        res.end();
        return;
      }

      const pkLocaleEarly = productKnowledgeLocale(locale);
      const catalogSizeEarly = await countProductKnowledge(pkLocaleEarly).catch(() => 0);
      const catalogCitation =
        env.PRODUCT_KNOWLEDGE_ENABLED && catalogSizeEarly > 0
          ? await detectCatalogProductCitations({
              locale: pkLocaleEarly,
              text: userCitationScanText,
              audience,
              limit: env.PRODUCT_KNOWLEDGE_MAX_PRODUCTS,
            }).catch(() => ({ products: [], best: null, bestScore: 0 }))
          : { products: [], best: null, bestScore: 0 };
      const hasCatalogCitation = catalogCitation.products.length > 0;
      const explicitProductTargeted =
        hasCatalogCitation ||
        isExplicitProductTargeted([citationScanText, effectiveQuery, message, queryForRetrieval]);
      const citeNorm = citationScanText
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

      if (
        hasCatalogCitation &&
        (isFactualProductQuestion(citationScanText) || catalogCitation.bestScore >= EXPLICIT_PRODUCT_MATCH_MIN)
      ) {
        extractedMeta.needs_clarification = false;
        extractedMeta.missing_params = [];
        if (isFactualProductQuestion(citationScanText)) extractedMeta.intent = "product_info";
        if (!extractedMeta.material && /\bpvc\b/.test(citeNorm)) extractedMeta.material = "pvc";
        if (!extractedMeta.pressure && /\bsous\s+pression\b/.test(citeNorm)) extractedMeta.pressure = "pressurized";
        if (!extractedMeta.fluid && /\b(canalisation|tuyau|eau|potable)\b/.test(citeNorm)) {
          if (!isBuildingSurfaceSealingContext(citationScanText)) {
            extractedMeta.fluid = "eau";
          }
        }
        console.log("[/api/chat] catalog_citation_bypass", {
          sessionId,
          slugs: catalogCitation.products.map((p) => p.slug),
          bestScore: catalogCitation.bestScore,
          factual: isFactualProductQuestion(citationScanText),
        });
      }

      const vectorRagLite = resolveVectorRagLite(catalogSizeEarly);

      // Build search query enriched with synonyms and technical terms from metadata.
      // When a theme filter is active, use theme-aware enrichment and suppress fluid
      // terms that pollute automotive queries (e.g. "eau potable").
      const metadataForSearch =
        effectiveTheme === "automobile" ? { ...extractedMeta, fluid: null } : extractedMeta;
      const retrievalQueryBase = expandedRetrievalQuery || queryForRetrieval;
      const searchQuery = effectiveTheme
        ? buildThemeAwareSearchQuery(
            buildEnrichedSearchQuery(
              buildSearchQuery(retrievalQueryBase, metadataForSearch.fluid ?? fluid),
              metadataForSearch,
              { lite: vectorRagLite },
            ),
            effectiveTheme,
          )
        : buildEnrichedSearchQuery(
            buildSearchQuery(retrievalQueryBase, extractedMeta.fluid ?? fluid),
            extractedMeta,
            { lite: vectorRagLite },
          );

      if (
        extractedMeta.needs_clarification &&
        diagnosticResult.clarification_message &&
        !hasCatalogCitation
      ) {
        const informationalQuestion =
          isInformationalProductQuestion(queryForRetrieval) ||
          isInformationalProductQuestion(message) ||
          isInformationalProductQuestion(effectiveQuery);
        let faqPreMatch: Awaited<ReturnType<typeof searchFaqKnowledgeMatch>> | null = null;

        if (informationalQuestion) {
          extractedMeta.needs_clarification = false;
          extractedMeta.missing_params = extractedMeta.missing_params.filter(
            (p) => !["fluid", "diameter", "pressure", "joint_service_fluid"].includes(p),
          );
          if (extractedMeta.missing_params.length === 0) {
            extractedMeta.needs_clarification = false;
          }
          if (["leak_repair", "pipe_repair", "inaccessible_leak", "sealing_assembly"].includes(extractedMeta.intent)) {
            extractedMeta.intent = "general_technical";
          }
          console.log("[/api/chat] informational_clarification_bypass", {
            sessionId,
            intent: extractedMeta.intent,
            missing_params: extractedMeta.missing_params,
          });
        } else {
          faqPreMatch = await searchFaqKnowledgeMatch(deps.index, queryForRetrieval, locale).catch(() => null);
          if (faqPreMatch?.matched) {
            extractedMeta.needs_clarification = false;
            extractedMeta.missing_params = [];
            if (extractedMeta.intent === "unknown") extractedMeta.intent = "general_technical";
            console.log("[/api/chat] faq_clarification_bypass", {
              sessionId,
              topScore: faqPreMatch.topScore,
              chunks: faqPreMatch.nodes.length,
            });
          }
        }

        if (extractedMeta.needs_clarification) {
        const response = diagnosticResult.clarification_message;
        startSse(res);
        sseWriteWithSession(res, sessionId, { delta: response, sessionId, audience }, "chunk");
        const assistantMsgId = await saveMessage(sessionId, "assistant", response, {
          metadata_extracted: extractedMeta,
          intent: extractedMeta.intent,
        });
        fireAndForget(
          logQuery({
            sessionId,
            locale,
            audience,
            fluidType: extractedMeta.fluid ?? fluid,
            query: message,
            responseMs: Date.now() - startedAt,
            status: "diagnostic_clarification",
          }),
          "logQuery.diagnostic_clarification",
        );
        sseWriteWithSession(
          res,
          sessionId,
          { done: true, audience, handoff, geoCountry: effectiveGeoCountry, messageId: assistantMsgId },
          "done",
        );
        res.end();
        return;
        }
      }

      const informationalRetrievalQuestion =
        isInformationalProductQuestion(queryForRetrieval) ||
        isInformationalProductQuestion(message) ||
        isInformationalProductQuestion(effectiveQuery);
      let faqContextNodes: unknown[] = [];

      const ongoingConversationEarly = hasOngoingConversation(historyMessages);
      const feedbackCorrection = resolveAnyProductCorrectionContext(historyMessages, message);

      if (
        feedbackCorrection &&
        env.PRODUCT_KNOWLEDGE_ENABLED &&
        catalogSizeEarly > 0
      ) {
        const correctionCitation = await detectCatalogProductCitations({
          locale: pkLocaleEarly,
          text: message,
          audience,
          limit: 3,
        });
        const correctionProduct =
          correctionCitation.best ??
          (await lookupCitedCatalogProductForRecommendation({
            locale: pkLocaleEarly,
            userQuery: resolveProductCitationQuery(message, message),
            audience,
          }));
        if (correctionProduct) {
          console.log("[/api/chat] feedback_product_correction", {
            sessionId,
            slug: correctionProduct.slug,
            trainingQuery: feedbackCorrection.trainingQuery.slice(0, 120),
            penalizedSlugs: feedbackCorrection.dislikedProductSlugs,
          });
          extractedMeta.needs_clarification = false;
          extractedMeta.missing_params = [];
          extractedMeta.intent = "product_info";
          const resellerPromiseCorrection =
            locale === "pl" ? Promise.resolve<Reseller[]>([]) : getCachedResellers().catch(() => []);
          const cacheKeyCorrection = `${ANSWER_CACHE_VERSION}|${locale}|${audience}|${effectiveTheme ?? "none"}|fb:${feedbackCorrection.trainingQuery.toLowerCase()}|${correctionProduct.slug}`;
          await deliverDirectTechnicalSheetTurn({
            res,
            sessionId,
            locale,
            audience,
            handoff,
            geoCountry: effectiveGeoCountry,
            product: correctionProduct,
            extractedMeta,
            queryForRetrieval: feedbackCorrection.trainingQuery,
            trainingQuery: feedbackCorrection.trainingQuery,
            cacheKey: cacheKeyCorrection,
            startedAt,
            resellerPromise: resellerPromiseCorrection,
            ongoingConversation: ongoingConversationEarly,
            buildReply: buildDirectCitedProductReply,
            logStatus: "direct_cited_product",
            sessionTheme: effectiveTheme,
          });
          return;
        }
      }

      if (
        env.PRODUCT_KNOWLEDGE_ENABLED &&
        catalogSizeEarly > 0 &&
        isExplicitProductLookupQuery(effectiveQuery)
      ) {
        const directSheetProductEarly = await lookupExplicitCatalogProductForSheet({
          locale: pkLocaleEarly,
          userQuery: effectiveQuery,
          contextQuery: queryForRetrieval,
          audience,
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
            audience,
            handoff,
            geoCountry: effectiveGeoCountry,
            product: directSheetProductEarly,
            extractedMeta,
            queryForRetrieval,
            cacheKey: cacheKeyEarly,
            startedAt,
            resellerPromise: resellerPromiseEarly,
            ongoingConversation: ongoingConversationEarly,
            sessionTheme: effectiveTheme,
          });
          return;
        }
      }

      if (
        env.PRODUCT_KNOWLEDGE_ENABLED &&
        catalogSizeEarly > 0 &&
        !isExplicitProductLookupQuery(effectiveQuery) &&
        !isFactualProductQuestion(citationScanText) &&
        !isThemeUncertaintyMessage(message)
      ) {
        const productCitationQuery = resolveProductCitationQuery(message, queryForRetrieval);
        const strongUserProductCitation =
          hasCatalogCitation &&
          catalogCitation.best != null &&
          computeExplicitProductMatchScore(catalogCitation.best, [message]) >=
            EXPLICIT_PRODUCT_NAME_PRIORITY_MIN;
        const citedProductEarly =
          (strongUserProductCitation && productCitationQuery === message.trim()
            ? catalogCitation.best
            : null) ??
          (await lookupCitedCatalogProductForRecommendation({
            locale: pkLocaleEarly,
            userQuery: productCitationQuery,
            audience,
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
            audience,
            handoff,
            geoCountry: effectiveGeoCountry,
            product: citedProductEarly,
            extractedMeta,
            queryForRetrieval,
            cacheKey: cacheKeyEarly,
            startedAt,
            resellerPromise: resellerPromiseEarly,
            ongoingConversation: ongoingConversationEarly,
            buildReply: buildDirectCitedProductReply,
            logStatus: "direct_cited_product",
            sessionTheme: effectiveTheme,
          });
          return;
        }
      }

      const resellerPromise = locale === "pl" ? Promise.resolve<Reseller[]>([]) : getCachedResellers().catch(() => []);

      const history = toHistoryPrompt(historyMessages);
      const ongoingConversation = hasOngoingConversation(historyMessages);
      const priorRecommendedProduct = sessionDiscussedProduct;
      const productFollowUp = isProductFollowUpQuestion(message, historyMessages);
      const compatibilitySpecQuestion = isCompatibilitySpecQuestion(queryForRetrieval);
      if (
        productFollowUp ||
        compatibilitySpecQuestion ||
        (hasNamedProductCitation(message) && isInformationalProductQuestion(queryForRetrieval))
      ) {
        extractedMeta.missing_params = extractedMeta.missing_params.filter(
          (p) => !["fluid", "diameter", "pressure", "joint_service_fluid"].includes(p),
        );
        if (extractedMeta.missing_params.length === 0) {
          extractedMeta.needs_clarification = false;
        }
      }
      const baseFilters = [{ key: "locale", value: locale, operator: "==" as const }];
      const applyThemeHardFilter = Boolean(effectiveTheme) && !explicitProductTargeted;
      const themeFilters =
        applyThemeHardFilter && effectiveTheme
          ? [{ key: "theme", value: effectiveTheme, operator: "==" as const }]
          : [];
      const policyFilters = allowFrenchStandards
        ? []
        : [{ key: "regulatory_scope", value: "GLOBAL", operator: "==" as const }];
      const preFilters = applyThemeHardFilter
        ? {
            filters: [...baseFilters, ...themeFilters, ...policyFilters],
            condition: "and" as const,
          }
        : audience
          ? {
              filters: [...baseFilters, { key: "audience", value: audience, operator: "==" as const }, ...policyFilters],
              condition: "and" as const,
            }
          : {
              filters: [...baseFilters, ...policyFilters],
              condition: "and" as const,
            };
      if (explicitProductTargeted && effectiveTheme) {
        console.log("[/api/chat] soft_theme_filter", {
          sessionId,
          theme: effectiveTheme,
          catalogCitationSlugs: catalogCitation.products.map((p) => p.slug),
        });
      }

      const pkLocale = pkLocaleEarly;
      const catalogSize = catalogSizeEarly;
      let resolvedNodes: unknown[] = [];
      let retrievalPath: "product_knowledge" | "vector_rag" = "vector_rag";
      let retrievalCount = 0;
      let preTechnicalFilterCount = 0;
      let pkRouteTags: string[] = [];
      let pkProductSlugs: string[] = [];
      let pkResolvedProducts: ProductKnowledgeRow[] = [...catalogCitation.products];
      const pkRenderContext = { sessionAudience: audience, sessionTheme: effectiveTheme, locale };

      const feedbackQuery =
        productFollowUp || purchaseFollowUp
          ? message.trim()
          : `${queryForRetrieval}\n${searchQuery}`.trim();
      const feedbackCtx = await resolveFeedbackRetrievalContext(feedbackQuery, locale, sessionId).catch(
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
      const feedbackAdjustments = {
        boostSlugs: feedbackCtx.boostSlugs,
        sessionBoostSlugs: feedbackCtx.sessionBoostSlugs,
        penalizeSlugs: feedbackCtx.penalizeSlugs,
        sessionPenalizeSlugs: feedbackCtx.sessionPenalizeSlugs,
        crossSessionPenalizeSlugs: feedbackCtx.crossSessionPenalizeSlugs,
        crossSessionBoostSlugs: feedbackCtx.crossSessionBoostSlugs,
      };
      const feedbackHardPenalties = hardPenalizeSlugs(feedbackAdjustments);
      const feedbackHardBoosts = hardBoostSlugs(feedbackAdjustments);
      const allPenalizedSlugs = [
        ...new Set([
          ...feedbackCtx.penalizeSlugs,
          ...feedbackHardPenalties,
        ]),
      ];
      if (
        feedbackCtx.boostSlugs.length > 0 ||
        feedbackCtx.sessionBoostSlugs.length > 0 ||
        feedbackCtx.crossSessionBoostSlugs.length > 0 ||
        feedbackCtx.penalizeSlugs.length > 0 ||
        feedbackCtx.sessionPenalizeSlugs.length > 0 ||
        feedbackCtx.crossSessionPenalizeSlugs.length > 0 ||
        feedbackCtx.goldenExamples.length > 0 ||
        feedbackCtx.negativeExamples.length > 0
      ) {
        console.log("[/api/chat] feedback_retrieval", {
          sessionId,
          boost: feedbackCtx.boostSlugs,
          sessionBoost: feedbackCtx.sessionBoostSlugs,
          crossSessionBoost: feedbackCtx.crossSessionBoostSlugs,
          penalize: feedbackCtx.penalizeSlugs,
          sessionPenalize: feedbackCtx.sessionPenalizeSlugs,
          crossSessionPenalize: feedbackCtx.crossSessionPenalizeSlugs,
          golden: feedbackCtx.goldenExamples.length,
          negative: feedbackCtx.negativeExamples.length,
        });
      }

      const cacheKey = buildAnswerCacheKey(
        locale,
        audience,
        effectiveTheme,
        queryForRetrieval,
        allPenalizedSlugs,
        feedbackHardBoosts,
      );
      const cached = answerCache.get(cacheKey);
      const cachedContainsDeprecatedStoreLink =
        cached?.value.includes("amazon.fr/stores/") || cached?.value.includes("amazon.nl/stores/");
      if (cached && cached.expiresAt > Date.now() && !cachedContainsDeprecatedStoreLink) {
        const recommendation = resolveAmazonRecommendation(cached.value, locale);
        const productType = await classifyProblemTypeWithLlm(searchQuery, locale);
        startSse(res);
        sseWriteWithSession(res, sessionId, { delta: cached.value, sessionId, audience }, "chunk");
        await saveMessage(sessionId, "assistant", cached.value);
        fireAndForget(
          logQuery({
            sessionId,
            locale,
            audience,
            fluidType: fluid,
            query: queryForRetrieval,
            responseMs: Date.now() - startedAt,
            status: "cache_hit",
          }),
          "logQuery.cache_hit",
        );
        fireAndForget(
          logProductAnalytics({
            sessionId,
            locale,
            audience,
            query: queryForRetrieval,
            recommendedProduct: recommendation.productName,
            amazonUrl: recommendation.amazonUrl,
            problemType: productType.problemType,
            status: "cache_hit",
          }),
          "logProductAnalytics.cache_hit",
        );
        sseWriteWithSession(res, sessionId, { done: true, sessionId, audience, handoff, geoCountry: effectiveGeoCountry }, "done");
        res.end();
        return;
      }

      const factualProductMode =
        isFactualProductQuestion(citationScanText) && catalogCitation.best != null;

      if (env.PRODUCT_KNOWLEDGE_ENABLED && catalogSize > 0) {
        if (factualProductMode) {
          pkResolvedProducts = filterProductKnowledgeByQueryContext(
            filterProductKnowledgeByPenalties(
              catalogCitation.best ? [catalogCitation.best] : catalogCitation.products.slice(0, 1),
              feedbackCtx.sessionPenalizeSlugs,
              feedbackCtx.penalizeSlugs,
              feedbackCtx.crossSessionPenalizeSlugs,
            ),
            queryForRetrieval,
            effectiveTheme,
          );
          pkResolvedProducts = await injectFeedbackBoostProducts(
            pkResolvedProducts,
            feedbackHardBoosts,
            pkLocale,
          );
          pkProductSlugs = pkResolvedProducts.map((p) => p.slug);
          resolvedNodes = buildRetrieverNodesFromProductKnowledge(pkResolvedProducts, pkRenderContext);
          retrievalPath = "product_knowledge";
          retrievalCount = resolvedNodes.length;
          preTechnicalFilterCount = retrievalCount;
          console.log("[/api/chat] factual_catalog_citation_route", {
            sessionId,
            slugs: pkProductSlugs,
            best: catalogCitation.best?.canonical_name,
            bestScore: catalogCitation.bestScore,
          });
        } else {
          const pkRoute = await routeProductKnowledge({
            locale,
            query: retrievalQueryBase,
            searchQuery,
            userQuery: effectiveQuery,
            theme: effectiveTheme,
            metadata: extractedMeta,
            limit: env.PRODUCT_KNOWLEDGE_MAX_PRODUCTS,
            audience,
            feedbackAdjustments,
          });
          pkRouteTags = pkRoute.tags;
          pkResolvedProducts = filterProductKnowledgeByQueryContext(
            filterProductKnowledgeByPenalties(
              pkRoute.products,
              feedbackCtx.sessionPenalizeSlugs,
              feedbackCtx.penalizeSlugs,
              feedbackCtx.crossSessionPenalizeSlugs,
            ),
            queryForRetrieval,
            effectiveTheme,
          );
          pkResolvedProducts = await injectFeedbackBoostProducts(
            pkResolvedProducts,
            feedbackHardBoosts,
            pkLocale,
          );
          if (pkResolvedProducts.length > 0) {
            pkProductSlugs = pkResolvedProducts.map((p) => p.slug);
            resolvedNodes = buildRetrieverNodesFromProductKnowledge(pkResolvedProducts, pkRenderContext);
            retrievalPath = "product_knowledge";
            retrievalCount = resolvedNodes.length;
            preTechnicalFilterCount = retrievalCount;
            console.log("[/api/chat] product_knowledge_route", {
              sessionId,
              catalogSize,
              retrievalCount,
              slugs: pkProductSlugs,
              resolvedTags: pkRouteTags,
              productTags: pkResolvedProducts.flatMap((p) => p.use_case_tags),
              feedbackBoost: feedbackHardBoosts,
            });
            const debugNodes = pkResolvedProducts.map((p) => summarizeProductKnowledgeForDebug(p));
            console.log("[/api/chat] retrieval_debug_product_knowledge", {
              sessionId,
              query: searchQuery,
              debugNodes,
            });
          }
        }
      }

      if (retrievalPath === "vector_rag") {
        const retrievalPoolK = Math.max(env.TOP_K, Math.round(env.TOP_K * env.RETRIEVAL_POOL_MULTIPLIER));
        const retriever = deps.index.asRetriever({
          similarityTopK: retrievalPoolK,
          filters: preFilters,
        });
        console.log("Vector store initialized:", Boolean(deps.vectorStore));
        console.log("Starting vector search...", { sessionId, profileFilter: audience ?? "none", theme: effectiveTheme ?? "none", retrievalPoolK });
        const retrievedNodes = await withTimeout(
          retriever.retrieve(searchQuery),
          VECTOR_SEARCH_TIMEOUT_MS,
          "SUPABASE_VECTOR_SEARCH",
        );
        resolvedNodes = Array.isArray(retrievedNodes) ? retrievedNodes : [];
        retrievalCount = resolvedNodes.length;

        if ((retrievalCount < 3 || retrievalCount === 0) && effectiveTheme && applyThemeHardFilter) {
          console.log("[/api/chat] theme filter yielded few results, retrying without theme filter", { sessionId, theme: effectiveTheme, retrievalCount });
          const noThemeFilters = {
            filters: [...baseFilters, ...policyFilters],
            condition: "and" as const,
          };
          const fallbackRetriever = deps.index.asRetriever({
            similarityTopK: retrievalPoolK,
            filters: noThemeFilters,
          });
          const fallbackNodes = await withTimeout(
            fallbackRetriever.retrieve(searchQuery),
            VECTOR_SEARCH_TIMEOUT_MS,
            "SUPABASE_VECTOR_SEARCH_FALLBACK",
          );
          if (Array.isArray(fallbackNodes) && fallbackNodes.length > retrievalCount) {
            resolvedNodes = fallbackNodes;
            retrievalCount = resolvedNodes.length;
          }
        }

        if (retrievalCount === 0 && audience) {
          const localeOnlyRetriever = deps.index.asRetriever({
            similarityTopK: retrievalPoolK,
            filters: {
              filters: [...baseFilters, ...policyFilters],
              condition: "and" as const,
            },
          });
          const localeNodes = await withTimeout(
            localeOnlyRetriever.retrieve(searchQuery),
            VECTOR_SEARCH_TIMEOUT_MS,
            "SUPABASE_VECTOR_SEARCH_LOCALE_ONLY",
          );
          resolvedNodes = Array.isArray(localeNodes) ? localeNodes : [];
          retrievalCount = resolvedNodes.length;
        }
        if (!allowFrenchStandards) {
          resolvedNodes = resolvedNodes.filter((item) => {
            const metadata = (item as { node?: { metadata?: Record<string, unknown> } }).node?.metadata ?? {};
            return metadata.regulatory_scope !== "FR";
          });
          retrievalCount = resolvedNodes.length;
        }

        if (
          !vectorRagLite &&
          isAutomotiveExhaustContext(queryForRetrieval, searchQuery) &&
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
            retrievalCount = resolvedNodes.length;
          }
        }

        resolvedNodes = dynamicRerank(
          resolvedNodes,
          queryForRetrieval,
          searchQuery,
          extractedMeta,
          effectiveTheme,
          {
            lite: vectorRagLite,
            softThemeFilter: explicitProductTargeted,
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
          feedbackCtx.penalizeSlugs,
          feedbackHardPenalties,
        );
        preTechnicalFilterCount = retrievalCount;

        const catalogAnchor = await searchProductKnowledge({
          locale: pkLocale,
          theme: effectiveTheme,
          tags: pkRouteTags,
          material: extractedMeta.material,
          fluid: extractedMeta.fluid,
          query: retrievalQueryBase,
          searchQuery,
          userQuery: effectiveQuery,
          limit: env.PRODUCT_KNOWLEDGE_MAX_PRODUCTS,
          audience,
        }).catch(() => [] as Awaited<ReturnType<typeof searchProductKnowledge>>);

        if (catalogAnchor.length > 0) {
          const catalogNodes = buildRetrieverNodesFromProductKnowledge(catalogAnchor, pkRenderContext);
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

        if (preTechnicalFilterCount > 0) {
          const debugNodes = resolvedNodes.slice(0, 6).map((node) => summarizeNodeForDebug(node));
          console.log("[/api/chat] retrieval_debug_before_technical_filter", {
            sessionId,
            query: searchQuery,
            preTechnicalFilterCount,
            debugNodes,
          });
        }
        resolvedNodes = prioritizeTechnicalSheets(resolvedNodes);
        resolvedNodes = capContextNodes(resolvedNodes, env.DIAGNOSTIC_MAX_CONTEXT_NODES);
        retrievalCount = resolvedNodes.length;
      } else {
        retrievalCount = resolvedNodes.length;
      }

      const pdfSupplementSlugs = factualProductMode
        ? pkProductSlugs.slice(0, 2)
        : [...new Set([...pkProductSlugs, ...catalogCitation.products.map((p) => p.slug)])].slice(0, 4);
      if (pdfSupplementSlugs.length > 0) {
        try {
          const pdfNodes = await retrievePdfChunksForSlugs(deps.index, pdfSupplementSlugs, pkLocale, {
            materialKeyword: extractedMeta.material,
            queryText: factualProductMode ? citationScanText : searchQuery,
          });
          if (pdfNodes.length > 0) {
            resolvedNodes = mergeRetrievalNodes(resolvedNodes, pdfNodes);
            resolvedNodes = prioritizeTechnicalSheets(resolvedNodes);
            resolvedNodes = capContextNodes(resolvedNodes, env.DIAGNOSTIC_MAX_CONTEXT_NODES);
            retrievalCount = resolvedNodes.length;
            console.log("[/api/chat] catalog_pdf_supplement", {
              sessionId,
              slugs: pdfSupplementSlugs,
              pdfChunks: pdfNodes.length,
              totalNodes: retrievalCount,
            });
          }
        } catch (err) {
          console.warn("[/api/chat] catalog_pdf_supplement_failed", { sessionId, err });
        }
      }

      if (informationalRetrievalQuestion || extractedMeta.intent === "general_technical") {
        faqContextNodes = await retrieveFaqKnowledgeChunks(deps.index, queryForRetrieval, locale, {
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
        catalogSize > 0 &&
        hasCatalogCitation &&
        !factualProductMode
      ) {
        const citedProducts = catalogCitation.products;
        if (citedProducts.length > 0) {
          const citedNodes = buildRetrieverNodesFromProductKnowledge(citedProducts, pkRenderContext);
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
      retrievalCount = resolvedNodes.length;

      console.log(`Context found: [${retrievalCount}]`, {
        sessionId,
        query: searchQuery,
        retrievalCount,
        preTechnicalFilterCount,
        retrievalPath,
        vectorRagLite,
      });
      if (retrievalCount === 0) {
        const noContextReply = buildNoContextFallback(locale, queryForRetrieval, fluid);
        const resellers = locale === "pl" ? [] : await resellerPromise;
        const resellerSection = locale === "pl" ? "" : buildResellerSection(locale, resellers);
        const amazonSection = buildAmazonSection(locale, {
          productName: null,
          amazonUrl: getAmazonDefaultUrl(locale, null),
        });
        const escalationSection = buildEscalationSection(locale, audience);
        const noContextResponse = [noContextReply, amazonSection, resellerSection, escalationSection].filter(Boolean).join("\n\n");
        const noContextHandoff = buildHandoff(locale, audience);
        startSse(res);
        sseWriteWithSession(res, sessionId, { delta: noContextResponse, sessionId, audience }, "chunk");
        await saveMessage(sessionId, "assistant", noContextResponse);
        const noContextClassification = await classifyProblemTypeWithLlm(searchQuery, locale);
        fireAndForget(
          logQuery({
            sessionId,
            locale,
            audience,
            fluidType: fluid,
            query: searchQuery,
            responseMs: Date.now() - startedAt,
            status: "no_context",
          }),
          "logQuery.no_context",
        );
        fireAndForget(
          logProductAnalytics({
            sessionId,
            locale,
            audience,
            query: searchQuery,
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
            audience,
            geoCountry: effectiveGeoCountry,
            problemType: noContextClassification.problemType,
            confidence: noContextClassification.confidence,
            method: noContextClassification.method,
          }),
          "logProblemEvent.no_context",
        );
        answerCache.set(cacheKey, {
          value: noContextResponse,
          expiresAt: Date.now() + env.QUERY_CACHE_TTL_MS,
        });
        sseWriteWithSession(res, sessionId, { done: true, sessionId, audience, handoff: noContextHandoff, geoCountry: effectiveGeoCountry }, "done");
        res.end();
        return;
      }

      const sourceUrls = extractSourceUrlsFromNodes(resolvedNodes);
      const conversationTranscript = buildPreAnalysisTranscript(historyMessages, message);
      const goldenExamples = feedbackCtx.goldenExamples;
      const negativeExamples = feedbackCtx.negativeExamples;
      const retrieverForAnswer = deps.index.asRetriever({
        similarityTopK: env.TOP_K,
        filters: preFilters,
      });
      retrieverForAnswer.retrieve = async () => resolvedNodes as Awaited<ReturnType<typeof retrieverForAnswer.retrieve>>;
      const catalogAnchorReminder =
        retrievalPath === "product_knowledge"
          ? "\nSTRUCTURED_CATALOG_PRIORITY: Le catalogue structur├® guide le CHOIX du produit. Les extraits FT/FDS PDF sont la source pour compatibilit├® mat├®riaux/fluides/pressions ÔÇö en cas d'├®cart, suivre le PDF.\n"
          : "";
      const comparisonEligible =
        pkResolvedProducts.length >= 2 &&
        retrievalPath === "product_knowledge" &&
        !productFollowUp &&
        !hasCatalogCitation &&
        !isFactualProductQuestion(citationScanText);
      const fullQuery = `${buildSystemPrompt(
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
      let answer = "";
      const directSheetProduct =
        (await lookupExplicitCatalogProductForSheet({
          locale: pkLocale,
          userQuery: effectiveQuery,
          contextQuery: queryForRetrieval,
          audience,
        })) ??
        resolveDirectTechnicalSheetProduct(effectiveQuery, queryForRetrieval, pkResolvedProducts);
      const citedRecommendation =
        !directSheetProduct && !isExplicitProductLookupQuery(effectiveQuery)
          ? await lookupCitedCatalogProductForRecommendation({
              locale: pkLocale,
              userQuery: queryForRetrieval,
              audience,
            })
          : null;
      const directCitedProduct =
        citedRecommendation ??
        (hasNamedProductCitation(effectiveQuery)
          ? resolveDirectCitedProduct(effectiveQuery, pkResolvedProducts)
          : null);
      if (directSheetProduct) {
        answer = buildDirectTechnicalSheetReply(locale, directSheetProduct, pkRenderContext);
        console.log("[/api/chat] direct_technical_sheet", {
          sessionId,
          slug: directSheetProduct.slug,
          name: directSheetProduct.canonical_name,
        });
        sseWriteWithSession(res, sessionId, { delta: answer, sessionId, audience }, "chunk");
      } else if (directCitedProduct) {
        answer = buildDirectCitedProductReply(locale, directCitedProduct, pkRenderContext);
        console.log("[/api/chat] direct_cited_product", {
          sessionId,
          slug: directCitedProduct.slug,
          name: directCitedProduct.canonical_name,
        });
        sseWriteWithSession(res, sessionId, { delta: answer, sessionId, audience }, "chunk");
      } else {
      try {
        console.log("Calling Mistral...", { sessionId });
        answer = await queryWithRetryAndFallback({
          index: deps.index,
          retriever: retrieverForAnswer,
          fullQuery,
          sessionId,
          audience,
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
          audience,
          fluidType: fluid,
          query: searchQuery,
          responseMs: Date.now() - startedAt,
          status: "generation_error",
          }),
          "logQuery.generation_error",
        );
        if (!res.headersSent) {
          res.status(500).json(safeErrorPayload(generationError, err));
        } else {
          const escalation = buildEscalationSection(locale, audience);
          if (escalation) {
            sseWriteWithSession(res, sessionId, { delta: escalation, sessionId, audience }, "chunk");
          }
          sseWriteWithSession(res, sessionId, { ...safeErrorPayload(generationError, err) }, "error");
          sseWriteWithSession(res, sessionId, { done: true, sessionId, audience }, "done");
          res.end();
        }
        return;
      }
      }

      console.log("[/api/chat] mistral_response", {
        sessionId,
        answerLength: answer.length,
        preview: answer.slice(0, 160),
      });

      if (!answer.trim()) {
        answer = getGenericNoAnswerFallback(locale);
        sseWriteWithSession(res, sessionId, { delta: answer, sessionId, audience }, "chunk");
      }

      answer = stripLeadingConversationGreeting(answer, ongoingConversation);
      const contradictedBefore = answerContradictsRecommendation(answer);
      answer = stripContradictoryProductRecommendation(answer);
      if (contradictedBefore) {
        console.warn("[/api/chat] contradictory_recommendation_stripped", { sessionId });
        sseWriteWithSession(res, sessionId, { replaceContent: answer, sessionId, audience }, "chunk");
      }
      if (productFollowUp && priorRecommendedProduct) {
        answer = compactProductFollowUpAnswer(answer, priorRecommendedProduct);
      }
      answer = sanitizeDocumentationLinks(answer);
      if (containsCompetitorBrandMention(answer)) {
        console.warn("[/api/chat] competitor_brand_redacted", { sessionId });
        answer = sanitizeCompetitorBrandMentions(answer, locale);
        sseWriteWithSession(res, sessionId, { replaceContent: answer, sessionId, audience }, "chunk");
      }

      if (containsOffTopicSink(answer, queryForRetrieval)) {
        answer = buildPipeGasClarification(locale);
        sseWriteWithSession(res, sessionId, { delta: `\n\n${answer}`, sessionId, audience }, "chunk");
      }

      answer = removeComplementaryQuestionBlocks(answer);

      const extractedProduct = extractRecommendedProduct(answer);
      const validProductRecommended = productFollowUp ? false : hasValidRecommendedProduct(answer);
      let analyticsProduct: string | null = null;
      let analyticsAmazonUrl = "";

      if (!validProductRecommended) {
        const stripped = stripAnswerWithoutProductRecommendation(removeAmazonSections(answer));
        const moreDetails =
          productFollowUp || answerProvidesProductGuidance(answer)
            ? ""
            : buildMoreDetailsForProductRequest(locale, audience, message);
        answer = [stripped, moreDetails].filter(Boolean).join("\n\n");
        sseWriteWithSession(res, sessionId, { replaceContent: answer, sessionId, audience }, "chunk");
        console.log("[/api/chat] no_product_recommendation", {
          sessionId,
          extractedProduct,
          retrievalCount,
          productSlugs: pkProductSlugs,
        });
      } else {
        const productHint = getProductHintFromNodes(resolvedNodes, extractedProduct);
        const productSlugHint = getProductSlugHintFromNodes(resolvedNodes, extractedProduct);
        const recommendation = resolveAmazonRecommendation(answer, locale, productHint, productSlugHint);
        analyticsProduct = recommendation.productName;
        analyticsAmazonUrl = recommendation.amazonUrl;
        const resellers = locale === "pl" ? [] : await resellerPromise;
        const resellerSection = locale === "pl" ? "" : buildResellerSection(locale, resellers);
        const amazonSection = recommendation.productName
          ? buildAmazonSection(locale, recommendation)
          : buildAmazonSection(locale, { productName: null, amazonUrl: getAmazonDefaultUrl(locale, null) });
        const mistralHadAmazon = hasAmazonSection(answer);
        const strippedAnswer = removeAmazonSections(answer);
        answer = `${strippedAnswer}\n\n${amazonSection}`.trim();
        if (!mistralHadAmazon) {
          sseWriteWithSession(res, sessionId, { delta: `\n\n${amazonSection}`, sessionId, audience }, "chunk");
        }
        console.log("[/api/chat] amazon_resolution", {
          sessionId,
          extractedProduct,
          productHint,
          productSlugHint,
          finalAmazonUrl: recommendation.amazonUrl,
          hadAmazonSection: mistralHadAmazon,
          hadFallbackSearchUrl: hasFallbackAmazonSearchUrl(strippedAnswer),
        });
        if (resellerSection && !hasStoreSection(answer) && locale !== "pl") {
          answer += `\n\n${resellerSection}`;
          sseWriteWithSession(res, sessionId, { delta: `\n\n${resellerSection}`, sessionId, audience }, "chunk");
        }
      }

      const extractedComplementary = extractComplementaryQuestionBlock(answer);
      answer = extractedComplementary.cleaned;
      const complementaryContext = `${queryForRetrieval}\n${message}`.trim();
      const upsell =
        productFollowUp
          ? null
          : extractedComplementary.question ?? buildComplementarySuggestion(locale, audience, complementaryContext);
      if (upsell && !isComplementaryQuestion(answer)) {
        const withUpsell = `\n\n${upsell.trim()}`;
        answer += withUpsell;
        sseWriteWithSession(res, sessionId, { delta: withUpsell, sessionId, audience }, "chunk");
      }

      if (answer) {
        answerCache.set(cacheKey, {
          value: answer,
          expiresAt: Date.now() + env.QUERY_CACHE_TTL_MS,
        });
      }

      const contextChunksForJudge = resolvedNodes.slice(0, 8).map((node) => {
        const wrap = node as { node?: { text?: string; getContent?: (mode?: string) => string; metadata?: Record<string, unknown> } };
        const text = typeof wrap.node?.getContent === "function"
          ? (wrap.node.getContent("NONE") ?? "")
          : (wrap.node?.text ?? "");
        return { text, metadata: wrap.node?.metadata ?? {} };
      });
      const assistantMsgId = await saveMessage(sessionId, "assistant", answer, {
        metadata_extracted: extractedMeta,
        intent: extractedMeta.intent,
        response_context: {
          search_query: searchQuery,
          query_for_retrieval: queryForRetrieval,
          training_query: queryForRetrieval,
          conversation_transcript: conversationTranscript.slice(0, 8_000),
          source_urls: sourceUrls,
          retrieval_count: retrievalCount,
          retrieval_path: retrievalPath,
          product_slugs: pkProductSlugs.length > 0 ? pkProductSlugs : undefined,
          use_case_tags: pkRouteTags.length > 0 ? pkRouteTags : undefined,
          ...(analyticsProduct ? { recommended_product: analyticsProduct } : {}),
        },
      });
      const problemClassification = await classifyProblemTypeWithLlm(searchQuery, locale);

      // ÔöÇÔöÇ LLM-as-a-Judge (fire-and-forget background evaluation) ÔöÇÔöÇ
      if (assistantMsgId) {
        const judgeInput: JudgeInput = {
          messageId: assistantMsgId,
          sessionId,
          userQuery: queryForRetrieval,
          assistantReply: answer,
          contextChunks: contextChunksForJudge,
          searchQuery,
          intent: extractedMeta.intent,
          metadataExtracted: extractedMeta,
          retrievalPath,
          ...(pkProductSlugs.length > 0 ? { productSlugs: pkProductSlugs } : {}),
          ...(pkRouteTags.length > 0 ? { useCaseTags: pkRouteTags } : {}),
        };
        scheduleJudgeEvaluation(judgeInput);
      }

      fireAndForget(
        logQuery({
          sessionId,
          locale,
          audience,
          fluidType: extractedMeta.fluid ?? fluid,
          query: searchQuery,
          responseMs: Date.now() - startedAt,
          status: "success",
        }),
        "logQuery.success",
      );
      fireAndForget(
        logProductAnalytics({
          sessionId,
          locale,
          audience,
          query: searchQuery,
          recommendedProduct: analyticsProduct,
          amazonUrl: analyticsAmazonUrl,
          problemType: problemClassification.problemType,
          status: "success",
        }),
        "logProductAnalytics.success",
      );
      fireAndForget(
        logProblemEvent({
          sessionId,
          locale,
          audience,
          geoCountry: effectiveGeoCountry,
          problemType: problemClassification.problemType,
          confidence: problemClassification.confidence,
          method: problemClassification.method,
        }),
        "logProblemEvent.success",
      );

      sseWriteWithSession(
        res,
        sessionId,
        {
          done: true,
          audience,
          handoff,
          responseMs: Date.now() - startedAt,
          geoCountry: effectiveGeoCountry,
          messageId: assistantMsgId,
        },
        "done",
      );
      res.end();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      console.error("[/api/chat] fatal_error", {
        sessionId,
        error: errorMessage,
      });
      console.error("DETAILED ERROR:", err);
      if (!res.headersSent) {
        fireAndForget(
          logQuery({
          sessionId,
          locale,
          audience: profileFromMetadata,
          fluidType: extractFluid(message),
          query: message,
          responseMs: Date.now() - startedAt,
          status: "fatal_error",
          }),
          "logQuery.fatal_error",
        );
        res.status(500).json(safeErrorPayload(errorMessage, err));
      } else {
        sseWriteWithSession(res, sessionId, { ...safeErrorPayload(errorMessage, err) }, "error");
        sseWriteWithSession(res, sessionId, { done: true, sessionId, responseMs: Date.now() - startedAt, geoCountry: geoCountryFromBody }, "done");
        res.end();
      }
    }
}
