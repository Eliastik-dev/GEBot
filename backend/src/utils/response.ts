import { COMPLEMENTARY_HINTS } from "../config/constants.js";
import type { Audience, HandoffPayload, Locale, Reseller } from "../types/index.js";
import { normalizeText } from "./text.js";

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


export function buildComplementarySuggestion(locale: Locale, audience: Audience, message: string): string {
  const lower = message.toLowerCase();
  const match = COMPLEMENTARY_HINTS.find((item) => item.keywords.some((k) => lower.includes(k)));
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

  const lower = sourceMessage.toLowerCase();
  const match = COMPLEMENTARY_HINTS.find((item) => item.keywords.some((k) => lower.includes(k)));
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

export function buildMoreDetailsForProductRequest(
  locale: Locale,
  audience: Audience | null,
): string {
  const isPro = audience === "professional";
  if (locale === "en") {
    return isPro
      ? "### 💡 To find a suitable GEB product\nPlease specify:\n- Exact leak location (thread, cartridge, aerator, seal)\n- Tap material if known (brass, chrome fitting)\n- Whether the installation is under pressure or dripping when closed\n- Any product reference already on site"
      : "### 💡 To find a suitable GEB product\nPlease specify:\n- Where exactly it leaks (thread, aerator, internal seal)\n- Tap type / brand if known\n- Photo or short description of the fitting\n- Whether water drips when the tap is closed";
  }
  if (locale === "nl") {
    return "### 💡 Meer details nodig\n- Exacte plaats van het lek (draad, sifon, perlator)\n- Materiaal van de kraan indien bekend\n- Onder druk of druppelend bij gesloten stand";
  }
  if (locale === "pl") {
    return "### 💡 Potrzebujemy wiecej szczegolow\n- Dokladne miejsce wycieku (gwint, aerator, uszczelka)\n- Material baterii jesli znany\n- Czy kapi przy zamknietym zaworze";
  }
  return isPro
    ? "### 💡 Pour identifier un produit GEB adapté\nMerci de préciser encore :\n- **Emplacement exact** de la fuite (filetage, cartouche, joint du mousseur, base du bec)\n- **Matière** du robinet / raccord si vous la connaissez\n- **Contexte** : goutte à l'arrêt, fuite au débit ouvert, eau chaude ou froide\n- **Référence** ou photo du modèle si possible"
    : "### 💡 Pour identifier un produit GEB adapté\nMerci de préciser encore :\n- **Où** ça fuit exactement (filetage du mousseur, joint interne, base du robinet)\n- **Type de robinet** ou marque si vous la connaissez\n- Est-ce que ça goutte **robinet fermé** ou seulement à l'ouverture ?\n- Une **photo** ou le modèle du robinet si possible";
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

