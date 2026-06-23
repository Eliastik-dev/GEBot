import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "src/utils/response.ts"), "utf8");
const outDir = path.join(root, "src/utils/response");
fs.mkdirSync(outDir, { recursive: true });

const sharedImports = `import { COMPLEMENTARY_HINTS } from "../../config/constants.js";
import type { Audience, HandoffPayload, Locale, ProductTheme, Reseller } from "../../types/index.js";
import type { ProductKnowledgeRow } from "../../types/product-knowledge.js";
import { formatUserFacingMismatchNote, normalizeStoredProductTheme } from "../../services/product-theme.service.js";
import { removeAmazonSections, hasValidRecommendedProduct } from "../amazon.js";
import { detectTheme } from "../locale.js";
import { isBuildingSurfaceSealingContext } from "../diagnostic-rules.js";
import { asksMetalThreadPasteJoint } from "../joint-paste.js";
import { decodeHtmlEntities, normalizeText } from "../text.js";
`;

const handoff = `${sharedImports}
${extractBetween(src, "export function buildHandoff", "function matchesComplementaryHint")}
${extractBetween(src, "export function buildEscalationSection", null)}
`;

const amazon = `${sharedImports}

${extractBetween(src, "export function buildPurchaseAvailabilityIntro", "export function hasStoreSection")}
`;

const reseller = `${sharedImports}
import { buildHandoff } from "./handoff.js";

${extractBetween(src, "export function hasStoreSection", "export function sanitizeDocumentationLinks")}
${extractBetween(src, "export function isResellerIntent", "type DirectProductReplyContext")}
${extractBetween(src, "export function buildResellerSection", "export function buildEscalationSection")}
`;

const reply = `${sharedImports}

${extractBetween(src, "function matchesComplementaryHint", "export function buildComplementarySuggestion")}
${extractBetween(src, "export function buildComplementarySuggestion", "export function buildPurchaseAvailabilityIntro")}
${extractBetween(src, "export function sanitizeDocumentationLinks", "export function isResellerIntent")}
${extractBetween(src, "type DirectProductReplyContext", "export function buildResellerSection")}
`;

const index = `export { buildHandoff, buildEscalationSection } from "./handoff.js";
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
`;

fs.writeFileSync(path.join(outDir, "handoff.ts"), handoff);
fs.writeFileSync(path.join(outDir, "amazon-section.ts"), amazon);
fs.writeFileSync(path.join(outDir, "reseller-section.ts"), reseller);
fs.writeFileSync(path.join(outDir, "reply-templates.ts"), reply);
fs.writeFileSync(path.join(outDir, "index.ts"), index);

function extractBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing: ${startMarker}`);
  const end = endMarker ? text.indexOf(endMarker, start + startMarker.length) : text.length;
  if (endMarker && end < 0) throw new Error(`Missing end: ${endMarker}`);
  return text.slice(start, end).trimEnd();
}

console.log("Split response.ts into", outDir);
