import { COMPLEMENTARY_HINTS } from "../../config/constants.js";
import type { Audience, HandoffPayload, Locale, ProductTheme, Reseller } from "../../types/index.js";
import type { ProductKnowledgeRow } from "../../types/product-knowledge.js";
import { formatUserFacingMismatchNote, normalizeStoredProductTheme } from "../../services/product-theme.service.js";
import { removeAmazonSections, hasValidRecommendedProduct } from "../amazon.js";
import { detectTheme } from "../locale.js";
import { isBuildingSurfaceSealingContext } from "../diagnostic-rules.js";
import { asksMetalThreadPasteJoint } from "../joint-paste.js";
import { decodeHtmlEntities, normalizeText } from "../text.js";


function matchesComplementaryHint(text: string, item: (typeof COMPLEMENTARY_HINTS)[number]): boolean {
  const lower = text.toLowerCase();
  const n = normalizeText(text);
  if (!item.keywords.some((k) => lower.includes(k))) return false;

  if (isBuildingSurfaceSealingContext(text)) {
    if (item.id === "ptfe" || item.id === "plumbing_seal") return false;
    if (item.id === "surface_cleaner") return false;
  }

  if (item.context === "plumbing_thread") {
    return (
      asksMetalThreadPasteJoint(text) ||
      /\b(raccord|filetage|filete|plomberie|canalisation|tube|tuyau)\b/.test(n)
    );
  }

  return true;
}
export function buildComplementarySuggestion(locale: Locale, audience: Audience, message: string): string {
  const match = COMPLEMENTARY_HINTS.find((item) => matchesComplementaryHint(message, item));
  if (!match) return "";
  if (locale === "nl") {
    return `Wilt u ook het aanvullende product ${match.product.nl} voor een complete oplossing?\n_Reageer eenvoudig met: ja of nee._`;
  }
  if (locale === "pl") {
    return `Czy chcesz rowniez poznac produkt uzupelniajacy ${match.product.pl} dla kompletnego rozwiazania?\n_Odpowiedz po prostu: tak lub nie._`;
  }
  if (locale === "en") {
    return `Would you also like the complementary product ${match.product.en} for a complete fix?\n_Reply simply with: yes or no._`;
  }
  const profileLabel = audience === "professional" ? "votre chantier" : "votre installation";
  return `Souhaitez-vous aussi connaitre le produit complementaire ${match.product.fr} pour ${profileLabel} ?\n_Repondez simplement : oui ou non._`;
}


export function isYesNoAnswer(message: string): "yes" | "no" | null {
  const normalized = normalizeText(message).trim();
  if (["oui", "yes", "ja", "tak", "ok", "d accord", "dac"].includes(normalized)) return "yes";
  if (["non", "no", "nee", "nie"].includes(normalized)) return "no";
  return null;
}


export function isComplementaryQuestion(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    normalized.includes("produit complementaire") ||
    normalized.includes("produits complementaires") ||
    normalized.includes("solution complete") ||
    normalized.includes("reply simply with") ||
    normalized.includes("oui ou non") ||
    normalized.includes("yes or no")
  );
}


export function buildComplementaryFollowUp(locale: Locale, answer: "yes" | "no", sourceMessage: string): string {
  if (answer === "no") {
    if (locale === "en") return "Understood. We stay on the current solution.";
    if (locale === "nl") return "Begrepen. We blijven bij de huidige oplossing.";
    if (locale === "pl") return "Rozumiem. Pozostajemy przy obecnym rozwiazaniu.";
    return "Parfait, nous restons sur la solution actuelle.";
  }

  const match = COMPLEMENTARY_HINTS.find((item) => matchesComplementaryHint(sourceMessage, item));
  if (!match) {
    if (locale === "en") return "Great. I can suggest a complementary product once you confirm the exact application details.";
    if (locale === "nl") return "Prima. Ik kan een aanvullend product voorstellen zodra u de exacte toepassing bevestigt.";
    if (locale === "pl") return "Swietnie. Mogę zaproponowac produkt uzupelniajacy po potwierdzeniu dokladnego zastosowania.";
    return "Tres bien. Je peux proposer un produit complementaire des que vous confirmez l'application exacte.";
  }

  if (locale === "en") return `Great. Complementary product to consider: **${match.product.en}**.`;
  if (locale === "nl") return `Prima. Aanvullend product om te overwegen: **${match.product.nl}**.`;
  if (locale === "pl") return `Swietnie. Produkt uzupelniajacy do rozważenia: **${match.product.pl}**.`;
  return `Parfait. Produit complementaire a considerer : **${match.product.fr}**.`;
}


export function extractComplementaryQuestionBlock(answer: string): { cleaned: string; question: string | null } {
  const lines = answer.split("\n");
  const questionLines: string[] = [];
  const keptLines: string[] = [];

  for (const line of lines) {
    const normalized = normalizeText(line);
    const isQuestionLine =
      normalized.includes("produit complementaire") ||
      normalized.includes("produits complementaires") ||
      normalized.includes("repondez simplement") ||
      normalized.includes("reply simply with") ||
      normalized.includes("oui ou non") ||
      normalized.includes("yes or no");
    if (isQuestionLine) {
      questionLines.push(line.trim());
      continue;
    }
    keptLines.push(line);
  }

  const cleaned = keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const question = questionLines.length > 0 ? questionLines.join("\n").trim() : null;
  return { cleaned, question };
}


const STANDALONE_GREETING_LINE =
  /^\s*(?:bonjour|bonsoir|salut|hello|hi|good\s+(?:morning|afternoon|evening)|hallo|goedendag|goedemorgen|dzie[nń]\s+dobry|czesc|witam)\b[!.,:;\s—–-]*.*$/i;

const INLINE_GREETING_PREFIX =
  /^\s*(?:bonjour|bonsoir|salut|hello|hi|hallo|goedendag|dzie[nń]\s+dobry|czesc|witam)\s*[,!:;.-]+\s+/i;

/** Remove repeated hello when the session is already in progress. */
export function stripLeadingConversationGreeting(answer: string, ongoingConversation: boolean): string {
  if (!ongoingConversation || !answer.trim()) return answer;

  let text = answer.trim();
  for (let guard = 0; guard < 4; guard += 1) {
    const lines = text.split("\n");
    const first = lines[0]?.trim() ?? "";
    if (!first || first.includes("###") || first.length > 200) break;
    if (!STANDALONE_GREETING_LINE.test(first)) break;
    const rest = lines.slice(1).join("\n").trim();
    if (!rest) break;
    text = rest;
  }

  const inlineStripped = text.replace(INLINE_GREETING_PREFIX, "");
  return inlineStripped.trim() || answer.trim();
}

export function removeComplementaryQuestionBlocks(answer: string): string {
  const patterns = [
    /seriez[-\s]*vous[^.\n]*produits? complementaires?[\s\S]*?(oui ou non|yes or no)\.?/gi,
    /souhaitez[-\s]*vous[^.\n]*produit complementaire[\s\S]*?(oui ou non|yes or no)\.?/gi,
    /repondez simplement\s*:\s*(oui ou non|yes or no)\.?/gi,
  ];
  let sanitized = answer;
  for (const pattern of patterns) {
    sanitized = sanitized.replace(pattern, "");
  }
  return sanitized.replace(/\n{3,}/g, "\n\n").trim();
}
export function sanitizeDocumentationLinks(answer: string): string {
  let out = answer.replace(/\[([^\]]*fiche technique[^\]]*)\]\(([^)]+)\)/gi, (_match, _label, url) => {
    const normalizedUrl = String(url).toLowerCase();
    const looksLikePdf = normalizedUrl.includes(".pdf");
    if (looksLikePdf) {
      return `[Fiche Technique](${url})`;
    }
    return `[Consulter la source catalogue](${url})`;
  });
  out = out.replace(
    /\[([^\]]*(?:fds|sds|données de sécurité|donnees de securite|safety data)[^\]]*)\]\(([^)]+)\)/gi,
    (_match, _label, url) => `[Fiche de Données de Sécurité (FDS)](${url})`,
  );
  return out;
}


export function buildPipeGasClarification(locale: Locale): string {
  if (locale === "en") {
    return "I cannot confirm a sink-specific product here. For a PVC gas pipe, I need the exact use (threaded fitting, flange, temporary leak), diameter, and gas type to recommend the correct certified product.";
  }
  if (locale === "nl") {
    return "Ik kan hier geen gootsteenproduct bevestigen. Voor een PVC-gasleiding heb ik de exacte toepassing nodig (schroefdraad, koppeling, tijdelijke lekdichting), de diameter en het type gas om het juiste gecertificeerde product aan te bevelen.";
  }
  if (locale === "pl") {
    return "Nie moge potwierdzic produktu do zlewu w tym przypadku. Dla rury PVC z gazem potrzebuje dokladnego zastosowania (gwint, zlacze, tymczasowe uszczelnienie), srednicy i rodzaju gazu, aby polecic wlasciwy certyfikowany produkt.";
  }
  return "Je ne peux pas confirmer un produit pour evier ici. Pour un tuyau PVC transportant du gaz, j'ai besoin de l'usage exact (filetage, raccord, fuite temporaire), du diametre et du type de gaz pour recommander un produit certifie adapte.";
}


/** Gourde / bouteille perso : pas de produits plomberie (Gebétanche, pâte joint, résine raccord…). */
export function buildPersonalDrinkwareOutOfScopeReply(locale: Locale, audience: Audience | null): string {
  const handoff =
    audience === "professional"
      ? locale === "en"
        ? "our Lab"
        : locale === "nl"
          ? "ons Lab"
          : locale === "pl"
            ? "Laboratorium"
            : "notre Laboratoire"
      : locale === "en"
        ? "Consumer Service"
        : locale === "nl"
          ? "Consumentendienst"
          : locale === "pl"
            ? "Dział Konsumenta"
            : "Service Consommateurs";

  if (locale === "en") {
    return `For a personal reusable water bottle or drinkware, the GEB catalogue focuses on plumbing, building and professional heating — not sealing this type of consumer container. **Do not** use plumbing products (thread sealants, pipe jointing pastes, liquid resins for threaded fittings, Gebétanche-style pipe sealants): they are not designed for a rigid plastic bottle and are not validated for drink-contact repair in this context. I cannot recommend a GEB SKU here. Please contact ${handoff} if you have another GEB product line in mind, or the bottle manufacturer / consider replacing the bottle for food-contact safety.`;
  }
  if (locale === "nl") {
    return `Voor een persoonlijke drinkfles of herbruikbare gourde valt de GEB-catalogus buiten scope: wij richten ons op sanitair, bouw en professionele installaties. **Gebruik geen** leidingproducten (dichtingspasta voor schroefdraad, PTFE/filasse, vloeibare hars voor fittingen, Gebétanche-achtige leidingafdichting) op een plastic drinkfles — niet bedoeld voor dit gebruik en niet geschikt voor drinkwater in deze context. Geen GEB-productaanbeveling mogelijk. Neem contact op met ${handoff} of met de fabrikant / vervang de fles om veiligheidsredenen.`;
  }
  if (locale === "pl") {
    return `W przypadku osobistej butelki na napoje lub bidonu katalog GEB obejmuje instalacje sanitarne i budowlane — nie naprawę takiego pojemnika. **Nie stosuj** produktów instalacyjnych (pasty do gwintów, taśm uszczelniających, żywic do połączeń rurowych, uszczelniaczy typu Gebétanche): nie są przeznaczone do twardego plastiku butelki ani do kontaktu z wodą pitną w tym zastosowaniu. Nie mogę polecić SKU GEB. Skontaktuj się z ${handoff} lub producentem / rozważ wymianę butelki.`;
  }
  return `Pour une **gourde** ou bouteille de boisson personnelle (réutilisable), le catalogue GEB couvre la plomberie, le bâtiment et le chauffage professionnel — **pas** l’étanchéité de ce type de récipient. Il ne faut **surtout pas** utiliser les produits canalisation du chat (Gebétanche, pâte à joint pour filetages, résine pour raccords filetés, PTFE/filasse) : ils ne sont pas prévus pour réparer une gourde en plastique dur et ne sont pas validés pour une réparation au contact de l’eau de boisson. Je ne peux donc pas recommander de produit GEB ici. Contactez le **${handoff}** pour une autre gamme GEB le cas échéant, le fabricant de la gourde, ou envisagez le remplacement de l’article pour la sécurité alimentaire.`;
}

export function containsOffTopicSink(answer: string, question: string): boolean {
  const answerNorm = normalizeText(answer);
  if (!/\b(evier|sink|spoelbak|zlew)\b/.test(answerNorm)) return false;
  return !hasSinkTopic(question) && hasPipeTopic(question);
}


export function hasSinkTopic(message: string): boolean {
  const normalized = normalizeText(message);
  return /\b(evier|eviers|sink|lavabo|spoelbak|zlew)\b/.test(normalized);
}


export function hasPipeTopic(message: string): boolean {
  const normalized = normalizeText(message);
  return /\b(tuyau|tube|canalisation|pipe|pvc|raccord)\b/.test(normalized);
}
type DirectProductReplyContext = {
  sessionAudience?: Audience | null;
  sessionTheme?: ProductTheme | null;
  /** Réponse après 👎 + produit attendu — pas de « Oui, catalogue ». */
  feedbackCorrection?: boolean;
};

function sanitizeCatalogSummary(raw: string | null | undefined, locale: Locale): string {
  let s = decodeHtmlEntities(raw ?? "").trim();
  s = s.replace(/^[^.]+\(synthèse heuristique[^)]*\)\.\s*/i, "");
  s = s.replace(/^[^.]+\(synthèse heuristique[^)]*\)\s*/i, "");
  s = s.replace(/GEB SAS[\s\S]*?www\.geb\.fr\s*/gi, "");
  s = s.replace(/T[ée]l\s*:[\s\S]*?Fax\s*:[\s\S]*?geb\.fr\s*/gi, "");
  s = s.replace(/E-Labo-\d+/gi, "");
  s = s.replace(/Fiche Technique[\s\S]*?Version\s*:\s*\d+/gi, "");
  s = s.replace(/page\s+\d+\s+sur\s+\d+/gi, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 280) {
    const cut = s.slice(0, 280);
    const lastPeriod = cut.lastIndexOf(".");
    s = lastPeriod > 100 ? cut.slice(0, lastPeriod + 1) : `${cut.trimEnd()}…`;
  }
  return s || catalogSummaryFallback(locale);
}

function formatProductUtilisationLine(product: ProductKnowledgeRow, locale: Locale): string {
  const fallback =
    locale === "en"
      ? "Not specified in the sheet."
      : locale === "nl"
        ? "Niet vermeld in de fiche."
        : locale === "pl"
          ? "Nie podano w karcie."
          : "Non précisé dans la fiche.";
  const apps = Array.isArray(product.applications) ? product.applications : [];
  if (apps.length > 0) {
    return apps
      .slice(0, 2)
      .map((app) => `${app.context}: ${app.description}${app.constraints ? ` (${app.constraints})` : ""}`)
      .join(" ; ");
  }
  const parts = [product.supports?.trim(), product.curing_time?.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join(" — ") : fallback;
}

function directCitedIntro(locale: Locale, name: string, mismatch: string, ctx?: DirectProductReplyContext): string {
  if (ctx?.feedbackCorrection) {
    if (locale === "en") return `Here is the GEB catalogue product that fits your need.`;
    if (locale === "nl") return `Hier is het GEB-catalogusproduct dat bij uw vraag past.`;
    if (locale === "pl") return `Oto produkt z katalogu GEB odpowiadajacy na Pana/Pani potrzebe.`;
    return `Voici le produit GEB du catalogue adapte a votre besoin.`;
  }
  if (locale === "en") return `Yes — **${name}** is in the GEB catalogue.${mismatch}`;
  if (locale === "nl") return `Ja — **${name}** staat in de GEB-catalogus.${mismatch}`;
  if (locale === "pl") return `Tak — **${name}** jest w katalogu GEB.${mismatch}`;
  return `Oui — **${name}** fait partie du catalogue GEB.${mismatch}`;
}

function directProductMismatchNote(locale: Locale, product: ProductKnowledgeRow, ctx?: DirectProductReplyContext): string {
  if (!ctx?.sessionAudience && !ctx?.sessionTheme) return "";
  const note = formatUserFacingMismatchNote({
    sessionAudience: ctx.sessionAudience,
    sessionTheme: ctx.sessionTheme,
    product: {
      canonical_name: product.canonical_name,
      slug: product.slug,
      audience: product.audience,
      theme: normalizeStoredProductTheme(product.theme),
    },
    locale,
  });
  return note ? `\n\n${note}` : "";
}

/** Deterministic MODE 2 answer when a technical sheet was explicitly requested and matched in catalogue. */
export function buildDirectTechnicalSheetReply(
  locale: Locale,
  product: ProductKnowledgeRow,
  ctx?: DirectProductReplyContext,
): string {
  const name = decodeHtmlEntities(product.canonical_name).trim();
  const summary = sanitizeCatalogSummary(product.summary_technical, locale);
  const utilisation = formatProductUtilisationLine(product, locale);
  const ftLine = product.ft_url
    ? `- [Fiche Technique](${product.ft_url})`
    : locale === "en"
      ? "- Technical sheet: Not specified in the catalogue record"
      : "- Fiche technique : Non précisé dans la fiche";
  const fdsLine = product.fds_url
    ? `- [Fiche de Données de Sécurité (FDS)](${product.fds_url})`
    : locale === "en"
      ? "- SDS: Not specified in the catalogue record"
      : "- FDS : Non précisé dans la fiche";

  const mismatch = directProductMismatchNote(locale, product, ctx);

  if (locale === "en") {
    return `Here is the technical sheet for **${name}**.${mismatch}

### 📦 Recommended Product: **${name}**
- **Description:** ${summary}
- **Utilisation / Application:** ${utilisation}

### 📄 Official Documentation
${ftLine}
${fdsLine}`;
  }
  if (locale === "nl") {
    return `Hier is de technische fiche van **${name}**.${mismatch}

### 📦 Aanbevolen product: **${name}**
- **Beschrijving:** ${summary}
- **Utilisation / Application:** ${utilisation}

### 📄 Officiële documentatie
${ftLine}
${fdsLine}`;
  }
  if (locale === "pl") {
    return `Oto karta techniczna produktu **${name}**.${mismatch}

### 📦 Rekomendowany produkt: **${name}**
- **Opis:** ${summary}
- **Utilisation / Application:** ${utilisation}

### 📄 Dokumentacja oficialna
${ftLine}
${fdsLine}`;
  }

  return `Voici la fiche technique du **${name}**.${mismatch}

### 📦 Produit Recommandé : **${name}**
- **Description :** ${summary}
- **Utilisation / Application :** ${utilisation}

### 📄 Documentation Officielle
${ftLine}
${fdsLine}`;
}

function catalogSummaryFallback(locale: Locale): string {
  if (locale === "en") return "GEB catalogue product.";
  if (locale === "nl") return "GEB-catalogusproduct.";
  if (locale === "pl") return "Produkt z katalogu GEB.";
  return "Produit du catalogue GEB.";
}

function documentationLines(locale: Locale, product: ProductKnowledgeRow): { ftLine: string; fdsLine: string } {
  const ftLine = product.ft_url
    ? `- [Fiche Technique](${product.ft_url})`
    : locale === "en"
      ? "- Technical sheet: Not specified in the catalogue record"
      : "- Fiche technique : Non précisé dans la fiche";
  const fdsLine = product.fds_url
    ? `- [Fiche de Données de Sécurité (FDS)](${product.fds_url})`
    : locale === "en"
      ? "- SDS: Not specified in the catalogue record"
      : "- FDS : Non précisé dans la fiche";
  return { ftLine, fdsLine };
}

/** Deterministic MODE 2 when the user cites a catalogue product by name. */
export function buildDirectCitedProductReply(
  locale: Locale,
  product: ProductKnowledgeRow,
  ctx?: DirectProductReplyContext,
): string {
  const name = decodeHtmlEntities(product.canonical_name).trim();
  const summary = sanitizeCatalogSummary(product.summary_technical, locale);
  const utilisation = formatProductUtilisationLine(product, locale);
  const { ftLine, fdsLine } = documentationLines(locale, product);

  const mismatch = directProductMismatchNote(locale, product, ctx);
  const intro = directCitedIntro(locale, name, mismatch, ctx);

  if (locale === "en") {
    return `${intro}

### 📦 Recommended Product: **${name}**
- **Description:** ${summary}
- **Utilisation / Application:** ${utilisation}

### 📄 Official Documentation
${ftLine}
${fdsLine}`;
  }
  if (locale === "nl") {
    return `${intro}

### 📦 Aanbevolen product: **${name}**
- **Beschrijving:** ${summary}
- **Utilisation / Application:** ${utilisation}

### 📄 Officiële documentatie
${ftLine}
${fdsLine}`;
  }
  if (locale === "pl") {
    return `${intro}

### 📦 Rekomendowany produkt: **${name}**
- **Opis:** ${summary}
- **Utilisation / Application:** ${utilisation}

### 📄 Dokumentacja oficialna
${ftLine}
${fdsLine}`;
  }

  return `${intro}

### 📦 Produit Recommandé : **${name}**
- **Description :** ${summary}
- **Utilisation / Application :** ${utilisation}

### 📄 Documentation Officielle
${ftLine}
${fdsLine}`;
}

/**
 * On product follow-ups, keep only conversational prose — drop repeated MODE 2 blocks.
 */
export function compactProductFollowUpAnswer(answer: string, priorProduct: string | null): string {
  if (!priorProduct?.trim() || !answer.trim()) return answer;
  const hasProductBlock = /###\s*📦\s*Produit Recommand/i.test(answer);
  if (!hasProductBlock) return answer;

  const stripped = removeAmazonSections(answer);
  const productIdx = stripped.search(/###\s*📦\s*Produit Recommand/i);
  if (productIdx < 0) return stripped.trim();

  const opening = stripped.slice(0, productIdx).trim();
  const afterProduct = stripped.slice(productIdx);
  const docParts = afterProduct.split(/###\s*📄\s*Documentation[^\n]*/i);
  const closing =
    docParts.length > 1
      ? docParts[1]!
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !/^[-*]\s*\[/.test(line) && !/^https?:\/\//i.test(line))
          .join("\n")
          .trim()
      : afterProduct
          .replace(/###\s*📦\s*Produit Recommand[^\n]*[\s\S]*/i, "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !/^[-*]\s/.test(line) && !/^###\s/.test(line))
          .join("\n")
          .trim();

  const compacted =
    closing.length >= 20
      ? closing
      : [opening, closing].filter(Boolean).join("\n\n");
  if (!compacted.trim()) {
    return stripAnswerWithoutProductRecommendation(stripped).replace(/\n{3,}/g, "\n\n").trim() || answer.trim();
  }

  return compacted.replace(/\n{3,}/g, "\n\n").trim();
}

/** Strip purchase / store / documentation blocks when no product could be recommended. */
export function stripAnswerWithoutProductRecommendation(answer: string): string {
  let out = answer;
  out = out.replace(/\n?###\s*📄\s*Documentation Officielle[\s\S]*?(?=\n###\s|$)/gi, "");
  out = out.replace(/\n?###\s*🛒[\s\S]*?(?=\n###\s|$)/gi, "");
  out = out.replace(/\n?###\s*🏬[\s\S]*?(?=\n###\s|$)/gi, "");
  out = out.replace(/\n?###\s*📦\s*Produit Recommandé[\s\S]*?(?=\n###\s|$)/gi, "");
  out = out.replace(/\n?###\s*📦\s*Recommended Product[\s\S]*?(?=\n###\s|$)/gi, "");
  out = out.replace(/\nhttps?:\/\/[^\s]+\.pdf[^\s]*/gi, "");
  out = out.replace(/\n-\s*\[Consulter la [^\]]+\]\([^)]+\)/gi, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** True when the answer already names a product or gives actionable guidance (skip generic follow-up). */
export function answerProvidesProductGuidance(answer: string): boolean {
  if (/solution\s+adapt[eé]e\s*:\s*\S+/i.test(answer)) return true;
  if (/produit\s+(conseill[eé]|sugg[eé]r[eé])\s*:\s*\S+/i.test(answer)) return true;
  if (/orient[eé]\s+vers\s+(le\s+)?service\s+consommateurs/i.test(answer)) return true;
  if (/contactez\s+(le\s+)?service\s+consommateurs/i.test(answer)) return true;
  if (/aucun\s+(des\s+)?produits?\s+geb/i.test(answer) && /\bgeb[\wéèêë\-+]+\b/i.test(answer)) return true;
  return false;
}

const INCOMPATIBILITY_OPENING_RE =
  /\b(n['']?est\s+pas\s+adapt[eé]|pas\s+adapt[eé]|n['']?est\s+pas\s+le\s+bon|ne\s+convient\s+pas|inadapt[eé]|pas\s+un\s+mastic\s+de\s+surface|pas\s+pour\s+(l['']?eau\s+de\s+)?piscine|con[cç]u\s+pour\s+l['']?echappement|pas\s+pour\s+les?\s+joints?\s+visibles?)\b/i;

/** LLM wrote that the recommended product is unsuitable while still outputting MODE 2. */
export function answerContradictsRecommendation(answer: string): boolean {
  if (!hasValidRecommendedProduct(answer)) return false;
  const productIdx = answer.search(/###\s*📦\s*Produit Recommand/i);
  if (productIdx < 0) return false;
  const opening = answer.slice(0, productIdx);
  return INCOMPATIBILITY_OPENING_RE.test(openizeText(opening));
}

function openizeText(text: string): string {
  return normalizeText(text);
}

/** Strip MODE 2 block when the opening contradicts the recommendation. */
export function stripContradictoryProductRecommendation(answer: string): string {
  if (!answerContradictsRecommendation(answer)) return answer;
  const stripped = stripAnswerWithoutProductRecommendation(removeAmazonSections(answer));
  const opening = stripped.trim();
  if (opening.length >= 40) return opening;
  return (
    opening +
    "\n\nPour vous orienter vers le bon produit GEB, pouvez-vous préciser le support (émail, carrelage, PVC…) et si le joint est visible ou s'il s'agit d'un raccord fileté ?"
  ).trim();
}

/** Short closing messages — no new retrieval. */
export function isGratitudeOrClosingMessage(message: string): boolean {
  const n = normalizeText(message).replace(/[!?.…]+/g, "").trim();
  if (n.length > 80) return false;
  return (
    /^(merci|merci beaucoup|ok merci|parfait merci|super merci|tres bien merci|bien merci|c est bon|cest bon|parfait|super|tres bien|bien recu|a plus|au revoir|bonne journee|bonne soiree|thanks|thank you|dank je|dank u|dziekuje|dzieki)$/.test(
      n,
    ) ||
    (/^(merci|thanks|dziekuje)\b/.test(n) && n.split(/\s+/).length <= 6)
  );
}

export function buildGratitudeReply(locale: Locale, audience: Audience | null): string {
  if (locale === "en") {
    return audience === "professional"
      ? "You're welcome. Feel free to reach out if you need anything else — our Lab is here for technical follow-up."
      : "You're welcome. Don't hesitate if you have another question.";
  }
  if (locale === "nl") {
    return audience === "professional"
      ? "Graag gedaan. Aarzel niet om opnieuw contact op te nemen — ons Lab staat klaar voor technische opvolging."
      : "Graag gedaan. Aarzel niet als u nog een vraag heeft.";
  }
  if (locale === "pl") {
    return audience === "professional"
      ? "Proszę bardzo. W razie kolejnych pytań — nasze Laboratorium pomoże w kwestiach technicznych."
      : "Proszę bardzo. Zapraszam, jeśli będzie Pan/Pani miał/a kolejne pytania.";
  }
  return audience === "professional"
    ? "Avec plaisir. N'hésitez pas si vous avez d'autres questions — notre Laboratoire reste disponible pour le suivi technique."
    : "Avec plaisir. N'hésitez pas si vous avez d'autres questions sur votre installation.";
}

export function buildMoreDetailsForProductRequest(
  locale: Locale,
  audience: Audience | null,
  message?: string,
): string {
  const isPro = audience === "professional";
  const normalized = message ? normalizeText(message) : "";
  const theme = message ? detectTheme(message) : null;
  const isFaucet =
    /\b(robinet|mousseur|mitigeur|bec|cartouche|perlateur|tap|faucet|aerator)\b/.test(normalized);
  const isRoofOrBuilding =
    theme === "batiment" ||
    /\b(toiture|zinc|facade|gouttiere|membrane|etancheite|bardage|charpente)\b/.test(normalized);
  const isPool = theme === "piscine" || /\b(piscine|liner|bassin|pool)\b/.test(normalized);
  const isPipe =
    /\b(tuyau|canalisation|tube|raccord|pipe|pvc|evacuation)\b/.test(normalized) && !isFaucet;

  if (locale === "en") {
    if (isFaucet) {
      return isPro
        ? "### 💡 To find a suitable GEB product\nPlease specify:\n- Exact leak location (thread, cartridge, aerator, seal)\n- Tap material if known (brass, chrome fitting)\n- Whether the installation is under pressure or dripping when closed\n- Any product reference already on site"
        : "### 💡 To find a suitable GEB product\nPlease specify:\n- Where exactly it leaks (thread, aerator, internal seal)\n- Tap type / brand if known\n- Photo or short description of the fitting\n- Whether water drips when the tap is closed";
    }
    if (isRoofOrBuilding) {
      return "### 💡 To find a suitable GEB product\nPlease specify:\n- **Substrate** (zinc, tile, membrane, other)\n- **Exact area** (ridge, joint, penetration, gutter)\n- **Exposure** to weather and current surface condition\n- A **photo** of the area if possible";
    }
    if (isPool) {
      return "### 💡 To find a suitable GEB product\nPlease specify:\n- **Pool type** (liner, polyester shell, tiled)\n- **Leak location** (skimmer, return, liner tear, joint)\n- Whether the pool is **full or empty**\n- A **photo** if possible";
    }
    if (isPipe) {
      return "### 💡 To find a suitable GEB product\nPlease specify:\n- **Pipe material** and diameter if known\n- **Leak location** (joint, crack, threaded fitting)\n- **Fluid** in contact and whether it is under pressure\n- A **photo** if possible";
    }
    return "### 💡 To find a suitable GEB product\nPlease specify:\n- **Substrate** and exact location of the issue\n- **Fluid or environment** in contact (if any)\n- **Context** (indoor/outdoor, pressurized or not)\n- A **photo** or short description if possible";
  }
  if (locale === "nl") {
    if (isFaucet) {
      return "### 💡 Meer details nodig\n- Exacte plaats van het lek (draad, sifon, perlator)\n- Materiaal van de kraan indien bekend\n- Onder druk of druppelend bij gesloten stand";
    }
    if (isRoofOrBuilding) {
      return "### 💡 Meer details nodig\n- **Ondergrond** (zink, tegel, membraan)\n- **Exacte zone** (nok, aansluiting, doorvoer)\n- **Weersomstandigheden** en huidige staat van het oppervlak\n- Een **foto** indien mogelijk";
    }
    return "### 💡 Meer details nodig\n- **Ondergrond** en exacte plaats\n- **Medium of omgeving** in contact (indien van toepassing)\n- **Context** (binnen/buiten, onder druk of niet)\n- Een **foto** of korte beschrijving indien mogelijk";
  }
  if (locale === "pl") {
    if (isFaucet) {
      return "### 💡 Potrzebujemy wiecej szczegolow\n- Dokladne miejsce wycieku (gwint, aerator, uszczelka)\n- Material baterii jesli znany\n- Czy kapi przy zamknietym zaworze";
    }
    if (isRoofOrBuilding) {
      return "### 💡 Potrzebujemy wiecej szczegolow\n- **Podloze** (cynk, dachowka, membrana)\n- **Dokladna strefa** (kalenica, polaczenie, przejscie)\n- **Ekspozycja** na warunki atmosferyczne\n- **Zdjecie** jesli mozliwe";
    }
    return "### 💡 Potrzebujemy wiecej szczegolow\n- **Podloze** i dokladne miejsce\n- **Czynnik lub srodowisko** w kontakcie (jesli dotyczy)\n- **Kontekst** (wewnatrz/na zewnatrz, pod cisnieniem lub nie)\n- **Zdjecie** lub krotki opis jesli mozliwe";
  }
  if (isFaucet) {
    return isPro
      ? "### 💡 Pour identifier un produit GEB adapté\nMerci de préciser encore :\n- **Emplacement exact** de la fuite (filetage, cartouche, joint du mousseur, base du bec)\n- **Matière** du robinet / raccord si vous la connaissez\n- **Contexte** : goutte à l'arrêt, fuite au débit ouvert, eau chaude ou froide\n- **Référence** ou photo du modèle si possible"
      : "### 💡 Pour identifier un produit GEB adapté\nMerci de préciser encore :\n- **Où** ça fuit exactement (filetage du mousseur, joint interne, base du robinet)\n- **Type de robinet** ou marque si vous la connaissez\n- Est-ce que ça goutte **robinet fermé** ou seulement à l'ouverture ?\n- Une **photo** ou le modèle du robinet si possible";
  }
  if (isRoofOrBuilding) {
    return "### 💡 Pour identifier un produit GEB adapté\nMerci de préciser encore :\n- **Support** concerné (zinc, tuile, membrane, autre)\n- **Zone exacte** (faîtage, noue, raccord, point de pénétration)\n- **Exposition** aux intempéries et état actuel de la surface\n- Une **photo** de la zone si possible";
  }
  if (isPool) {
    return "### 💡 Pour identifier un produit GEB adapté\nMerci de préciser encore :\n- **Type de bassin** (liner, coque polyester, carrelé)\n- **Emplacement** de la fuite (skimmer, refoulement, déchirure liner, joint)\n- Bassin **plein ou vidé**\n- Une **photo** si possible";
  }
  if (isPipe) {
    return "### 💡 Pour identifier un produit GEB adapté\nMerci de préciser encore :\n- **Matière** et diamètre de la canalisation si connus\n- **Emplacement** de la fuite (joint, fissure, raccord fileté)\n- **Fluide** en contact et présence ou non de pression\n- Une **photo** si possible";
  }
  return "### 💡 Pour identifier un produit GEB adapté\nMerci de préciser encore :\n- **Support** et emplacement exact du problème\n- **Fluide ou environnement** en contact (le cas échéant)\n- **Contexte** (intérieur/extérieur, sous pression ou non)\n- Une **photo** ou description courte si possible";
}
