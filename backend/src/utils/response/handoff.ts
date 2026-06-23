import { COMPLEMENTARY_HINTS } from "../../config/constants.js";
import type { Audience, HandoffPayload, Locale, ProductTheme, Reseller } from "../../types/index.js";
import type { ProductKnowledgeRow } from "../../types/product-knowledge.js";
import { formatUserFacingMismatchNote, normalizeStoredProductTheme } from "../../services/product-theme.service.js";
import { removeAmazonSections, hasValidRecommendedProduct } from "../amazon.js";
import { detectTheme } from "../locale.js";
import { isBuildingSurfaceSealingContext } from "../diagnostic-rules.js";
import { asksMetalThreadPasteJoint } from "../joint-paste.js";
import { decodeHtmlEntities, normalizeText } from "../text.js";

export function buildHandoff(locale: Locale, audience: Audience | null): HandoffPayload {
  if (!audience) return null;
  const isProfessional = audience === "professional";
  if (locale === "en") {
    return isProfessional
      ? { label: "Contact our Lab", phone: "03 44 88 38 56" }
      : { label: "Contact Consumer Service", phone: "01 48 17 89 82" };
  }
  if (locale === "nl") {
    return isProfessional
      ? { label: "Contacteer ons Lab", phone: "03 44 88 38 56" }
      : { label: "Contacteer Consumentendienst", phone: "01 48 17 89 82" };
  }
  if (locale === "pl") {
    return isProfessional
      ? { label: "Skontaktuj sie z naszym Laboratorium", phone: "03 44 88 38 56" }
      : { label: "Skontaktuj sie z Dzialem Konsumenta", phone: "01 48 17 89 82" };
  }
  return isProfessional
    ? { label: "Contactez notre Laboratoire", phone: "03 44 88 38 56" }
    : { label: "Contactez le Service Consommateurs", phone: "01 48 17 89 82" };
}
export function buildEscalationSection(locale: Locale, audience: Audience | null): string {
  const handoff = buildHandoff(locale, audience);
  if (!handoff) return "";
  return locale === "en"
    ? `### ☎️ Need expert help?\n- [${handoff.label}](tel:${handoff.phone.replace(/\s+/g, "")})`
    : locale === "nl"
      ? `### ☎️ Extra hulp nodig?\n- [${handoff.label}](tel:${handoff.phone.replace(/\s+/g, "")})`
      : locale === "pl"
        ? `### ☎️ Potrzebujesz wsparcia eksperta?\n- [${handoff.label}](tel:${handoff.phone.replace(/\s+/g, "")})`
        : `### ☎️ Besoin d'aide experte ?\n- [${handoff.label}](tel:${handoff.phone.replace(/\s+/g, "")})`;
}
