import type { Audience, Locale, ProductTheme } from "../types/index.js";

export function normalizeLocale(input: string | undefined): Locale {
  const raw = (input ?? "fr").toLowerCase();
  if (raw.startsWith("en")) return "en";
  if (raw.startsWith("nl")) return "nl";
  if (raw.startsWith("pl")) return "pl";
  return "fr";
}


export function normalizeAudience(input: string | undefined): Audience | null {
  if (!input) return null;
  const value = input.trim().toLowerCase();
  if (value === "professional" || value === "professionnel" || value === "pro") return "professional";
  if (value === "particulier" || value === "individual" || value === "consumer") return "particulier";
  return null;
}


export function detectAudience(message: string): Audience | null {
  const m = message.toLowerCase();
  if (/\b(professionnel|professionnelle|professional|pro)\b/.test(m)) return "professional";
  if (/\b(particulier|private|consumer|individual)\b/.test(m)) return "particulier";
  return null;
}


export function isProfileOnlyMessage(message: string): boolean {
  const m = message.trim().toLowerCase();
  const words = m.split(/\s+/).length;
  const isProfile = /professionnel|professionnelle|professional|pro|particulier|private|consumer|individual/.test(m);
  return isProfile && words <= 5;
}


export function detectTheme(message: string): ProductTheme | null {
  const m = message.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/\b(plomberie|sanitaire|plumbing)\b/.test(m)) return "plomberie";
  if (/\b(piscine|pool|bassin)\b/.test(m)) return "piscine";
  if (/\b(chauffage|feu|heating|cheminee|poele)\b/.test(m)) return "chauffage";
  if (/\b(batiment|building|facade|toiture)\b/.test(m)) return "batiment";
  if (/\b(maintenance|entretien)\b/.test(m)) return "maintenance";
  if (/\b(automobile|auto|vehicule|car)\b/.test(m)) return "automobile";
  if (/\b(eco[- ]?conception|ecologique|eco[- ]?design)\b/.test(m)) return "eco-conception";
  return null;
}


/** Quick-reply theme labels (widget) — not free-text technical questions mentioning a domain word. */
const THEME_PICKER_LABEL_RE =
  /^(plomberie(\s*\/\s*sanitaire)?|sanitaire|piscine|chauffage|batiment|maintenance|automobile|auto|eco[- ]?conception|plumbing(\s*\/\s*sanitary)?|building|heating|pool|gebouw|budownictwo|loodgieterij(\s*\/\s*sanitair)?|hydraulika(\s*\/\s*sanitarne)?)\s*$/i;

/** Verbs / needs that indicate a real technical question, not a domain picker tap. */
const THEME_SELECTION_TECHNICAL_INTENT_RE =
  /\b(souhaite|voudrais|cherch|besoin|comment|quel|quelle|pourquoi|fuit|fuite|repar|etanch|colmat|produit|recommand|probleme|question|faire|installer|coller|utiliser|perd|coule|gouttiere|fissure|trou|colle|mastic|silicone|joint|raccord)\b/;

export function isThemeOnlyMessage(message: string): boolean {
  const m = message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!detectTheme(message)) return false;
  if (THEME_PICKER_LABEL_RE.test(m)) return true;
  if (THEME_SELECTION_TECHNICAL_INTENT_RE.test(m)) return false;
  const words = m.split(/\s+/).filter(Boolean).length;
  return words <= 3;
}

/** User does not know which theme/domain applies (onboarding — not a product citation). */
export function isThemeUncertaintyMessage(message: string): boolean {
  const m = message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (detectTheme(message)) return false;
  if (isProfileOnlyMessage(message)) return false;
  return (
    /\b(je ne sais pas|je sais pas|pas sur|pas certain|aucune idee|aucun idee|je ne connais pas|je connais pas|sais pas|no idea|dont know|not sure|geen idee|nie wiem)\b/.test(
      m,
    ) ||
    /\b(pas de domaine|quel domaine|unknown domain|geen domein)\b/.test(m)
  );
}

export function buildThemeUncertaintyReply(locale: Locale): string {
  if (locale === "en") {
    return "No problem — pick the closest area below, or briefly describe your situation (leak, joint, heating, pool…) and I will guide you.";
  }
  if (locale === "nl") {
    return "Geen probleem — kies hieronder het dichtstbijzijnde domein, of beschrijf kort uw situatie (lek, voeg, verwarming, zwembad…) en ik help u verder.";
  }
  if (locale === "pl") {
    return "Nie ma problemu — wybierz najblizszy obszar ponizej albo krotko opisz sytuacje (wyciek, fuga, ogrzewanie, basen…), a ja Panu/Pani doradze.";
  }
  return "Pas de souci — choisissez le domaine le plus proche ci-dessous, ou décrivez brièvement votre situation (fuite, joint, chauffage, piscine…) et je vous orienterai.";
}


export function getSpecificClarification(message: string, locale: Locale): string | null {
  const normalized = message.trim().toLowerCase();
  const asksSiliconeSink =
    (normalized.includes("silicone") || normalized.includes("mastic")) &&
    (normalized.includes("evier") || normalized.includes("sink"));
  const hasMaterial = ["inox", "resine", "synthetique", "ceramique", "acier"].some((term) =>
    normalized.includes(term),
  );
  if (!asksSiliconeSink || hasMaterial) return null;
  if (locale === "nl") {
    return "Is het voor een spoelbak in inox of kunsthars?";
  }
  if (locale === "pl") {
    return "Czy to do zlewu ze stali nierdzewnej czy z zywicy?";
  }
  if (locale === "en") {
    return "Is this for a stainless steel sink or a resin sink?";
  }
  return "Est-ce pour un evier en inox ou en resine ?";
}

