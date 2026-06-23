import type { VectorStoreIndex } from "llamaindex";
import type { DiagnosticAnalysis, ExtractedMetadata } from "../retrieval/intent-extractor.js";
import type {
  Audience,
  HandoffPayload,
  Locale,
  ProblemClassification,
  ProductTheme,
  Reseller,
  StoredMessage,
} from "../../types/index.js";
import type { ProductKnowledgeRow } from "../../types/product-knowledge.js";
import type { CatalogCitationResult } from "../retrieval/product-knowledge/index.js";
import type {
  FeedbackRetrievalContext,
  FeedbackSlugAdjustments,
} from "../../services/feedback-retrieval.service.js";
import type { ProductKnowledgeRenderContext } from "../../services/product-router.service.js";
import type { GoldenExample } from "../../services/golden-examples.service.js";
import type { NegativeExample } from "../../services/negative-examples.service.js";
import type { JudgeInput } from "../../services/judge.service.js";
import type { FeedbackProductCorrectionContext } from "../../utils/feedback-correction.js";
import type {
  ChatPipelineBindings,
  ClarificationContext,
  ComplementaryQuestionBlock,
  JointPasteClarificationContext,
  LegacyClarificationContext,
  ProductKnowledgeLocale,
  RetrieverFilterGroup,
  RetrieverMetadataFilter,
} from "./chat-pipeline-bindings.js";

export type AfterSessionContextBindings = ChatPipelineBindings & {
  historyMessages: StoredMessage[];
  audience: Audience;
  handoff: HandoffPayload;
  effectiveGeoCountry: string | null;
  effectiveGeoConsent: boolean | null;
  allowFrenchStandards: boolean;
  disallowFrenchStandards: boolean;
  effectiveQuery: string;
  queryForRetrieval: string;
  expandedRetrievalQuery: string;
  fluid: string | null;
  effectiveTheme: ProductTheme | null;
  sessionTheme: ProductTheme | null;
  sessionDiscussedProduct: string | null;
  sessionDiscussedSlug: string | null;
  purchaseFollowUp: boolean;
  jointPasteContext: JointPasteClarificationContext | null;
  legacyClarificationContext: LegacyClarificationContext | null;
  clarificationContext: ClarificationContext | null;
};

export type AfterRetrievalBindings = AfterSessionContextBindings & {
  extractedMeta: ExtractedMetadata;
  diagnosticResult: DiagnosticAnalysis;
  preAnalysisTranscript: string;
  userCitationScanText: string;
  citationScanText: string;
  pkLocaleEarly: ProductKnowledgeLocale;
  catalogSizeEarly: number;
  catalogCitation: CatalogCitationResult;
  hasCatalogCitation: boolean;
  explicitProductTargeted: boolean;
  vectorRagLite: boolean;
  metadataForSearch: ExtractedMetadata;
  retrievalQueryBase: string;
  searchQuery: string;
  resellerPromise: Promise<Reseller[]>;
  history: string;
  ongoingConversation: boolean;
  priorRecommendedProduct: string | null;
  productFollowUp: boolean;
  compatibilitySpecQuestion: boolean;
  baseFilters: RetrieverMetadataFilter[];
  applyThemeHardFilter: boolean;
  themeFilters: RetrieverMetadataFilter[];
  policyFilters: RetrieverMetadataFilter[];
  preFilters: RetrieverFilterGroup;
  pkLocale: ProductKnowledgeLocale;
  catalogSize: number;
  retrievalPath: "product_knowledge" | "vector_rag";
  retrievalCount: number;
  preTechnicalFilterCount: number;
  pkResolvedProducts: ProductKnowledgeRow[];
  pkRenderContext: ProductKnowledgeRenderContext;
  feedbackCtx: FeedbackRetrievalContext;
  feedbackAdjustments: FeedbackSlugAdjustments;
  feedbackHardPenalties: string[];
  feedbackHardBoosts: string[];
  allPenalizedSlugs: string[];
  cacheKey: string;
  factualProductMode: boolean;
  pkProductSlugs: string[];
  pkRouteTags: string[];
  resolvedNodes: unknown[];
  faqContextNodes: unknown[];
  pdfSupplementSlugs: string[];
  sourceUrls: string[];
  conversationTranscript: string;
  goldenExamples: GoldenExample[];
  negativeExamples: NegativeExample[];
  retrieverForAnswer: ReturnType<VectorStoreIndex["asRetriever"]>;
  catalogAnchorReminder: string;
  comparisonEligible: boolean;
  fullQuery: string;
  feedbackCorrection: FeedbackProductCorrectionContext | null;
};

export type AfterGenerationBindings = AfterRetrievalBindings & {
  answer: string;
  contradictedBefore: boolean;
  validProductRecommended: boolean;
  analyticsAmazonUrl: string;
  analyticsProduct: string | null;
  extractedProduct: string | null;
  extractedComplementary: ComplementaryQuestionBlock;
  complementaryContext: string;
  upsell: string | null;
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertAfterSessionContext(ctx: ChatPipelineBindings): asserts ctx is AfterSessionContextBindings {
  invariant(ctx.historyMessages, "Chat pipeline: historyMessages missing after session context");
  invariant(ctx.audience, "Chat pipeline: audience missing after session context");
  invariant(ctx.handoff !== undefined, "Chat pipeline: handoff missing after session context");
  invariant(ctx.effectiveQuery !== undefined, "Chat pipeline: effectiveQuery missing after session context");
  invariant(ctx.queryForRetrieval !== undefined, "Chat pipeline: queryForRetrieval missing after session context");
  invariant(ctx.expandedRetrievalQuery !== undefined, "Chat pipeline: expandedRetrievalQuery missing after session context");
  invariant(ctx.fluid !== undefined, "Chat pipeline: fluid missing after session context");
  invariant(ctx.effectiveTheme !== undefined, "Chat pipeline: effectiveTheme missing after session context");
  invariant(ctx.sessionTheme !== undefined, "Chat pipeline: sessionTheme missing after session context");
  invariant(ctx.sessionDiscussedProduct !== undefined, "Chat pipeline: sessionDiscussedProduct missing after session context");
  invariant(ctx.sessionDiscussedSlug !== undefined, "Chat pipeline: sessionDiscussedSlug missing after session context");
  invariant(ctx.purchaseFollowUp !== undefined, "Chat pipeline: purchaseFollowUp missing after session context");
  invariant(ctx.jointPasteContext !== undefined, "Chat pipeline: jointPasteContext missing after session context");
  invariant(ctx.legacyClarificationContext !== undefined, "Chat pipeline: legacyClarificationContext missing after session context");
  invariant(ctx.clarificationContext !== undefined, "Chat pipeline: clarificationContext missing after session context");
  invariant(ctx.effectiveGeoCountry !== undefined, "Chat pipeline: effectiveGeoCountry missing after session context");
  invariant(ctx.effectiveGeoConsent !== undefined, "Chat pipeline: effectiveGeoConsent missing after session context");
  invariant(ctx.allowFrenchStandards !== undefined, "Chat pipeline: allowFrenchStandards missing after session context");
  invariant(ctx.disallowFrenchStandards !== undefined, "Chat pipeline: disallowFrenchStandards missing after session context");
}

export function assertAfterRetrieval(ctx: ChatPipelineBindings): asserts ctx is AfterRetrievalBindings {
  assertAfterSessionContext(ctx);
  invariant(ctx.extractedMeta, "Chat pipeline: extractedMeta missing after retrieval");
  invariant(ctx.diagnosticResult, "Chat pipeline: diagnosticResult missing after retrieval");
  invariant(ctx.retrieverForAnswer, "Chat pipeline: retrieverForAnswer missing after retrieval");
  invariant(ctx.fullQuery, "Chat pipeline: fullQuery missing after retrieval");
  invariant(ctx.searchQuery, "Chat pipeline: searchQuery missing after retrieval");
  invariant(ctx.cacheKey, "Chat pipeline: cacheKey missing after retrieval");
  invariant(ctx.resolvedNodes, "Chat pipeline: resolvedNodes missing after retrieval");
  invariant(ctx.pkProductSlugs, "Chat pipeline: pkProductSlugs missing after retrieval");
  invariant(ctx.pkRouteTags, "Chat pipeline: pkRouteTags missing after retrieval");
  invariant(ctx.resellerPromise, "Chat pipeline: resellerPromise missing after retrieval");
  invariant(ctx.faqContextNodes, "Chat pipeline: faqContextNodes missing after retrieval");
}

export function assertAfterGeneration(ctx: ChatPipelineBindings): asserts ctx is AfterGenerationBindings {
  assertAfterRetrieval(ctx);
  invariant(ctx.answer, "Chat pipeline: answer missing after generation");
  invariant(ctx.contradictedBefore !== undefined, "Chat pipeline: contradictedBefore missing after generation");
  invariant(ctx.validProductRecommended !== undefined, "Chat pipeline: validProductRecommended missing after generation");
  invariant(ctx.analyticsAmazonUrl !== undefined, "Chat pipeline: analyticsAmazonUrl missing after generation");
  invariant(ctx.extractedComplementary, "Chat pipeline: extractedComplementary missing after generation");
  invariant(ctx.complementaryContext !== undefined, "Chat pipeline: complementaryContext missing after generation");
  invariant(ctx.upsell !== undefined, "Chat pipeline: upsell missing after generation");
}
