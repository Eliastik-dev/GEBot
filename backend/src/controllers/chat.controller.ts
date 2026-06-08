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
import { findSimilarGoldenExamples } from "../services/golden-examples.service.js";
import { findSimilarNegativeFeedback } from "../services/negative-examples.service.js";
import { ensureSession, getSessionTheme, loadRecentMessages, logProblemEvent, logProductAnalytics, logQuery, saveMessage, updateSessionAudience, updateSessionTheme } from "../services/database.service.js";
import { scheduleJudgeEvaluation, type JudgeInput } from "../services/judge.service.js";
import { buildSearchQuery, buildThemeAwareSearchQuery, capContextNodes, enrichRetrievalQuery, extractSourceUrlsFromNodes, getCachedResellers, mergeRetrievalNodes, prioritizeTechnicalSheets, summarizeNodeForDebug, AUTOMOTIVE_EXHAUST_SUPPLEMENT_QUERY } from "../services/rag.service.js";
import { hasDescalingContext, isBuildingEnvelopeLeakContext, isPersonalDrinkwareOutOfCatalog } from "../utils/diagnostic-rules.js";
import { countProductKnowledge, lookupCatalogProductsByCitation, lookupExplicitCatalogProductForSheet, searchProductKnowledge } from "../services/product-knowledge.service.js";
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
import { detectAudience, detectTheme, getSpecificClarification, isProfileOnlyMessage, isThemeOnlyMessage, normalizeAudience, normalizeLocale } from "../utils/locale.js";
import { answerProvidesProductGuidance, buildComplementaryFollowUp, buildComplementarySuggestion, buildDirectTechnicalSheetReply, buildEscalationSection, buildHandoff, buildResellerSection, buildMoreDetailsForProductRequest, buildPersonalDrinkwareOutOfScopeReply, containsOffTopicSink, extractComplementaryQuestionBlock, isComplementaryQuestion, isResellerIntent, isYesNoAnswer, removeComplementaryQuestionBlocks, sanitizeDocumentationLinks, buildPipeGasClarification, hasStoreSection, stripAnswerWithoutProductRecommendation, stripLeadingConversationGreeting } from "../utils/response.js";
import { formatNamedProductCitationPrompt, hasNamedProductCitation, isExplicitProductLookupQuery, resolveDirectTechnicalSheetProduct } from "../utils/product-mention.js";
import { containsCompetitorBrandMention, sanitizeCompetitorBrandMentions } from "../utils/brand-policy.js";
import { buildNoContextFallback, extractFluid, getGenericNoAnswerFallback, hasOngoingConversation, isInformationalProductQuestion, resolveClarificationContext, toAudienceLabel, toHistoryPrompt } from "../utils/text.js";
import { resolveJointPasteClarificationContext } from "../utils/joint-paste.js";
import { getIncomingSessionId } from "../utils/session.js";
import { startSse, sseWrite } from "../utils/sse.js";
import type { VectorStoreIndex } from "llamaindex";

export type ChatDeps = { index: VectorStoreIndex; vectorStore: unknown };

export async function postChat(req: Request, res: Response, deps: ChatDeps) {
    const startedAt = Date.now();
    const body = (req.body ?? {}) as ChatRequestBody;
    const message = (body.message ?? "").trim();
    const locale = normalizeLocale(body.locale);
    const profileFromMetadata = normalizeAudience(body.profile);
    const sessionId = getIncomingSessionId(req, body);
    const geoConsentFromBody = typeof body.geoConsent === "boolean" ? body.geoConsent : undefined;
    const geoCountryFromBody = typeof body.geoCountry === "string" ? body.geoCountry.toUpperCase() : null;
    if (!message) {
      res.status(400).json({ error: "Missing 'message'" });
      return;
    }

    try {
      console.log("[/api/chat] incoming", {
        sessionId,
        locale,
        message,
        profile: body.profile ?? null,
        geoConsent: geoConsentFromBody ?? null,
        geoCountry: geoCountryFromBody,
      });
      startSse(res);
      sseWrite(res, { status: "searching", sessionId, locale }, "status");
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
        sseWrite(res, { delta: onboardingQuestion, sessionId }, "chunk");
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
        sseWrite(res, { done: true, sessionId, geoCountry: effectiveGeoCountry }, "done");
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
        sseWrite(res, { delta: response, sessionId, audience }, "chunk");
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
        sseWrite(res, { done: true, sessionId, audience, handoff, geoCountry: effectiveGeoCountry }, "done");
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
        sseWrite(res, { delta: response, sessionId, audience }, "chunk");
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
        sseWrite(res, { done: true, sessionId, audience, handoff, geoCountry: effectiveGeoCountry }, "done");
        res.end();
        return;
      }

      if (detectedAudience && isProfileOnlyMessage(message)) {
        const followUp = THEME_QUESTION_BY_LOCALE[locale];
        startSse(res);
        sseWrite(res, { delta: followUp, sessionId, audience, showThemeReplies: true }, "chunk");
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
        sseWrite(res, { done: true, sessionId, audience, handoff, geoCountry: effectiveGeoCountry }, "done");
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
        sseWrite(res, { delta: followUp, sessionId, audience, theme: detectedTheme }, "chunk");
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
        sseWrite(res, { done: true, sessionId, audience, theme: detectedTheme, handoff, geoCountry: effectiveGeoCountry }, "done");
        res.end();
        return;
      }

      const specificClarification = getSpecificClarification(message, locale);
      if (specificClarification) {
        console.log("[/api/chat] specific_clarification", { sessionId, message });
        startSse(res);
        sseWrite(res, { delta: specificClarification, sessionId, audience }, "chunk");
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
        sseWrite(res, { done: true, sessionId, audience, handoff, geoCountry: effectiveGeoCountry }, "done");
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
      const expandedRetrievalQuery = await expandRetrievalQueryWithLlm(queryForRetrieval, historyMessages, locale);
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

      // ── ML-based Intent & Metadata Extraction (replaces legacy regex gates) ──
      const preAnalysisTranscript = buildPreAnalysisTranscript(historyMessages, message);
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
        isBuildingEnvelopeLeakContext(conversationFull) &&
        extractedMeta.missing_params.every((p) => p === "fluid")
      ) {
        extractedMeta.needs_clarification = false;
        extractedMeta.missing_params = [];
        extractedMeta.fluid = null;
        if (
          ["leak_repair", "pipe_repair", "inaccessible_leak", "general_technical"].includes(
            extractedMeta.intent,
          )
        ) {
          extractedMeta.intent = "sealing_assembly";
        }
        console.log("[/api/chat] building_envelope_bypass", { sessionId, intent: extractedMeta.intent });
      }

      if (isPersonalDrinkwareOutOfCatalog(conversationFull)) {
        const drinkwareReply = buildPersonalDrinkwareOutOfScopeReply(locale, audience);
        const escalationSection = buildEscalationSection(locale, audience);
        const drinkwareResponse = [drinkwareReply, escalationSection].filter(Boolean).join("\n\n");
        const drinkwareHandoff = buildHandoff(locale, audience);
        startSse(res);
        sseWrite(res, { delta: drinkwareResponse, sessionId, audience }, "chunk");
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
        sseWrite(
          res,
          { done: true, sessionId, audience, handoff: drinkwareHandoff, geoCountry: effectiveGeoCountry },
          "done",
        );
        res.end();
        return;
      }

      const pkLocaleEarly = productKnowledgeLocale(locale);
      const catalogSizeEarly = await countProductKnowledge(pkLocaleEarly).catch(() => 0);
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

      if (extractedMeta.needs_clarification && diagnosticResult.clarification_message) {
        const response = diagnosticResult.clarification_message;
        startSse(res);
        sseWrite(res, { delta: response, sessionId, audience }, "chunk");
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
        sseWrite(
          res,
          { done: true, sessionId, audience, handoff, geoCountry: effectiveGeoCountry, messageId: assistantMsgId },
          "done",
        );
        res.end();
        return;
      }

      const ongoingConversationEarly = hasOngoingConversation(historyMessages);
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
          });
          return;
        }
      }

      const resellerPromise = locale === "pl" ? Promise.resolve<Reseller[]>([]) : getCachedResellers().catch(() => []);
      const cacheKey = `${ANSWER_CACHE_VERSION}|${locale}|${audience}|${effectiveTheme ?? "none"}|${queryForRetrieval.toLowerCase()}`;
      const cached = answerCache.get(cacheKey);
      const cachedContainsDeprecatedStoreLink =
        cached?.value.includes("amazon.fr/stores/") || cached?.value.includes("amazon.nl/stores/");
      if (cached && cached.expiresAt > Date.now() && !cachedContainsDeprecatedStoreLink) {
        const recommendation = resolveAmazonRecommendation(cached.value, locale);
        const productType = await classifyProblemTypeWithLlm(searchQuery, locale);
        startSse(res);
        sseWrite(res, { delta: cached.value, sessionId, audience }, "chunk");
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
        sseWrite(res, { done: true, sessionId, audience, handoff, geoCountry: effectiveGeoCountry }, "done");
        res.end();
        return;
      }

      const history = toHistoryPrompt(historyMessages);
      const ongoingConversation = hasOngoingConversation(historyMessages);
      const baseFilters = [{ key: "locale", value: locale, operator: "==" as const }];
      const themeFilters = effectiveTheme
        ? [{ key: "theme", value: effectiveTheme, operator: "==" as const }]
        : [];
      const policyFilters = allowFrenchStandards
        ? []
        : [{ key: "regulatory_scope", value: "GLOBAL", operator: "==" as const }];
      const preFilters = effectiveTheme
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

      const pkLocale = pkLocaleEarly;
      const catalogSize = catalogSizeEarly;
      let resolvedNodes: unknown[] = [];
      let retrievalPath: "product_knowledge" | "vector_rag" = "vector_rag";
      let retrievalCount = 0;
      let preTechnicalFilterCount = 0;
      let pkRouteTags: string[] = [];
      let pkProductSlugs: string[] = [];
      let pkResolvedProducts: ProductKnowledgeRow[] = [];

      if (env.PRODUCT_KNOWLEDGE_ENABLED && catalogSize > 0) {
        const pkRoute = await routeProductKnowledge({
          locale,
          query: retrievalQueryBase,
          searchQuery,
          userQuery: effectiveQuery,
          theme: effectiveTheme,
          metadata: extractedMeta,
          limit: env.PRODUCT_KNOWLEDGE_MAX_PRODUCTS,
          audience,
        });
        pkRouteTags = pkRoute.tags;
        pkResolvedProducts = pkRoute.products;
        if (pkRoute.products.length > 0) {
          pkProductSlugs = pkRoute.products.map((p) => p.slug);
          resolvedNodes = buildRetrieverNodesFromProductKnowledge(pkRoute.products);
          retrievalPath = "product_knowledge";
          retrievalCount = resolvedNodes.length;
          preTechnicalFilterCount = retrievalCount;
          console.log("[/api/chat] product_knowledge_route", {
            sessionId,
            catalogSize,
            retrievalCount,
            slugs: pkProductSlugs,
            resolvedTags: pkRouteTags,
            productTags: pkRoute.products.flatMap((p) => p.use_case_tags),
          });
          const debugNodes = pkRoute.products.map((p) => summarizeProductKnowledgeForDebug(p));
          console.log("[/api/chat] retrieval_debug_product_knowledge", {
            sessionId,
            query: searchQuery,
            debugNodes,
          });
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

        if (retrievalCount < 3 && effectiveTheme && !explicitTheme) {
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
          { lite: vectorRagLite },
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
          const catalogNodes = buildRetrieverNodesFromProductKnowledge(catalogAnchor);
          const maxPdfNodes = Math.max(2, env.DIAGNOSTIC_MAX_CONTEXT_NODES - catalogNodes.length);
          resolvedNodes = [...catalogNodes, ...capContextNodes(resolvedNodes, maxPdfNodes)];
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
        resolvedNodes = capContextNodes(resolvedNodes, env.PRODUCT_KNOWLEDGE_MAX_PRODUCTS);
        retrievalCount = resolvedNodes.length;
      }

      if (env.PRODUCT_KNOWLEDGE_ENABLED && catalogSize > 0 && hasNamedProductCitation(message)) {
        const citedProducts = await lookupCatalogProductsByCitation({
          locale: pkLocale,
          userQuery: message,
          audience,
          limit: 2,
        });
        if (citedProducts.length > 0) {
          const citedNodes = buildRetrieverNodesFromProductKnowledge(citedProducts);
          resolvedNodes = mergeRetrievalNodes(resolvedNodes, citedNodes);
          pkResolvedProducts = [
            ...citedProducts,
            ...pkResolvedProducts.filter((p) => !citedProducts.some((c) => c.slug === p.slug)),
          ];
          pkProductSlugs = [...new Set([...citedProducts.map((p) => p.slug), ...pkProductSlugs])];
          retrievalPath = "product_knowledge";
          retrievalCount = resolvedNodes.length;
          console.log("[/api/chat] cited_product_injected", {
            sessionId,
            slugs: citedProducts.map((p) => p.slug),
            message: message.slice(0, 80),
          });
        }
      }

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
        sseWrite(res, { delta: noContextResponse, sessionId, audience }, "chunk");
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
        sseWrite(res, { done: true, sessionId, audience, handoff: noContextHandoff, geoCountry: effectiveGeoCountry }, "done");
        res.end();
        return;
      }

      const sourceUrls = extractSourceUrlsFromNodes(resolvedNodes);
      const conversationTranscript = buildPreAnalysisTranscript(historyMessages, message);
      const [goldenExamples, negativeExamples] = await Promise.all([
        findSimilarGoldenExamples(searchQuery, locale, 2).catch(() => []),
        findSimilarNegativeFeedback(searchQuery, locale, 2).catch(() => []),
      ]);
      const retrieverForAnswer = deps.index.asRetriever({
        similarityTopK: env.TOP_K,
        filters: preFilters,
      });
      retrieverForAnswer.retrieve = async () => resolvedNodes as Awaited<ReturnType<typeof retrieverForAnswer.retrieve>>;
      const catalogAnchorReminder =
        retrievalPath === "product_knowledge"
          ? "\nSTRUCTURED_CATALOG_PRIORITY: Les blocs # PRODUIT du catalogue structuré priment sur tout extrait PDF — ancre toutes les specs sur ces blocs.\n"
          : "";
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
      )}${catalogAnchorReminder}

METADATA_PROFIL: ${toAudienceLabel(audience)}
LOCALE_SESSION: ${locale}
FLUID_TYPE: ${fluid ?? "inconnu"}
SEARCH_QUERY: ${searchQuery}
RETRIEVAL_PATH: ${retrievalPath}
FICHES_TECHNIQUES_PDF (use ONLY in "Documentation Officielle" section, NEVER as purchase/availability links):
${sourceUrls.length > 0 ? sourceUrls.map((url) => `- ${url}`).join("\n") : "- aucune"}

QUESTION UTILISATEUR: ${queryForRetrieval}
${isInformationalProductQuestion(queryForRetrieval) ? "\nTYPE_QUESTION: informational_faq — MODE 1: réponds DIRECTEMENT à la question (couleurs, teinte, disponibilité, oui/non…) en prose naturelle avec les faits de la fiche, AVANT toute recommandation produit. MODE 2 seulement si un produit catalogue précis s'impose." : ""}
${formatNamedProductCitationPrompt(message)}

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
      if (directSheetProduct) {
        answer = buildDirectTechnicalSheetReply(locale, directSheetProduct);
        console.log("[/api/chat] direct_technical_sheet", {
          sessionId,
          slug: directSheetProduct.slug,
          name: directSheetProduct.canonical_name,
        });
        sseWrite(res, { delta: answer, sessionId, audience }, "chunk");
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
          res.status(500).json({
            error: generationError,
            stack: err instanceof Error ? err.stack : undefined,
          });
        } else {
          const escalation = buildEscalationSection(locale, audience);
          if (escalation) {
            sseWrite(res, { delta: escalation, sessionId, audience }, "chunk");
          }
          sseWrite(
            res,
            {
              error: generationError,
              stack: err instanceof Error ? err.stack : undefined,
            },
            "error",
          );
          sseWrite(res, { done: true, sessionId, audience }, "done");
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
        sseWrite(res, { delta: answer, sessionId, audience }, "chunk");
      }

      answer = stripLeadingConversationGreeting(answer, ongoingConversation);
      answer = sanitizeDocumentationLinks(answer);
      if (containsCompetitorBrandMention(answer)) {
        console.warn("[/api/chat] competitor_brand_redacted", { sessionId });
        answer = sanitizeCompetitorBrandMentions(answer, locale);
        sseWrite(res, { replaceContent: answer, sessionId, audience }, "chunk");
      }

      if (containsOffTopicSink(answer, queryForRetrieval)) {
        answer = buildPipeGasClarification(locale);
        sseWrite(res, { delta: `\n\n${answer}`, sessionId, audience }, "chunk");
      }

      answer = removeComplementaryQuestionBlocks(answer);

      const extractedProduct = extractRecommendedProduct(answer);
      const validProductRecommended = hasValidRecommendedProduct(answer);
      let analyticsProduct: string | null = null;
      let analyticsAmazonUrl = "";

      if (!validProductRecommended) {
        const stripped = stripAnswerWithoutProductRecommendation(removeAmazonSections(answer));
        const moreDetails = answerProvidesProductGuidance(answer)
          ? ""
          : buildMoreDetailsForProductRequest(locale, audience, message);
        answer = [stripped, moreDetails].filter(Boolean).join("\n\n");
        sseWrite(res, { replaceContent: answer, sessionId, audience }, "chunk");
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
          sseWrite(res, { delta: `\n\n${amazonSection}`, sessionId, audience }, "chunk");
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
          sseWrite(res, { delta: `\n\n${resellerSection}`, sessionId, audience }, "chunk");
        }
      }

      const extractedComplementary = extractComplementaryQuestionBlock(answer);
      answer = extractedComplementary.cleaned;
      const upsell = extractedComplementary.question ?? buildComplementarySuggestion(locale, audience, message);
      if (upsell && !isComplementaryQuestion(answer)) {
        const withUpsell = `\n\n${upsell.trim()}`;
        answer += withUpsell;
        sseWrite(res, { delta: withUpsell, sessionId, audience }, "chunk");
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
          conversation_transcript: conversationTranscript.slice(0, 8_000),
          source_urls: sourceUrls,
          retrieval_count: retrievalCount,
          retrieval_path: retrievalPath,
          product_slugs: pkProductSlugs.length > 0 ? pkProductSlugs : undefined,
          use_case_tags: pkRouteTags.length > 0 ? pkRouteTags : undefined,
        },
      });
      const problemClassification = await classifyProblemTypeWithLlm(searchQuery, locale);

      // ── LLM-as-a-Judge (fire-and-forget background evaluation) ──
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

      sseWrite(
        res,
        {
          done: true,
          sessionId,
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
        res.status(500).json({
          error: errorMessage,
          stack: err instanceof Error ? err.stack : undefined,
        });
      } else {
        sseWrite(
          res,
          {
            error: errorMessage,
            stack: err instanceof Error ? err.stack : undefined,
          },
          "error",
        );
        sseWrite(res, { done: true, sessionId, responseMs: Date.now() - startedAt, geoCountry: geoCountryFromBody }, "done");
        res.end();
      }
    }
}
