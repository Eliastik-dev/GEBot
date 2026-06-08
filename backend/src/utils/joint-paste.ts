/**
 * Pâte à joint / étanchéité filetage sur métal — détection besoin + fluide de service.
 */

import type { StoredMessage } from "../types/index.js";
import {
  hasInaccessibleThreadedJointForResinContext,
  isPiscineInaccessiblePipeLeak,
} from "./diagnostic-rules.js";

export type JointServiceFluidCategory =
  | "eau_potable"
  | "evacuation"
  | "evacuation_pressurized"
  | "piscine"
  | "chauffage_glycol"
  | "hydrocarbure"
  | "gaz";

export type ParsedJointServiceFluid = {
  category: JointServiceFluidCategory;
  /** Valeur pour metadata.fluid / routing générique */
  metadataFluid: string;
  label: string;
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function asksMetalThreadPasteJoint(text: string): boolean {
  const q = normalizeText(text);
  return (
    /\b(pate|pâte)\s+[aà]\s+joint\b/.test(q) ||
    /\bpate\s+joint\b/.test(q) ||
    /\bquell(e|)\s+p[aâ]te\s+[aà]\s+joint\b/.test(q) ||
    /\bquell(e|)\s+.+\bjoint\b.+(\bmetal|métal|inox|acier|cuivre|laiton|raccord|filet)\b/.test(q) ||
    /\b(joint\s+.+filet|filet.+joint|ruban.?ptfe|filasse)\b/.test(q)
  );
}

/** Raccord fileté métal, résine liquide, accès serré — hors simple « pâte à joint » explicite. */
export function asksThreadedMetalSealing(text: string): boolean {
  if (isPiscineInaccessiblePipeLeak(text)) return false;
  if (asksMetalThreadPasteJoint(text)) return true;
  if (hasInaccessibleThreadedJointForResinContext(text)) return true;
  const q = normalizeText(text);
  const threaded = /\b(raccord|filetage|filete|filete)\b/.test(q);
  if (!threaded) return false;
  if (/\b(inaccessible|difficilement\s+accessible|pas\s+la\s+place|facilement|demontable)\b/.test(q)) {
    return true;
  }
  return (
    /\b(metal|metallique|inox|acier|cuivre|laiton)\b/.test(q) &&
    /\b(faire\s+mon\s+raccord|monter|visser|etancheite|etancher|produit)\b/.test(q)
  );
}

export function userRejectsPiscineProduct(text: string): boolean {
  const q = normalizeText(text);
  return /\b(pas\s+(un\s+)?produit\s+piscine|pas\s+de\s+piscine|pas\s+piscine|ce\s+n.?est\s+pas\b.{0,40}\bpiscine)\b/.test(q);
}

const JOINT_FLUID_RULES: Array<{ pattern: RegExp; category: JointServiceFluidCategory; metadataFluid: string; label: string }> = [
  { pattern: /\b(gaz|gpl|butane|propane|gaz\s+de\s+ville)\b/, category: "gaz", metadataFluid: "gaz", label: "gaz" },
  { pattern: /\b(hydrocarbure|fioul|fuel|mazout|citerne)\b/, category: "hydrocarbure", metadataFluid: "huile", label: "hydrocarbures" },
  {
    pattern:
      /\b(glycol|caloporteur|circuits?\s+ferm|ctf\b|circuit\s+chauff|plancher\s+chauffant|chauffage\s+central|desembou|embouage|inhibiteur|\bg3\b|\bg10\b|\bg110\b|radiateur)\b/,
    category: "chauffage_glycol",
    metadataFluid: "chauffage",
    label: "eau glycolée / chauffage",
  },
  { pattern: /\b(eau\s+piscine|piscine|eau\s+chlore|eau\s+chlor|bassin|liner)\b/, category: "piscine", metadataFluid: "eau", label: "eau piscine / chlorée" },
  { pattern: /\b(eau\s+potable|potable\s+sanitaire|\bpotable\b)/, category: "eau_potable", metadataFluid: "eau", label: "eau potable" },
  { pattern: /\b(evacuation\s+sous\s+pression|egout\s+sous\s+pression|usee\s+sous\s+pression)\b/, category: "evacuation_pressurized", metadataFluid: "eau", label: "évacuation sous pression" },
  { pattern: /\b(eaux?\s+us[eé]?es|evacuation|egout|\bevac\b)/, category: "evacuation", metadataFluid: "eau", label: "évacuation / eaux usées" },
  { pattern: /\b(eau\s+sous\s+pression)\b/, category: "eau_potable", metadataFluid: "eau", label: "eau sous pression" },
];

/** Parse le fluide/milieu de service depuis un texte (message ou conversation). */
export function parseJointServiceFluid(text: string): ParsedJointServiceFluid | null {
  const q = normalizeText(text);
  for (const rule of JOINT_FLUID_RULES) {
    if (rule.pattern.test(q)) {
      return { category: rule.category, metadataFluid: rule.metadataFluid, label: rule.label };
    }
  }
  return null;
}

export function jointServiceFluidStatedInText(text: string): boolean {
  return parseJointServiceFluid(text) !== null;
}

export function isJointServiceFluidClarificationPrompt(message: string): boolean {
  const m = normalizeText(message);
  return (
    m.includes("fluide ou milieu au contact du joint") ||
    m.includes("milieu au contact du joint") ||
    m.includes("plusieurs familles produits")
  );
}

/** Reprend la question pâte à joint + fluide précisé dans les tours récents. */
export function resolveJointPasteClarificationContext(
  currentMessage: string,
  historyMessages: StoredMessage[],
): { effectiveQuestion: string; parsedFluid: ParsedJointServiceFluid } | null {
  const recentUserText = [
    ...historyMessages.filter((m) => m.role === "user").slice(-6).map((m) => m.content),
    currentMessage,
  ].join("\n");

  const parsedFluid = parseJointServiceFluid(currentMessage) ?? parseJointServiceFluid(recentUserText);
  if (!parsedFluid) return null;

  let pasteQuestion: string | null = null;
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const row = historyMessages[i];
    if (row?.role === "user" && asksMetalThreadPasteJoint(row.content)) {
      pasteQuestion = row.content.trim();
      break;
    }
  }

  if (!pasteQuestion && !asksMetalThreadPasteJoint(currentMessage)) {
    return null;
  }

  const baseQuestion = pasteQuestion ?? currentMessage.trim();
  return {
    effectiveQuestion: `${baseQuestion} (milieu au contact: ${parsedFluid.label})`,
    parsedFluid,
  };
}

export function jointPasteSearchNameTerms(category: JointServiceFluidCategory | null): string[] {
  const common = ["gebetanche", "pate", "joint", "filasse", "ptfe", "olifan"];
  if (!category) return common;
  switch (category) {
    case "gaz":
      return [...common, "gaz"];
    case "eau_potable":
      return [...common, "potable"];
    case "evacuation":
    case "evacuation_pressurized":
      return [...common, "evacuation", "82"];
    case "piscine":
      return [...common, "pool", "piscine"];
    case "chauffage_glycol":
      return [...common, "chauffage"];
    case "hydrocarbure":
      return [...common, "hydrocarbure"];
    default:
      return common;
  }
}

export function categoryToUseCaseTags(category: JointServiceFluidCategory): string[] {
  switch (category) {
    case "gaz":
      return ["gaz", "etancheite_filetage", "plomberie_raccord"];
    case "eau_potable":
      return ["eau_potable", "etancheite_filetage", "plomberie_raccord"];
    case "evacuation":
    case "evacuation_pressurized":
      return ["evacuation", "etancheite_filetage", "plomberie_raccord"];
    case "piscine":
      return ["piscine", "etancheite_filetage", "plomberie_raccord"];
    case "chauffage_glycol":
      return ["chauffage", "etancheite_filetage", "plomberie_raccord"];
    case "hydrocarbure":
      return ["etancheite_filetage", "plomberie_raccord"];
    default:
      return ["etancheite_filetage", "plomberie_raccord"];
  }
}
