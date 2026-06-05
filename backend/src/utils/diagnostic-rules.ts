import { normalizeText } from "./text.js";

/**
 * Gourde / bouteille de boisson personnelle — hors catalogue plomberie (pas de Gebétanche, pâte joint, etc.).
 */
export function isPersonalDrinkwareOutOfCatalog(text: string): boolean {
  const n = normalizeText(text);
  const drinkware =
    /\b(gourde|gourdes|bouteille\s+(de\s+)?(boire|eau|sport)|bouteille\s+isotherme|cantine|flask|water\s+bottle)\b/.test(n) ||
    (/\b(bouteille)\b/.test(n) && /\b(boire|boisson|sport|randonnee|randonnée|gym)\b/.test(n));
  const plumbingOrIndustrialBottle =
    /\b(bouteille\s+de\s+gaz|bonbonne|gpl|bouteille\s+chauffe|bouteille\s+expansion|surpresseur|bouteille\s+melangeur)\b/.test(n);
  const repairContext = /\b(fuit|fuite|fissure|fendu|etanche|casse|colmat|repar)\b/.test(n);
  return drinkware && !plumbingOrIndustrialBottle && repairContext;
}

/** Détartrage / entretien échangeur — pas une fuite ni un désembouage circuit. */
export function hasDescalingContext(text: string): boolean {
  const n = normalizeText(text);
  return /\b(detartr|descal|calcaire|tartre|detartrans|echangeur\s+(a\s+)?plaque)\b/.test(n);
}

export function hasObviousLeakOrPipeDamageIntent(text: string): boolean {
  const n = normalizeText(text);
  const leak = /\b(fuite|leak|lek|wyciek|infiltration)\b/.test(n);
  const conduit = /\b(tuyau|tube|canalisation|pipe|cuivre|pvc|pehd|multicouche|raccord|conduit)\b/.test(n);
  const midSpanLeak =
    /\b(fuite|leak)\b/.test(n) && /\b(milieu|troncon|long|tube|tuyau|cuivre)\b/.test(n);
  const repairOnRigid =
    /\b(seringue|epoxy|patch|bande|colmat|ruban)\b/.test(n) &&
    (n.includes("cuivr") ||
      /\b(repar|reparation|etanche|canalisation|rigide)\b/.test(n));
  return (leak && conduit) || midSpanLeak || repairOnRigid;
}

/** Fuite sur réseau piscine (canalisations enterrées / sans accès) — colmateur, pas mastic surface ni résine raccord. */
export function isPiscineInaccessiblePipeLeak(text: string): boolean {
  const n = normalizeText(text);
  if (!/\bpiscine\b/.test(n)) return false;
  if (!/\b(fuite|fuit|perd|colmat|micro[- ]?fuite|lekdichter)\b/.test(n)) return false;
  return /\b(inaccessible|inacessible|pas\s+d[\s']?acces|enterr|enterre|souterrain|canalisation|tuyau|conduit)\b/.test(
    n,
  );
}

export function hasInaccessibleThreadedJointForResinContext(text: string): boolean {
  if (isPiscineInaccessiblePipeLeak(text)) return false;
  const n = normalizeText(text);
  const accessBlocked =
    /\b(inaccessible|inacessible|pas\s+(de\s+)?la\s+place|pas\s+de\s+place|pas\s+d[\s']?acces|manque\s+de\s+place|impossible\s+de\s+tourner|peux\s+pas\s+tourner|ne\s+peux\s+pas\s+tourner|tourner\s+autour|acces\s+limite|sans\s+acces|peu\s+d[\s']?espace|coincee?|bloque|encombre|difficile\s+d[\s']?acces|derriere\s+(le\s+)?mur|cache\s+derriere|endroit\s+(etroit|serre|confine)|espace\s+(reduit|restreint|confine|serre|etroit|limite)|passage\s+(etroit|reduit)|en\s+encastre|sous\s+gaine|dans\s+(le\s+)?coffrage|gaine\s+technique|faux[\s-]?plafond|sous\s+dalle|encastre)\b/.test(
      n,
    );
  const sealingContext = /\b(raccord|filet|filete|tube|tuyau|etancheite|ruban|ptfe|joint|visser|canalisation|conduite|nourrice|collecteur)\b/.test(n);
  return accessBlocked && sealingContext;
}


export function isThinRetrievalQuery(text: string): boolean {
  const t = text.trim();
  if (t.length < 50) return true;
  const n = normalizeText(t);
  if (/^(pas\s+de\s+dimension|pas\s+de\s+diametre|no\s+dimension|n\/?a|je\s+ne\s+sais\s+pas)\.?$/i.test(t.trim())) return true;
  if (/^(\d+[,.]?\d*\s*(mm|cm|m)?|dn\s*\d+)\.?$/i.test(t.trim())) return true;
  const words = n.split(/\s+/).filter(Boolean);
  if (words.length <= 5 && !/\b(graisse|lubrif|silicone|mastic|pvc|toilette|wc|evacuation|potable|gaz)\b/.test(n)) return true;
  return false;
}


export function userTurnRelevantToLeakRepairThread(content: string): boolean {
  if (hasObviousLeakOrPipeDamageIntent(content)) return true;
  if (/^\d+[,.]?\d*\s*(mm|cm|m)\b/i.test(content.trim())) return true;
  const n = normalizeText(content);
  if (
    /\b(pression|bar|gravitaire|sans\s+pression|potable|usees|eau)\b/.test(n) &&
    /\b(tube|cuivre|pvc|tuyau|fuite|raccord|diametre|dn)\b/.test(n)
  ) {
    return true;
  }
  return false;
}

/** Raccord fileté, ruban, résine fluide, accès serré — ne pas fusionner avec un ancien fil « fuite sur tube ». */

export function isThreadedJointOrLiquidSealingTopic(text: string): boolean {
  const n = normalizeText(text);
  return /\b(raccord|filete|filetage|visser|male|femelle|ruban|ptfe|teflon|resine|inaccessible|tourner|pas\s+la\s+place|acces|filasse)\b/.test(
    n,
  );
}

/** Assemblage / étanchéité de raccord sans brèche (pas une « fuite à réparer » au sens diagnostic obligatoire). */

export function isJointSealingAssemblyWithoutLeak(text: string): boolean {
  const n = normalizeText(text);
  if (/\b(fuite|leak|infiltration|fissure|trou|perce|casse|rupture)\b/.test(n)) return false;
  return (
    isThreadedJointOrLiquidSealingTopic(text) ||
    /\b(etancheite|etancher)\b/.test(n) ||
    /\b(colonne\s+de\s+douche)\b/.test(n)
  );
}


export function isPurePipeLeakDamageTurn(content: string): boolean {
  return hasObviousLeakOrPipeDamageIntent(content) && !isThreadedJointOrLiquidSealingTopic(content);
}

