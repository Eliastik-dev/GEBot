import { COMPLEMENTARY_HINTS } from "../../config/constants.js";
import type { Audience, HandoffPayload, Locale, ProductTheme, Reseller } from "../../types/index.js";
import type { ProductKnowledgeRow } from "../../types/product-knowledge.js";
import { formatUserFacingMismatchNote, normalizeStoredProductTheme } from "../../services/product-theme.service.js";
import { removeAmazonSections, hasValidRecommendedProduct } from "../amazon.js";
import { detectTheme } from "../locale.js";
import { isBuildingSurfaceSealingContext } from "../diagnostic-rules.js";
import { asksMetalThreadPasteJoint } from "../joint-paste.js";
import { decodeHtmlEntities, normalizeText } from "../text.js";


export function buildPurchaseAvailabilityIntro(locale: Locale, productName: string): string {
  const name = decodeHtmlEntities(productName).trim();
  if (locale === "en") return `You can buy **${name}** using the links below.`;
  if (locale === "nl") return `U kunt **${name}** kopen via de onderstaande links.`;
  if (locale === "pl") return `Mozesz kupic **${name}** za pomoca ponizszych linkow.`;
  return `Pour acheter **${name}**, utilisez les liens ci-dessous.`;
}
