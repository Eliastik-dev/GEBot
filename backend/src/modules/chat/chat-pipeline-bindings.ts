import type { Request, Response } from "express";
import type { VectorStoreIndex } from "llamaindex";
import type { ChatDeps, ValidatedChatBody } from "./chat.types.js";
import type { DiagnosticAnalysis, ExtractedMetadata } from "../retrieval/intent-extractor.js";
import type {
  Audience,
  CacheEntry,
  HandoffPayload,
  Locale,
  ProblemClassification,
  Reseller,
  StoredMessage,
  ProductTheme,
} from "../../types/index.js";
import type { ProductKnowledgeRow } from "../../types/product-knowledge.js";
import type {
  CatalogCitationResult,
} from "../../services/product-knowledge.service.js";
import type {
  FeedbackRetrievalContext,
  FeedbackSlugAdjustments,
} from "../../services/feedback-retrieval.service.js";
import type { ProductKnowledgeRenderContext } from "../../services/product-router.service.js";
import type { GoldenExample } from "../../services/golden-examples.service.js";
import type { NegativeExample } from "../../services/negative-examples.service.js";
import type { JudgeInput } from "../../services/judge.service.js";
import type { FeedbackProductCorrectionContext } from "../../utils/feedback-correction.js";
import type { ParsedJointServiceFluid } from "../../utils/joint-paste.js";

export type ProductKnowledgeLocale = "fr" | "nl" | "pl";

export type RetrieverMetadataFilter = {
  key: string;
  value: string;
  operator: "==";
};

export type RetrieverFilterGroup = {
  filters: RetrieverMetadataFilter[];
  condition: "and";
};

export type JointPasteClarificationContext = {
  effectiveQuestion: string;
  parsedFluid: ParsedJointServiceFluid;
};

export type LegacyClarificationContext = {
  effectiveQuestion: string;
  fluid: string;
};

export type ClarificationContext = JointPasteClarificationContext | LegacyClarificationContext;

export type SessionContextSnapshot = {
  audience: Audience | null;
  geoCountry: string | null;
  geoConsent: boolean | null;
};

export type ComplementaryQuestionBlock = {
  cleaned: string;
  question: string | null;
};

/** Shared mutable state for one chat turn (postChat try-block). */
export interface ChatPipelineBindings {
  completed: boolean;
  req: Request;
  res: Response;
  deps: ChatDeps;
  startedAt: number;
  body: ValidatedChatBody;
  message: string;
  locale: Locale;
  profileFromMetadata: Audience | null;
  sessionId: string;
  geoConsentFromBody?: boolean | undefined;
  geoCountryFromBody: string | null;

  // resolve-session-context
  ttftElapsed?: number;
  sessionContext?: SessionContextSnapshot;
  persistedAudience?: Audience | null;
  detectedAudience?: Audience | null;
  audience?: Audience | null;
  audienceForPersistence?: Audience | null;
  effectiveGeoCountry?: string | null;
  effectiveGeoConsent?: boolean | null;
  allowFrenchStandards?: boolean;
  disallowFrenchStandards?: boolean;
  handoff?: HandoffPayload;
  historyMessages?: StoredMessage[];
  fluidHint?: string | null;
  yesNo?: "yes" | "no" | null;
  previousAssistant?: StoredMessage | undefined;
  previousUserContext?: string;
  sessionDiscussedProduct?: string | null;
  sessionDiscussedSlug?: string | null;
  purchaseFollowUp?: boolean;
  detectedTheme?: ProductTheme | null;
  sessionTheme?: ProductTheme | null;
  themeFromBody?: ProductTheme | null;
  explicitTheme?: ProductTheme | null;
  effectiveTheme?: ProductTheme | null;
  specificClarification?: string | null;
  jointPasteContext?: JointPasteClarificationContext | null;
  legacyClarificationContext?: LegacyClarificationContext | null;
  clarificationContext?: ClarificationContext | null;
  effectiveQuery?: string;
  fluid?: string | null;
  queryForRetrieval?: string;
  expandedRetrievalQuery?: string;

  // run-retrieval-pipeline
  preAnalysisTranscript?: string;
  userCitationScanText?: string;
  citationScanText?: string;
  extractedMeta?: ExtractedMetadata;
  diagnosticResult?: DiagnosticAnalysis;
  descalingPollutant?: RegExp;
  conversationFull?: string;
  pkLocaleEarly?: ProductKnowledgeLocale;
  catalogSizeEarly?: number;
  catalogCitation?: CatalogCitationResult;
  hasCatalogCitation?: boolean;
  explicitProductTargeted?: boolean;
  citeNorm?: string;
  vectorRagLite?: boolean;
  metadataForSearch?: ExtractedMetadata;
  retrievalQueryBase?: string;
  searchQuery?: string;
  informationalRetrievalQuestion?: boolean;
  ongoingConversationEarly?: boolean;
  feedbackCorrection?: FeedbackProductCorrectionContext | null;
  resellerPromise?: Promise<Reseller[]>;
  history?: string;
  ongoingConversation?: boolean;
  priorRecommendedProduct?: string | null;
  productFollowUp?: boolean;
  compatibilitySpecQuestion?: boolean;
  baseFilters?: RetrieverMetadataFilter[];
  applyThemeHardFilter?: boolean;
  themeFilters?: RetrieverMetadataFilter[];
  policyFilters?: RetrieverMetadataFilter[];
  preFilters?: RetrieverFilterGroup;
  pkLocale?: ProductKnowledgeLocale;
  catalogSize?: number;
  retrievalPath?: "product_knowledge" | "vector_rag";
  retrievalCount?: number;
  preTechnicalFilterCount?: number;
  pkResolvedProducts?: ProductKnowledgeRow[];
  pkRenderContext?: ProductKnowledgeRenderContext;
  feedbackQuery?: string;
  feedbackCtx?: FeedbackRetrievalContext;
  feedbackAdjustments?: FeedbackSlugAdjustments;
  feedbackHardPenalties?: string[];
  feedbackHardBoosts?: string[];
  allPenalizedSlugs?: string[];
  cacheKey?: string;
  cached?: CacheEntry | undefined;
  cachedContainsDeprecatedStoreLink?: boolean;
  factualProductMode?: boolean;
  pkProductSlugs?: string[];
  pkRouteTags?: string[];
  resolvedNodes?: unknown[];
  pdfSupplementSlugs?: string[];
  faqContextNodes?: unknown[];
  sourceUrls?: string[];
  conversationTranscript?: string;
  goldenExamples?: GoldenExample[];
  negativeExamples?: NegativeExample[];
  retrieverForAnswer?: ReturnType<VectorStoreIndex["asRetriever"]>;
  catalogAnchorReminder?: string;
  comparisonEligible?: boolean;
  fullQuery?: string;

  // generate-and-stream-reply
  directSheetProduct?: ProductKnowledgeRow | null;
  citedRecommendation?: ProductKnowledgeRow | null;
  directCitedProduct?: ProductKnowledgeRow | null;
  answer?: string;
  contradictedBefore?: boolean;
  extractedProduct?: string | null;
  validProductRecommended?: boolean;
  analyticsAmazonUrl?: string;
  analyticsProduct?: string | null;
  extractedComplementary?: ComplementaryQuestionBlock;
  complementaryContext?: string;
  upsell?: string | null;

  // post-process-reply
  contextChunksForJudge?: JudgeInput["contextChunks"];
  assistantMsgId?: string | null;
  problemClassification?: ProblemClassification;
}
