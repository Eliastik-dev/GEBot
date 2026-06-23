export { buildHandoff, buildEscalationSection } from "./handoff.js";
export { buildPurchaseAvailabilityIntro } from "./amazon-section.js";
export { buildResellerSection, hasStoreSection, isResellerIntent } from "./reseller-section.js";
export {
  buildComplementarySuggestion,
  isYesNoAnswer,
  isComplementaryQuestion,
  buildComplementaryFollowUp,
  extractComplementaryQuestionBlock,
  stripLeadingConversationGreeting,
  removeComplementaryQuestionBlocks,
  sanitizeDocumentationLinks,
  buildPipeGasClarification,
  buildPersonalDrinkwareOutOfScopeReply,
  containsOffTopicSink,
  hasSinkTopic,
  hasPipeTopic,
  buildDirectTechnicalSheetReply,
  buildDirectCitedProductReply,
  compactProductFollowUpAnswer,
  stripAnswerWithoutProductRecommendation,
  answerProvidesProductGuidance,
  answerContradictsRecommendation,
  stripContradictoryProductRecommendation,
  isGratitudeOrClosingMessage,
  buildGratitudeReply,
  buildMoreDetailsForProductRequest,
} from "./reply-templates.js";
