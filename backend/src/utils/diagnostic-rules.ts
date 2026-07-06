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

/** Finition / ravivement esthétique d'un poêle ou foyer — pas entretien circuit chauffage (G3…). */
export function isWoodStoveCosmeticCareContext(text: string): boolean {
  const n = normalizeText(text);
  const appliance = /\b(poele|poeles|cheminee|cheminees|insert|foyer|foyers)\b/.test(n);
  const cosmetic =
    /\b(lustr|creme\s+lustrante|raviv|couleur|couleurs|finition|brillant|polir|entretien\s+(esthetique|surface)|aspect\s+metallique)\b/.test(
      n,
    );
  return (appliance && cosmetic) || (/\b(creme\s+lustrante|lustrant)\b/.test(n) && appliance);
}

/** Entretien circuit chauffage (désembouage, inhibiteur, radiateur…) — pas une pâte à joint filetage. */
export function hasHeatingCircuitContext(text: string): boolean {
  const n = normalizeText(text);
  if (hasDescalingContext(text)) return false;
  if (isWoodStoveCosmeticCareContext(text)) return false;
  if (
    /\b(chaudiere|cumulus|ballon)\b/.test(n) &&
    /\b(eau\s+chaude|ecs|sanitaire|robinet|pression|odeur|desembou|embouage|entretien)\b/.test(n)
  ) {
    return true;
  }
  return (
    /\b(desembou|embouage|inhibiteur|\bg3\b|\bg10\b|\bg70\b|\bg110\b|radiateur|plancher\s+chauffant|plancher\s+chauf|chauffage\s+central|circuit\s+(de\s+)?chauff|circuit\s+ferm|caloporteur|\bglycol\b|neutralisant|nettoyant\s+circuit)\b/.test(
      n,
    ) ||
    (/\b(chauffage|chauf)\b/.test(n) &&
      /\b(plancher|circuit|inhibiteur|desembou|embouage|radiateur|boue|plancher\s+chauffant)\b/.test(n))
  );
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

/** Fuite / perte d'eau piscine (générique) — colmateur ou réparation liner selon contexte. */
export function isPiscineLeakContext(text: string, sessionTheme?: string | null): boolean {
  const n = normalizeText(text);
  const themePiscine = sessionTheme === "piscine";
  if (!/\bpiscine\b/.test(n) && !themePiscine) return false;
  return (
    /\b(fuite|fuit|fuites|perd|perte|colmat|micro[- ]?fuite|lekdichter|niveau\s+d[\s']?eau|eau\s+baisse|baisse\s+regulierement)\b/.test(
      n,
    ) || /\b(boucher|colmateur)\b/.test(n)
  );
}

/** Fuite sur réseau piscine (canalisations enterrées / sans accès) — colmateur, pas mastic surface ni résine raccord. */
export function isPiscineInaccessiblePipeLeak(text: string): boolean {
  const n = normalizeText(text);
  if (!isPiscineLeakContext(text)) return false;
  return /\b(inaccessible|inacessible|pas\s+d[\s']?acces|enterr|enterre|souterrain|canalisation|tuyau|conduit)\b/.test(
    n,
  );
}

const SANITARY_FIXTURE_RE =
  /\b(baignoire|baignoires|douche|receveur|lavabo|evier|wc|toilettes?|sanitaire|appareil\s+sanitaire|email|emaillage)\b/;

/** Joint / mastic / silicone sur appareil sanitaire visible (baignoire, douche, évier…) — pas pâte filetage. */
export function isSanitaryFixtureSealingContext(text: string): boolean {
  const n = normalizeText(text);
  if (!SANITARY_FIXTURE_RE.test(n)) return false;
  return /\b(joint|mastic|silicone|etancheite|etancher|scellement|colle)\b/.test(n);
}

/** Slugs catalogue à exclure pour un contexte sanitaire surface (filetage / échappement / colle PVC). */
export function isThreadPasteOrPlumbingInternalSlug(slug: string, title = ""): boolean {
  const s = normalizeText(slug.replace(/-/g, " "));
  const t = normalizeText(title);
  const combined = `${s} ${t}`;
  return (
    /\b(gebatout|gebetanche|pate\s+a\s+joint|pate\s+joint|filasse|ptfe|olifan|echappement|collex|gebsoplast|resine\s+detancheite|resine\s+d\s+etancheite)\b/.test(
      combined,
    ) || (/\bfiletage\b/.test(combined) && !/\b(sanitaire|baignoire|douche)\b/.test(combined))
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

const BUILDING_SURFACE_RE =
  /\b(toiture|toit|zinc|zinguerie|gouttiere|gouttieres|facade|bardage|membrane|charpente|couverture|descente\s+pluviale|terrasse|carrelage|balcon|loggia|dalle|beton|pierre|mur|tuile|ardoise|appui\s+de\s+fenetre|seuil)\b/;

const PLUMBING_PIPE_CONTEXT_RE =
  /\b(tuyau|tube|canalisation|pipe|pvc|cuivre|pehd|multicouche|raccord|conduit|robinet|mousseur|mitigeur|lavabo|evier|evacuation|egout|skimmer|refoulement|plomberie|filetage|filete|filasse|ruban\s+ptfe)\b/;

/** Mur, terrasse, carrelage, façade, toiture… — hors canalisation. */
export function hasBuildingSurfaceContext(text: string): boolean {
  const n = normalizeText(text);
  return BUILDING_SURFACE_RE.test(n) || /\b(batiment|building)\b/.test(n);
}

export function hasPlumbingPipeContext(text: string): boolean {
  return PLUMBING_PIPE_CONTEXT_RE.test(normalizeText(text));
}

/**
 * Joint / mastic / étanchéité sur enveloppe bâtiment (carrelage, terrasse, balcon, mur…).
 * Distinct from pâte à joint filetage plomberie — ne jamais demander le fluide de service.
 */
export function isBuildingSurfaceSealingContext(text: string): boolean {
  const n = normalizeText(text);
  if (hasPlumbingPipeContext(text) && !BUILDING_SURFACE_RE.test(n)) return false;
  if (!hasBuildingSurfaceContext(text)) return false;

  return (
    /\b(joint|mastic|etancheite|etancher|scellement|colle|silicone|infiltration|fuite|goutte|pluie)\b/.test(n) ||
    /\b(joint\s+de\s+carrelage|joint\s+carrelage|joint\s+exterieur|joint\s+exterieure)\b/.test(n)
  );
}

/** Fuite / infiltration sur enveloppe du bâtiment — pas de fluide de canalisation à préciser. */
export function isBuildingEnvelopeLeakContext(text: string): boolean {
  const n = normalizeText(text);
  if (!/\b(fuit|fuite|infiltration|goutte|etancheite)\b/.test(n)) return false;
  if (hasPlumbingPipeContext(text)) return false;
  return hasBuildingSurfaceContext(text);
}

