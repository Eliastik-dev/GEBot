import type { Audience, ProductTheme } from "../../../types/index.js";
import type { ProductKnowledgeRow } from "../../../types/product-knowledge.js";
import {
  asksMetalThreadPasteJoint,
  asksThreadedMetalSealing,
  jointPasteSearchNameTerms,
  parseJointServiceFluid,
  userRejectsPiscineProduct,
} from "../../../utils/joint-paste.js";
import {
  hasInaccessibleThreadedJointForResinContext,
  isPiscineLeakContext,
  isSanitaryFixtureSealingContext,
  isThreadPasteOrPlumbingInternalSlug,
} from "../../../utils/diagnostic-rules.js";
import { hasNegatedLeakInText, isHydraulicEcsDiagnosticContext } from "../../../utils/fluid-context.js";
import { inferCatalogProductAudience } from "../../../services/product-theme.service.js";
import { decodeHtmlEntities } from "../../../utils/text.js";
import {
  computeExplicitProductMatchScore,
  EXPLICIT_PRODUCT_MATCH_MIN,
  extractCatalogProductCodes,
  extractProductSearchTerms,
  EXPLICIT_PRODUCT_NAME_PRIORITY_MIN,
} from "../../../utils/product-mention.js";
import { normalizeText } from "./types.js";

/** Short tokens that must still match titre/slug (ABS, PVC…) */
const SHORT_QUERY_TOKENS = new Set(["abs", "pvc", "ppr", "pe", "pp", "dn"]);

export function scoreProduct(
  product: ProductKnowledgeRow,
  tags: string[],
  material: string | null | undefined,
  fluid: string | null | undefined,
  query: string,
  sessionAudience: Audience | null | undefined,
  sessionTheme: ProductTheme | null | undefined,
  explicitTexts: string[] = [],
): number {
  let score = 0;
  const explicitScore = computeExplicitProductMatchScore(product, explicitTexts);
  if (sessionTheme && product.theme === sessionTheme) score += 6;
  else if (sessionTheme && product.theme && product.theme !== sessionTheme) {
    if (explicitScore >= EXPLICIT_PRODUCT_NAME_PRIORITY_MIN) {
      // Named product lookup — cross-theme is expected; no mismatch penalty.
    } else if (explicitScore >= EXPLICIT_PRODUCT_MATCH_MIN) {
      score -= 4;
    } else {
      score -= 20;
    }
  }
  const productTags = new Set(product.use_case_tags.map((t) => normalizeText(t)));
  for (const tag of tags) {
    if (productTags.has(normalizeText(tag))) score += 3;
  }

  const title = normalizeText(decodeHtmlEntities(product.canonical_name));
  const slug = normalizeText(product.slug.replace(/-/g, " "));
  const q = normalizeText(decodeHtmlEntities(query));

  for (const tag of tags) {
    const term = normalizeText(tag.replace(/_/g, " "));
    if (title.includes(term) || slug.includes(term.replace(/ /g, ""))) score += 4;
  }

  if (tags.includes("echappement")) {
    if (title.includes("echappement") || slug.includes("echappement")) score += 12;
    if (title.includes("demarre moteur") || title.includes("startex")) score -= 10;
    if (title.includes("eau potable") || title.includes("potable")) score -= 8;
  }

  if (tags.includes("eau_potable")) {
    if (title.includes("eau potable") || title.includes("potable")) score += 8;
    if (title.includes("echappement")) score -= 6;
  }

  const piscineContext =
    !userRejectsPiscineProduct(q) &&
    (tags.includes("piscine") || (/\bpiscine\b/.test(q) && !/\beau\s+potable\b/.test(q)));
  if (piscineContext) {
    if (title.includes("pool") || title.includes("piscine") || slug.includes("pool")) score += 6;
  }

  const piscineLeak = isPiscineLeakContext(query, sessionTheme);
  if (piscineLeak) {
    const wantsColmatage =
      /\b(colmateur|colmat|boucher|bouch|fuites?|fuit|perd|niveau\s+d[\s']?eau|eau\s+baisse)\b/.test(q);
    if (wantsColmatage) {
      if (
        title.includes("colmateur") ||
        slug.includes("colmateur") ||
        slug.includes("lekdichter") ||
        slug.includes("zatykania-wyciek")
      ) {
        score += 48;
      }
      if (slug.includes("detection-fuite") || title.includes("detection")) score -= 35;
      if (slug.includes("mastic") && slug.includes("reparation")) score -= 8;
      if (slug.includes("mastic-piscine") || title.includes("mastic piscine")) score -= 28;
    }
    if (slug.includes("echappement") || slug.includes("collex") || title.includes("echappement")) score -= 55;
    if (slug.includes("gebetanche") || slug.includes("resine")) score -= 28;
    if (slug.includes("pate-a-joint") || slug.includes("gebatout")) score -= 45;
  }

  const poolInaccessiblePipeLeak =
    piscineContext &&
    /\b(inaccessible|inacessible|pas\s+d[\s']?acces|enterr|enterre|colmateur|canalisation|tuyau)\b/.test(q) &&
    /\b(fuite|fuit|colmat|perd)\b/.test(q);
  if (poolInaccessiblePipeLeak) {
    if (
      title.includes("colmateur") ||
      slug.includes("colmateur") ||
      slug.includes("lekdichter") ||
      slug.includes("zatykania-wyciek")
    ) {
      score += 38;
    }
    if (slug.includes("mastic") && slug.includes("piscine") && !slug.includes("reparation")) score -= 22;
    if (slug.includes("gebsoblue")) score -= 14;
    if (slug.includes("gebetanche") || slug.includes("resine")) score -= 28;
  }
  if (/\bcolmateur\b/.test(q) && piscineContext) {
    if (title.includes("colmateur") || slug.includes("colmateur") || slug.includes("lekdichter")) score += 45;
    if (slug.includes("mastic-piscine") || title.includes("mastic piscine")) score -= 30;
  }

  const linerKitAsk =
    /\b(kit\s+.*liner|liner.*kit|reparation\s+liner|kit\s+reparation\s+liner)\b/.test(q) ||
    (/\b(je\s+veux|je\s+souhaite|donnez[- ]?moi)\b/.test(q) && /\b(liner|kit)\b/.test(q));
  if (linerKitAsk) {
    if (slug.includes("liner") || title.includes("liner")) score += 42;
    if (slug.includes("detection-fuite") || title.includes("detection")) score -= 18;
    if (slug.includes("mastic") && !slug.includes("liner")) score -= 12;
  }
  if (!piscineContext && (slug.includes("pool-") || slug.startsWith("pool ") || title.startsWith("pool"))) {
    score -= 38;
  }

  if (tags.includes("debouchage")) {
    if (title.includes("debouch") || slug.includes("debouch") || slug.includes("ontstopper")) score += 8;
  }

  const drainOdorContext =
    /\b(odeur|odeurs|sentent|puanteur|mauvais|geur|smell)\b/.test(q) &&
    /\b(canalisation|evacuation|siphon|wc|douche|evier|drain|afvoer)\b/.test(q);
  if (drainOdorContext) {
    if (title.includes("debouch") || slug.includes("debouch") || slug.includes("ontstopper") || title.includes("odeur")) {
      score += 32;
    }
    if (slug.includes("pate-a-joint") || slug.includes("resine") || slug.includes("bande-abrasive") || slug.includes("pistolet")) {
      score -= 24;
    }
  }

  if (/\b(gourde|bouteille\s+de\s+boire|bouteille\s+isotherme)\b/.test(q) && /\b(fuit|fuite|fissure)\b/.test(q)) {
    if (
      slug.includes("gebetanche") ||
      slug.includes("pate-a-joint") ||
      slug.includes("filasse") ||
      slug.includes("ptfe") ||
      slug.includes("resine") ||
      slug.includes("olifan")
    ) {
      score -= 55;
    }
  }

  const descalingContext = /\b(detartr|descal|calcaire|tartre|detartrans|g6[0-3]\b|echangeur)\b/.test(q);
  if (descalingContext) {
    if (title.includes("detartr") || slug.includes("detartr") || slug.includes("g60") || slug.includes("g61")) {
      score += 28;
    }
    if (title.includes("collafeu") || slug.includes("collafeu")) score -= 25;
    if (title.includes("tresse") && slug.includes("propfeu")) score -= 22;
    if (title.includes("desembou") || slug.includes("g3")) score -= 15;
  }

  const heatingInhibitorContext =
    (tags.includes("desembouage") || fluid === "chauffage") &&
    /\b(inhibiteur|desembou|universel|plancher\s+chauffant|radiateur|g110|g10\b|g3\b|g70\b)\b/.test(q);
  if (heatingInhibitorContext) {
    if (slug.includes("g110") || title.includes("g110")) score += 32;
    if (title.includes("inhibiteur universel")) score += 26;
    if (title.includes("inhibiteur")) score += slug.includes("g10") && !slug.includes("g110") ? 10 : 6;
    if (slug.includes("collafeu") || title.includes("collafeu") || title.includes("propfeu")) score -= 45;
    if (title.includes("refractaire") || slug.includes("cheminee")) score -= 35;
    if (/\buniversel\b/.test(q) && (slug.includes("g110") || title.includes("universel"))) score += 18;
  }

  if (isHydraulicEcsDiagnosticContext(q)) {
    if (slug.includes("desembou") || title.includes("desembou") || slug.includes("g3")) score += 22;
    if (title.includes("inhibiteur")) score += 14;
    if (slug.includes("gebsomousse") || title.includes("coupe feu") || title.includes("intumescent")) {
      score -= 55;
    }
    if (slug.includes("pool") || slug.includes("piscine") || slug.includes("liner")) score -= 50;
    if (hasNegatedLeakInText(q) && isThreadPasteOrPlumbingInternalSlug(slug, product.canonical_name)) {
      score -= 35;
    }
  }

  if (explicitScore >= EXPLICIT_PRODUCT_NAME_PRIORITY_MIN) score += explicitScore;
  else if (explicitScore >= EXPLICIT_PRODUCT_MATCH_MIN) score += Math.round(explicitScore * 0.35);

  const normMaterial = material ? normalizeText(material) : "";
  if (normMaterial) {
    const mats = product.compatible_materials.map(normalizeText);
    if (mats.some((m) => m.includes(normMaterial) || normMaterial.includes(m))) score += 2;
    const bad = product.incompatible_materials.map(normalizeText);
    if (bad.some((m) => m.includes(normMaterial))) score -= 4;
  }

  const normFluid = fluid ? normalizeText(fluid) : "";
  if (normFluid) {
    const fluids = product.compatible_fluids.map(normalizeText);
    if (fluids.some((f) => f.includes(normFluid) || normFluid.includes(f))) score += 1.5;
    const bad = product.incompatible_fluids.map(normalizeText);
    if (bad.some((f) => f.includes(normFluid))) score -= 3;
  }

  if (q.split(/\s+/).some((word) => {
    if (word.length < 3) return false;
    if (word.length === 3 && !SHORT_QUERY_TOKENS.has(word)) return false;
    return title.includes(word) || slug.includes(word);
  })) {
    score += 1;
  }

  const plumbingGlueContext = /\b(abs|pvc|pehd|multicouche|\bppr\b|polypropylene|colle|coller|canalisation)\b/.test(q);
  if (plumbingGlueContext) {
    const eff = inferCatalogProductAudience(product.canonical_name, product.slug, product.audience ?? "all");
    if (slug.includes("gebsoplast") || title.includes("gebsoplast")) {
      if (sessionAudience === "professional") score += 14;
      else if (sessionAudience === "particulier") score -= 24;
    }
    if (slug.includes("colle-haute-performance") || title.includes("haute performance")) {
      if (sessionAudience === "particulier") score += 14;
      else if (sessionAudience === "professional") score -= 10;
    }
    if (eff === "particulier" && sessionAudience === "professional") {
      score -= 12;
    }
    if (eff === "particulier" && sessionAudience === "particulier") {
      score += 10;
    }
    if (eff === "professional" && sessionAudience === "particulier") {
      score -= 20;
    }
  }

  if (sessionAudience) {
    const line = inferCatalogProductAudience(product.canonical_name, product.slug, product.audience ?? "all");
    if (sessionAudience === "professional" && line === "professional") score += 3;
    if (sessionAudience === "particulier" && line === "particulier") score += 3;
    if (sessionAudience === "professional" && line === "particulier") score -= 8;
    if (sessionAudience === "particulier" && line === "professional") score -= 12;
  }

  const threadedMetalSealing = asksThreadedMetalSealing(query);
  const parsedJointFluid = parseJointServiceFluid(query);
  const metalPasteJoint = asksMetalThreadPasteJoint(query);

  if (threadedMetalSealing) {
    if (slug.includes("resine") && slug.includes("tous-fluides")) score += 22;
    if (slug.includes("gebetanche") && (slug.includes("potable") || title.includes("potable"))) score += 20;
    if (slug.includes("filasse") && slug.includes("rt1")) score += 12;
    if (slug.includes("ptfe") || slug.includes("olifan")) score += 8;
    if (slug.includes("colle-haute") || title.includes("colle pvc") || slug.includes("gebsoplast")) score -= 28;
    if (!piscineContext && (slug.includes("pool") || title.includes("pool"))) score -= 45;

    if (tags.includes("eau_potable") || parsedJointFluid?.category === "eau_potable") {
      if (slug.includes("gebetanche") && slug.includes("potable")) score += 14;
      if (slug.includes("resine") && slug.includes("fluides")) score += 14;
      if (slug.includes("pool")) score -= 35;
    }
    if (hasInaccessibleThreadedJointForResinContext(query) || /\bdifficilement\s+accessible\b/.test(q)) {
      if (slug.includes("resine") && slug.includes("tous-fluides")) score += 12;
      if (slug.includes("filasse")) score -= 8;
    }
  }

  if (metalPasteJoint) {
    const parsedFluid = parseJointServiceFluid(query);
    if (title.includes("gebetanche") || slug.includes("gebetanche")) score += 16;
    if (title.includes("filasse") || slug.includes("filasse")) score += 12;
    if (title.includes("ptfe") || slug.includes("ptfe") || slug.includes("olifan")) score += 10;
    if (slug.includes("pate-a-joint") || title.includes("pate a joint")) score += 12;

    if (slug.includes("gebsoplast") || title.includes("gebsoplast") || title.includes("colle pvc")) score -= 30;
    if (slug.includes("detecteur") || title.includes("detecteur")) score -= 25;
    if (slug.includes("graisse-robinet") || (title.includes("graisse") && !title.includes("gebetanche"))) score -= 20;
    if (title.includes("inhibiteur") || title.includes("desembou") || slug.includes("g3")) score -= 18;
    if (title.includes("collafeu") || slug.includes("collafeu")) score -= 15;

    if (tags.includes("gaz") || parsedFluid?.category === "gaz") {
      if (slug.includes("gaz") || title.includes("gaz")) score += 14;
      if (slug.includes("detecteur")) score -= 30;
      if (slug.includes("graisse-robinet")) score -= 25;
    }
    if (tags.includes("eau_potable") || parsedFluid?.category === "eau_potable") {
      if (title.includes("potable") || slug.includes("potable")) score += 12;
    }
    if (tags.includes("evacuation") || parsedFluid?.category === "evacuation" || parsedFluid?.category === "evacuation_pressurized") {
      if (slug.includes("82") || title.includes("82")) score += 10;
    }
    if (tags.includes("piscine") || parsedFluid?.category === "piscine") {
      if (title.includes("pool") || slug.includes("pool") || title.includes("piscine")) score += 8;
    }
  }

  const siliconeContext = /\b(silicone|mastic\s+sanitaire)\b/.test(q);
  const sanitaryFixture = isSanitaryFixtureSealingContext(query);
  const fastDryAsk = /\b(rapide|plus\s+rapide|sechage|seche|secher|sechage\s+rapide)\b/.test(q);
  const chronoExplicit = /\b(60\s*(?:min|mn)?\s*chrono|silicone\s+60|60\s*chrono|\bchrono\b)/.test(q);

  if (sanitaryFixture) {
    if (
      slug.includes("pose-facile") ||
      title.includes("pose facile") ||
      (slug.includes("silicone") && (slug.includes("bain") || slug.includes("sanitaire"))) ||
      title.includes("silicone sanitaire")
    ) {
      score += 38;
    }
    if (slug.includes("mastic") && (slug.includes("facile") || title.includes("facile"))) score += 32;
    if (isThreadPasteOrPlumbingInternalSlug(product.slug, product.canonical_name)) score -= 50;
    if (slug.includes("echappement") || slug.includes("collex")) score -= 55;
  }

  if (siliconeContext) {
    if (title.includes("graisse") && slug.includes("graisse")) score -= 30;
    if (title.includes("dissolvant") || slug.includes("dissolvant")) score -= 20;
  }

  if (siliconeContext && (fastDryAsk || chronoExplicit)) {
    if (slug.includes("chrono") || title.includes("chrono")) score += 22;
    if (slug.includes("gebsicone-w3") || title.includes("w3")) score += 10;
    const curing = normalizeText(product.curing_time ?? "");
    if (/\b1\s*h\b/.test(curing) && /utilisation|appareils|sanitaire|eau/.test(curing)) score += 8;
    if (chronoExplicit && !slug.includes("chrono") && !title.includes("chrono")) score -= 18;
    if (fastDryAsk && (slug.includes("bain-cuisine") || slug.includes("silicone-bain"))) score -= 10;
  }

  const faucetLeakContext =
    /\b(robinet|mitigeur|mousseur|perlateur|bec\s+verseur)\b/.test(q) &&
    /\b(fuit|fuite|fuyait|coule|goutte|perd|perte|etancheite|colmatage)\b/.test(q);
  if (faucetLeakContext) {
    if (title.includes("filasse") || slug.includes("filasse")) score += 18;
    if (title.includes("ptfe") || slug.includes("ptfe") || slug.includes("olifan")) score += 16;
    if (slug.includes("graisse-robinet") || title.includes("graisse robinet")) score += 12;
    if (title.includes("joint") && (title.includes("robinet") || title.includes("robinetterie"))) score += 10;
    if (title.includes("degraiss") || slug.includes("degraissant") || slug === "suif" || title === "suif") score -= 40;
    if (title.includes("mousse pu") || slug.includes("mousse-pu") || title.includes("nettoyant mousse")) score -= 35;
    if (title.includes("bruleur") && title.includes("degraiss")) score -= 45;
  }

  const gutterZincLeak =
    /\b(gouttiere|gouttieres|descente\s+pluviale|zinguerie)\b/.test(q) &&
    /\b(fissure|fuit|fuite|colmat|etanche)\b/.test(q);
  if (gutterZincLeak) {
    if (slug.includes("ms-zinc") || (title.includes("ms") && title.includes("zinc"))) score += 28;
    if (slug.includes("toiturol")) score += 14;
    if (slug.includes("acrybat")) score += 8;
    if (title.includes("silicone") && title.includes("sanitaire")) score -= 18;
  }
  if (/\bzinc\b/.test(q) && /\b(mastic|etanche|fissure|gouttiere)\b/.test(q)) {
    if (slug.includes("ms-zinc") || title.includes("ms zinc")) score += 20;
  }

  const woodStoveCosmetic =
    /\b(poele|cheminee|insert|foyer)\b/.test(q) &&
    /\b(lustr|raviv|couleur|finition|brillant|creme\s+lustrante|aspect\s+metallique)\b/.test(q);
  if (woodStoveCosmetic) {
    if (slug.includes("lustr") || title.includes("lustr")) score += 45;
    if (slug.includes("propfeu") && title.includes("lustr")) score += 20;
    if (slug.includes("blackfire") || title.includes("blackfire")) score -= 40;
    if (title.includes("desembou") || slug.includes("desembou") || slug.includes("g3")) score -= 50;
    if (title.includes("inhibiteur") || slug.includes("g110") || slug.includes("g10")) score -= 40;
    if (slug.includes("gebetanche-chauffage") || title.includes("gebetanche chauffage")) score -= 35;
  }

  if (product.extraction_version === "1.0") score += 0.5;

  return score;
}

const NAME_KEYWORD_PATTERNS: Array<{ pattern: RegExp; term: string }> = [
  { pattern: /\b(echappement|pot[\s-]?d['']?echappement)\b/i, term: "echappement" },
  { pattern: /\b(silicone|mastic)\b/i, term: "silicone" },
  { pattern: /\b(kit\s+.*liner|liner.*kit|reparation\s+liner|kit\s+reparation\s+liner)\b/i, term: "liner" },
  { pattern: /\b(kit\s+.*liner|liner.*kit|reparation\s+liner|kit\s+reparation\s+liner)\b/i, term: "kit" },
  { pattern: /\b(piscine|pool|bassin)\b/i, term: "pool" },
  { pattern: /\bliner\b/i, term: "liner" },
  { pattern: /\bcolmateur\b/i, term: "colmateur" },
  { pattern: /\bmicro[- ]?fuites?\b/i, term: "colmateur" },
  {
    pattern: /\b(piscine|pool|bassin)\b.*\b(fuite|fuites|fuit|perd|boucher|colmat|niveau)\b/i,
    term: "colmateur",
  },
  { pattern: /\b(debouch|deboucheur)\b/i, term: "debouch" },
  { pattern: /\b(desembou|g3\b|g70\b)\b/i, term: "desembou" },
  { pattern: /\b(inhibiteur|g110|g10\b)\b/i, term: "inhibiteur" },
  { pattern: /\b(detartr|descal|calcaire|detartrans)\b/i, term: "detartr" },
  { pattern: /\b(degripp|debloqu|lubrif|graisse)\b/i, term: "degripp" },
  { pattern: /\b(ptfe|filasse|ruban)\b/i, term: "ptfe" },
  { pattern: /\b(robinet|mitigeur|mousseur).*\b(fuit|fuite)\b|\b(fuit|fuite).*\b(robinet|mitigeur|mousseur)\b/i, term: "filasse" },
  { pattern: /\b(colle pvc|gebsoplast)\b/i, term: "gebsoplast" },
  { pattern: /\b(abs|\bpvc\b|pehd|multicouche|polypropylene|\bppr\b)\b/i, term: "gebsoplast" },
  { pattern: /\b(cheminee|refractaire|insert|collafeu)\b/i, term: "refract" },
  { pattern: /\b(lustr|creme\s+lustrante|raviv.*couleur)\b/i, term: "lustr" },
  { pattern: /\b(poele|poeles)\b/i, term: "lustr" },
  { pattern: /\b(60\s*(?:min|mn)?\s*chrono|\bchrono\b)/i, term: "chrono" },
  { pattern: /\b(gouttiere|gouttieres|descente\s+pluviale|zinguerie)\b/i, term: "zinc" },
  { pattern: /\bms[\s*-]?zinc\b/i, term: "ms-zinc" },
  { pattern: /\btoiturol\b/i, term: "toiturol" },
  { pattern: /\b(galvanis|galvageb|galva)\b/i, term: "galv" },
];

export function extractNameSearchTerms(
  query: string,
  tags: string[],
  sessionAudience?: Audience | null,
  sessionTheme?: ProductTheme | null,
): string[] {
  const terms = new Set<string>();
  const q = normalizeText(query);
  const pasteJoint = asksMetalThreadPasteJoint(query);
  const threadedSealing = asksThreadedMetalSealing(query);

  if (pasteJoint || threadedSealing) {
    const parsed = parseJointServiceFluid(query);
    for (const term of jointPasteSearchNameTerms(parsed?.category ?? null)) {
      terms.add(term);
    }
    if (hasInaccessibleThreadedJointForResinContext(query)) {
      terms.add("resine");
      terms.add("tous");
      terms.add("fluides");
    }
  }

  if (/\buniversel\b/.test(q) && /\b(inhibiteur|desembou|chauffage|plancher|radiateur|g110|g10\b)\b/.test(q)) {
    terms.add("g110");
    terms.add("inhibiteur");
  }
  for (const { pattern, term } of NAME_KEYWORD_PATTERNS) {
    if (!pattern.test(q)) continue;
    if (term === "gebsoplast" && sessionAudience === "particulier") {
      terms.add("colle");
      terms.add("haute");
      continue;
    }
    terms.add(term);
  }
  if (
    sessionTheme === "piscine" &&
    /\b(fuite|fuites|fuit|perd|boucher|colmat|niveau|baisse)\b/.test(q)
  ) {
    terms.add("colmateur");
    terms.add("pool");
  }
  if (/\b(silicone|mastic)\b/.test(q) && /\b(rapide|sechage|seche|secher|plus\s+rapide)\b/.test(q)) {
    terms.add("chrono");
  }
  if (/\bzinc\b/.test(q)) terms.add("zinc");
  if (/\b(gouttiere|zinguerie)\b/.test(q)) {
    terms.add("zinc");
    terms.add("toiturol");
  }
  for (const code of extractCatalogProductCodes(query)) {
    terms.add(code);
  }
  for (const term of extractProductSearchTerms([query])) {
    terms.add(term);
  }
  for (const tag of tags) {
    if (tag === "toiture") {
      terms.add("toiturol");
      terms.add("zinc");
    }
    if (tag === "echappement" || tag === "montage_auto") terms.add("echappement");
    if (tag === "eau_potable") terms.add("potable");
    if (tag === "piscine") terms.add("pool");
    if (tag === "debouchage") terms.add("debouch");
    if (tag === "silicone_sanitaire") terms.add("silicone");
    if (tag === "plomberie_raccord" && !pasteJoint) {
      terms.add("pvc");
      if (sessionAudience === "particulier") {
        terms.add("colle");
        terms.add("haute");
      } else {
        terms.add("gebsoplast");
      }
    }
  }
  return [...terms];
}

export function pickSanitaryAwareProducts(
  scored: Array<{ product: ProductKnowledgeRow; score: number; explicitScore: number }>,
  queryText: string,
  limit: number,
): ProductKnowledgeRow[] {
  let pool = scored;
  if (isSanitaryFixtureSealingContext(queryText)) {
    const siliconeTagged = scored.filter((item) =>
      item.product.use_case_tags.some((tag) => normalizeText(tag) === "silicone_sanitaire"),
    );
    const withoutThreadPaste = scored.filter(
      (item) => !isThreadPasteOrPlumbingInternalSlug(item.product.slug, item.product.canonical_name),
    );
    if (siliconeTagged.length > 0) pool = siliconeTagged;
    else if (withoutThreadPaste.length > 0) pool = withoutThreadPaste;
  }
  return pool.slice(0, limit).map((item) => item.product);
}
