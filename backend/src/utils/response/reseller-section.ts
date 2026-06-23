import { COMPLEMENTARY_HINTS } from "../../config/constants.js";
import type { Audience, HandoffPayload, Locale, ProductTheme, Reseller } from "../../types/index.js";
import type { ProductKnowledgeRow } from "../../types/product-knowledge.js";
import { formatUserFacingMismatchNote, normalizeStoredProductTheme } from "../../services/product-theme.service.js";
import { removeAmazonSections, hasValidRecommendedProduct } from "../amazon.js";
import { detectTheme } from "../locale.js";
import { isBuildingSurfaceSealingContext } from "../diagnostic-rules.js";
import { asksMetalThreadPasteJoint } from "../joint-paste.js";
import { decodeHtmlEntities, normalizeText } from "../text.js";

import { buildHandoff } from "./handoff.js";

export function hasStoreSection(answer: string): boolean {
  const normalized = normalizeText(answer);
  return (
    normalized.includes("trouver un magasin") ||
    normalized.includes("trouver un revendeur") ||
    normalized.includes("find a store") ||
    normalized.includes("find a reseller") ||
    normalized.includes("revendeurs geb") ||
    normalized.includes("annuaire officiel des revendeurs") ||
    normalized.includes("ou acheter") ||
    normalized.includes("disponibilite")
  );
}
export function isResellerIntent(message: string): boolean {
  const normalized = normalizeText(message);
  return (
    normalized.includes("revendeur") ||
    normalized.includes("revendeurs") ||
    normalized.includes("store") ||
    normalized.includes("dealer") ||
    normalized.includes("magasin") ||
    normalized.includes("winkel") ||
    normalized.includes("sklep")
  );
}
export function buildResellerSection(locale: Locale, resellers: Reseller[]): string {
  if (resellers.length === 0) return "";
  const headingByLocale: Record<Locale, string> = {
    fr: "### 🏬 Trouver un magasin",
    en: "### 🏬 Find a Store",
    nl: "### 🏬 Vind een winkel",
    pl: "### 🏬 Znajdz sklep",
  };
  const lines = resellers.slice(0, 4).map((reseller) => {
    const details = [reseller.city, reseller.country].filter(Boolean).join(", ");
    const label = reseller.url ? `[${reseller.name}](${reseller.url})` : reseller.name;
    return `- ${label}${details ? ` - ${details}` : ""}`;
  });
  return `${headingByLocale[locale]}\n${lines.join("\n")}`;
}
