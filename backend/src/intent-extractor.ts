/**
 * Intent & Metadata Extractor
 *
 * Replaces the scattered regex/if-else functions (hasLargeHoleRisk, hasPipeTopic,
 * detectProblemType, etc.) with a single LLM-based extraction call that returns
 * structured JSON. A lightweight regex fallback is kept only for critical safety keywords.
 */

import { env } from "./env.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type Intent =
  | "leak_repair"
  | "sealing_assembly"
  | "inaccessible_leak"
  | "product_info"
  | "installation_lubrication"
  | "pipe_repair"
  | "silicone_application"
  | "bypass_issue"
  | "general_technical"
  | "reseller_query"
  | "unknown";

export interface ExtractedMetadata {
  intent: Intent;
  confidence: number;
  fluid: string | null;
  pressure: string | null;
  diameter: number | null;
  material: string | null;
  accessibility: "accessible" | "inaccessible" | "unknown";
  damage_type: string | null;
  safety_keywords: string[];
  missing_params: string[];
  needs_clarification: boolean;
  synonyms: string[];
  method: "llm" | "fallback" | "hybrid";
}

export interface DiagnosticAnalysis {
  metadata: ExtractedMetadata;
  clarification_message: string | null;
}

// ── Safety regex fallback (always runs, never removed) ─────────────────────────

const SAFETY_PATTERNS = {
  leak: /\b(fuite|leak|lek|wyciek|infiltration|drip)\b/i,
  pipe_damage: /\b(trou|hole|fissure|crack|casse|rupture|burst|perce)\b/i,
  pipe_context: /\b(tuyau|tube|canalisation|pipe|pvc|cuivre|pehd|multicouche|raccord|conduit|robinet|mousseur|mitigeur|lavabo|evier|bec)\b/i,
  gas: /\b(gaz|gas)\b/i,
  pressure: /\b(pression|bar|mpa|sous\s+pression|sans\s+pression|gravitaire)\b/i,
  inaccessible:
    /\b(inaccessible|inacessible|pas\s+(de\s+)?place|pas\s+d[\s']?acces|impossible\s+de\s+tourner|acces\s+limite|enterr|enterre|souterrain|espace\s+(reduit|restreint|confine)|encastre|faux[\s-]?plafond)\b/i,
  resin_context: /\b(resine|résine|anaerobie|anaerobique)\b/i,
  sealing: /\b(raccord|filete|filetage|visser|ruban|ptfe|teflon|filasse|etancheite)\b/i,
  fluid_water: /\b(eau|eaux|potable|usee|usees|evacuation|egout|drain|water|woda|sanitaire)\b/i,
  fluid_gas: /\b(gaz|gas|gpl)\b/i,
  fluid_heating: /\b(chauffage|heating|fioul)\b/i,
  diameter: /\b(dn\s*\d+|diametre|diameter|\d+\s*mm)\b/i,
  silicone: /\b(silicone|mastic)\b/i,
  installation: /\b(graiss|lubrif|vaseline|montage|pose|installation|assembl|manchon)\b/i,
} as const;

import {
  asksMetalThreadPasteJoint,
  jointServiceFluidStatedInText,
  parseJointServiceFluid,
} from "./utils/joint-paste.js";
import {
  hasDescalingContext,
  hasHeatingCircuitContext,
  hasObviousLeakOrPipeDamageIntent,
  isBuildingEnvelopeLeakContext,
  isPersonalDrinkwareOutOfCatalog,
} from "./utils/diagnostic-rules.js";

function normalizeExtractionText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(value: string): string {
  return normalizeExtractionText(value);
}

const FAUCET_LEAK_PATTERN = /\b(robinet|mousseur|mitigeur|lavabo|evier|bec|aerateur|cartouche\s+mitigeur)\b/;

function leakParamWaivedInText(text: string, param: string): boolean {
  const t = normalizeExtractionText(text);
  const unknownContext =
    /\b(je\s+ne\s+(connais|sais)\s+pas|pas\s+connue?|inconnu|inconnue|peu\s+importe|n.?a\b|ne\s+sais\s+pas)\b/.test(t);
  if (param === "diameter") {
    return (
      unknownContext ||
      /\b(pas de diametre|pas de diamètre|sans diametre|diametre inconnu|pas de dn|inconnu pour le diametre|pas\s+de\s+dimension)\b/.test(t)
    );
  }
  if (param === "pressure") {
    return (
      unknownContext ||
      /\b(sans pression|pas de pression|pression\s+inconnue|gravitaire|pas sous pression|a pression ambiante)\b/.test(t)
    );
  }
  if (param === "material") {
    return (
      /\b(pas de materiau|materiau inconnu)\b/.test(t) ||
      (/\bje ne sais pas\b/.test(t) && FAUCET_LEAK_PATTERN.test(t))
    );
  }
  return false;
}

function enrichLeakMetadataFromConversation(
  merged: ExtractedMetadata,
  fallback: ExtractedMetadata,
  conversationText: string,
): boolean {
  if (!merged.pressure && fallback.pressure) merged.pressure = fallback.pressure;
  if (!merged.diameter && fallback.diameter) merged.diameter = fallback.diameter;
  if (!merged.fluid && fallback.fluid) merged.fluid = fallback.fluid;

  const t = normalizeExtractionText(conversationText);
  if (!merged.pressure) {
    if (/sans\s+pression|gravitaire|pas\s+sous\s+pression/.test(t)) merged.pressure = "gravity";
    else if (/sous\s+pression|\d+\s*bar/.test(t)) merged.pressure = "pressurized";
  } else if (/sans\s+pression|gravitaire|pas\s+sous\s+pression/.test(t)) {
    merged.pressure = "gravity";
  }
  if (!merged.fluid && (FAUCET_LEAK_PATTERN.test(t) || /\beau\s+potable\b/.test(t))) {
    merged.fluid = "eau";
  }

  return FAUCET_LEAK_PATTERN.test(t) && /\b(fuit|fuite|goutte|goutter|infiltration)\b/.test(t);
}

/** Diamètre / taille de fuite : seulement réparation structurelle sur canalisation rigide explicite. */
function leakRequiresPipeDimensions(
  intent: Intent,
  conversationText: string,
  merged: ExtractedMetadata,
): boolean {
  if (intent !== "pipe_repair") return false;
  const t = normalizeExtractionText(conversationText);
  const structural =
    merged.damage_type === "hole" ||
    merged.damage_type === "crack" ||
    merged.damage_type === "structural" ||
    SAFETY_PATTERNS.pipe_damage.test(t);
  const rigidPipe =
    SAFETY_PATTERNS.pipe_context.test(t) &&
    /\b(tuyau|tube|canalisation|pvc|cuivre|pehd|multicouche)\b/.test(t);
  return structural && rigidPipe;
}

/** Pression : surtout gaz / réseau sous pression explicite — pas robinet, joint, façade, etc. */
function leakRequiresPressureContext(
  conversationText: string,
  merged: ExtractedMetadata,
  faucetLeak: boolean,
): boolean {
  if (faucetLeak) return false;
  const t = normalizeExtractionText(conversationText);
  if (merged.safety_keywords.includes("gas") || merged.fluid === "gaz" || SAFETY_PATTERNS.fluid_gas.test(t)) {
    return true;
  }
  if (/\b(gouttiere|zinguerie|silicone|mastic|robinet|mitigeur|facade|carrelage|cheminee|insert)\b/.test(t)) {
    return false;
  }
  if (/\b(raccord|filetage|joint|colonne\s+de\s+douche)\b/.test(t) && !/\b(tuyau|tube|canalisation)\b/.test(t)) {
    return false;
  }
  return (
    /\b(tuyau|tube|canalisation|pvc|cuivre|pehd|multicouche)\b/.test(t) &&
    (/\b(fuite|fissure|trou|perce|casse)\b/.test(t) || merged.intent === "pipe_repair")
  );
}

function applyBuildingEnvelopeLeakEnrichment(merged: ExtractedMetadata, conversationText: string): void {
  if (!isBuildingEnvelopeLeakContext(conversationText)) return;

  if (
    ["leak_repair", "pipe_repair", "inaccessible_leak", "general_technical"].includes(merged.intent)
  ) {
    merged.intent = "sealing_assembly";
  }

  const t = normalizeExtractionText(conversationText);
  if (!merged.material) {
    if (/\bzinc\b/.test(t)) merged.material = "zinc";
    else if (/\b(carrelage|terrasse)\b/.test(t)) merged.material = "carrelage";
    else if (/\b(beton|dalle)\b/.test(t)) merged.material = "beton";
    else if (/\b(facade|mur|bardage)\b/.test(t)) merged.material = "facade";
    else if (/\b(tuile|ardoise)\b/.test(t)) merged.material = "tuile";
  }

  merged.fluid = null;
  merged.missing_params = merged.missing_params.filter(
    (p) => !["fluid", "diameter", "pressure", "joint_service_fluid"].includes(p),
  );
  merged.needs_clarification = merged.missing_params.length > 0;

  const extraSynonyms = ["etancheite batiment", "mastic facade"];
  if (/\b(zinc|zinguerie|gouttiere|toiture)\b/.test(t)) {
    extraSynonyms.push("ms zinc", "mastic zinc", "etancheite toiture", "toiturol", "gebetanche toiture");
  }
  merged.synonyms = [
    ...new Set([...buildSynonyms(merged.intent, null, merged.material), ...extraSynonyms]),
  ];
}

function resolveLeakMissingParams(
  merged: ExtractedMetadata,
  conversationText: string,
  faucetLeak: boolean,
): string[] {
  const missing: string[] = [];
  if (!merged.fluid && !isBuildingEnvelopeLeakContext(conversationText)) missing.push("fluid");
  if (
    leakRequiresPipeDimensions(merged.intent, conversationText, merged) &&
    !merged.diameter &&
    !leakParamWaivedInText(conversationText, "diameter")
  ) {
    missing.push("diameter");
  }
  if (
    leakRequiresPressureContext(conversationText, merged, faucetLeak) &&
    !merged.pressure &&
    !leakParamWaivedInText(conversationText, "pressure")
  ) {
    missing.push("pressure");
  }
  return missing.filter((p) => p !== "material" && p !== "damage_extent");
}

function hasNegatedPattern(text: string, pattern: RegExp): boolean {
  const negationPrefix = /\b(pas\s+de|pas\s+d['\s]|ni\s+de|aucun|aucune|no\s|without|sans)\s*/i;
  const matches = text.match(pattern);
  if (!matches) return false;
  for (const match of matches) {
    const idx = text.indexOf(match);
    const prefix = text.slice(Math.max(0, idx - 25), idx);
    if (negationPrefix.test(prefix)) return true;
  }
  return false;
}

function regexFallbackExtraction(transcript: string, currentMessage: string): ExtractedMetadata {
  const fullText = normalizeText(`${transcript}\n${currentMessage}`);
  const msg = normalizeText(currentMessage);

  const leakMatches = SAFETY_PATTERNS.leak.test(fullText);
  const leakNegated = hasNegatedPattern(fullText, SAFETY_PATTERNS.leak);
  const hasLeak = leakMatches && !leakNegated;
  const damageMatches = SAFETY_PATTERNS.pipe_damage.test(fullText);
  const damageNegated = hasNegatedPattern(fullText, SAFETY_PATTERNS.pipe_damage);
  const hasPipeDamage = damageMatches && !damageNegated && SAFETY_PATTERNS.pipe_context.test(fullText);
  const hasInaccessible = SAFETY_PATTERNS.inaccessible.test(fullText) && SAFETY_PATTERNS.sealing.test(fullText);
  const hasSealing = SAFETY_PATTERNS.sealing.test(msg) && !hasLeak;
  const hasInstallation = SAFETY_PATTERNS.installation.test(fullText) && !hasLeak && !hasPipeDamage;
  const hasSilicone = SAFETY_PATTERNS.silicone.test(msg);
  const hasAutomotiveExhaustSeal =
    /\b(echappement|pot[\s-]?d['']?echappement|silencieux|catalyseur)\b/.test(fullText) &&
    /\b(etancheite|etanchéité|joint|mastic|pate|colmat|fuite)\b/.test(fullText);

  let intent: Intent = "general_technical";
  if (hasInaccessible && (hasLeak || hasSealing)) intent = "inaccessible_leak";
  else if (hasLeak && SAFETY_PATTERNS.pipe_context.test(fullText)) intent = "leak_repair";
  else if (hasPipeDamage) intent = "pipe_repair";
  else if (hasAutomotiveExhaustSeal) intent = "sealing_assembly";
  else if (hasSealing) intent = "sealing_assembly";
  else if (hasInstallation) intent = "installation_lubrication";
  else if (hasSilicone) intent = "silicone_application";

  let fluid: string | null = null;
  const isAutomotiveExhaust = /\b(echappement|pot[\s-]?d['']?echappement|catalyseur|collecteur|silencieux)\b/.test(fullText);
  // Check heating FIRST (more specific: "chauffage à eau" should be "chauffage", not "eau")
  if (SAFETY_PATTERNS.fluid_heating.test(fullText)) fluid = "chauffage";
  else if (SAFETY_PATTERNS.fluid_gas.test(fullText)) fluid = "gaz";
  else if (SAFETY_PATTERNS.fluid_water.test(fullText) && !isAutomotiveExhaust) fluid = "eau";
  else if (hasLeak && /\b(robinet|mousseur|mitigeur|lavabo|evier|bec|aerateur)\b/.test(fullText)) fluid = "eau";

  const hasPressure = SAFETY_PATTERNS.pressure.test(fullText);
  const diameterMatch = fullText.match(/(\d+)\s*mm\b/) ?? fullText.match(/dn\s*(\d+)/);
  const diameter = diameterMatch?.[1] ? parseInt(diameterMatch[1], 10) : null;

  let pressure: string | null = null;
  if (/sous\s+pression/.test(fullText) || /\d+\s*bar/.test(fullText)) pressure = "pressurized";
  else if (/sans\s+pression|gravitaire/.test(fullText)) pressure = "gravity";

  const safety_keywords: string[] = [];
  if (SAFETY_PATTERNS.gas.test(fullText)) safety_keywords.push("gas");
  if (hasLeak) safety_keywords.push("leak");
  if (hasPipeDamage) safety_keywords.push("pipe_damage");

  const isLeakLike = intent === "leak_repair" || intent === "pipe_repair" || intent === "inaccessible_leak";
  const faucetLeakFb =
    FAUCET_LEAK_PATTERN.test(fullText) && /\b(fuit|fuite|goutte|goutter|infiltration)\b/.test(fullText);
  const missing_params: string[] = isLeakLike
    ? resolveLeakMissingParams(
        {
          intent,
          confidence: 0.5,
          fluid,
          pressure,
          diameter,
          material: null,
          accessibility: "unknown",
          damage_type: hasPipeDamage ? "structural" : hasLeak ? "leak" : null,
          safety_keywords,
          missing_params: [],
          needs_clarification: false,
          synonyms: [],
          method: "fallback",
        },
        fullText,
        faucetLeakFb,
      )
    : [];

  const material = /\b(cuivre|pvc|pehd|multicouche|inox|acier|laiton|fonte|ceramique|carrelage|terrasse|dalle|beton|pierre|facade|mur|brique)\b/.exec(fullText)?.[1] ?? null;
  const accessibility: ExtractedMetadata["accessibility"] =
    hasInaccessible ? "inaccessible" : "unknown";

  const synonyms = buildSynonyms(intent, fluid, material);

  return {
    intent,
    confidence: 0.5,
    fluid,
    pressure,
    diameter,
    material,
    accessibility,
    damage_type: hasPipeDamage ? "structural" : hasLeak ? "leak" : null,
    safety_keywords,
    missing_params,
    needs_clarification: isLeakLike && missing_params.length > 0,
    synonyms,
    method: "fallback",
  };
}

function buildSynonyms(intent: Intent, fluid: string | null, material: string | null): string[] {
  const synonyms: string[] = [];

  const intentSynonyms: Partial<Record<Intent, string[]>> = {
    leak_repair: ["fuite", "colmatage", "réparation", "étanchéité", "leak", "patch"],
    inaccessible_leak: ["résine", "anaérobie", "liquide", "raccord fileté", "inaccessible"],
    sealing_assembly: ["étanchéité", "joint"],
    pipe_repair: ["réparation", "tube", "canalisation", "bande", "époxy", "renfort"],
    silicone_application: ["silicone", "mastic", "joint", "sanitaire"],
    installation_lubrication: ["graisse", "lubrifiant", "montage", "assemblage"],
    general_technical: [],
  };

  if (intentSynonyms[intent]) synonyms.push(...intentSynonyms[intent]!);

  // Context-aware sealing synonyms: plumbing vs. building surfaces
  if (intent === "sealing_assembly") {
    if (material && /carrelage|terrasse|dalle|beton|pierre|facade|mur|sol|brique/.test(material)) {
      synonyms.push("mastic", "acrylique", "joint carrelage", "fissure", "terrasse", "étanchéité bâtiment");
    } else {
      synonyms.push("raccord", "filetage", "PTFE", "ruban");
    }
  }

  // Context-aware: heating diagnostic (uneven heat, blocked radiator, sludge)
  if (fluid === "chauffage" || fluid === "heating") {
    synonyms.push("désembouant", "désembouage", "nettoyant circuit", "boues", "G3", "neutralisant", "inhibiteur");
  }

  const fluidSynonyms: Record<string, string[]> = {
    eau: ["eau potable", "eau usée", "évacuation", "sanitaire"],
    gaz: ["gaz naturel", "GPL", "gaz de ville"],
    chauffage: ["circuit chauffage", "fioul", "caloporteur", "désembouant", "nettoyant", "boues", "radiateur", "embouage"],
  };
  if (fluid && fluidSynonyms[fluid]) synonyms.push(...fluidSynonyms[fluid]);

  const materialSynonyms: Record<string, string[]> = {
    cuivre: ["cuivre", "copper", "Cu"],
    pvc: ["PVC", "polychlorure", "vinyle"],
    pehd: ["PEHD", "polyéthylène"],
    multicouche: ["multicouche", "alu-PE"],
    inox: ["inox", "acier inoxydable", "stainless"],
    carrelage: ["carrelage", "céramique", "faïence", "grès"],
    terrasse: ["terrasse", "extérieur", "dalle"],
    dalle: ["dalle", "béton", "sol"],
    beton: ["béton", "ciment"],
    pierre: ["pierre", "naturelle"],
    facade: ["façade", "mur extérieur", "crépi"],
    brique: ["brique", "maçonnerie"],
  };
  if (material && materialSynonyms[material]) synonyms.push(...materialSynonyms[material]);

  return [...new Set(synonyms)];
}

// ── LLM-based extraction ───────────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are a technical intent and metadata extractor for GEBot (a plumbing/sealing product advisor for GEB brand only — never classify intent as recommending competitor brands).
Analyze the user's message + conversation transcript and extract structured data.

Return ONLY valid JSON with these keys:
{
  "intent": one of: "leak_repair", "sealing_assembly", "inaccessible_leak", "product_info", "installation_lubrication", "pipe_repair", "silicone_application", "bypass_issue", "general_technical", "reseller_query", "unknown",
  "confidence": 0.0 to 1.0,
  "fluid": string or null (eau, gaz, chauffage, fioul, etc.),
  "pressure": string or null ("pressurized", "gravity", "high", "low", or specific "3 bar"),
  "diameter": number or null (in mm),
  "material": string or null (cuivre, pvc, pehd, multicouche, inox, acier, laiton, etc.),
  "accessibility": "accessible" | "inaccessible" | "unknown",
  "damage_type": string or null (leak, crack, hole, corrosion, structural),
  "safety_keywords": string[] (gas, high_pressure, potable_water, etc. — flags for safety-critical contexts),
  "missing_params": string[] (parameters still needed: usually only "fluid", or "joint_service_fluid" for thread paste; "pressure" only for gas/GPL; "diameter" almost never),
  "needs_clarification": boolean (true if recommending without the missing params would be unsafe/speculative)
}

Rules:
- For leak_repair/pipe_repair/inaccessible_leak: require **fluid** only when unknown (eau potable, chauffage, gaz, évacuation…). Do NOT add "diameter" or "damage_extent" unless pipe_repair on a rigid pipe with hole/crack AND fluid already known. Do NOT add "pressure" for faucet/fixture leaks, joints, silicone, gouttières — only for **gas/GPL** or explicit pressurized **pipe/canalisation** leak
- If the user says they do not know pressure or diameter, do NOT ask again — leave missing_params empty for those fields
- For **paste joint / thread paste / sealing paste** (which jointing product). If the contact medium / service fluid is NOT stated (*e.g.* plain "pâte à joint pour le métal" or "pour un raccord fileté" without mentioning **eau potable**, **eaux usées**, **eau glycolée ou caloporteur**, **circuit chauffage**, **hydrocarbures**, **gaz**), set needs_clarification=true and add missing_params containing **"joint_service_fluid"** — GEB has several incompatible product ranges
- For general_technical, product_info, installation_lubrication, silicone_application: do NOT require diameter/pressure/material for generic questions — but DO require joint_service_fluid when the intent is ambiguous sealant/thread product without fluid context (see rule above)
- "inaccessible_leak" = user can't rotate/wrap tape, needs liquid resin — look for access constraints
- "sealing_assembly" = new joint/fitting work without existing leak/damage
- Distinguish installation/lubrication from actual damage repair
- If the user explicitly says "pas de fuite", "pas de trou", "pas de diamètre" — respect that and do NOT classify as leak/pipe_repair
- Descaling / détartrage (échangeur à plaques, calcaire, tartre, Detartrans G60/G61…) is general_technical or product_info — NEVER leak_repair; "sous pression" alone in that context means operating regime, not a leak
- Heating circuit maintenance (désembouage, inhibiteur, radiateur, plancher chauffant, G3/G10/G110, neutralisant…) is NOT thread paste — set fluid=chauffage when context is in transcript; NEVER add joint_service_fluid
- Follow-ups like "un produit plus universel" after an inhibitor recommendation (G10 vs G110) are product_info — needs_clarification=false; use transcript heating context
- Personal drinkware (gourde, bouteille de boisson réutilisable) with crack/leak is **out of GEB plumbing catalog** — intent general_technical, needs_clarification=false, do NOT add plumbing synonyms (ptfe, filasse, pâte joint, gebetanche)
- A clogged/blocked radiator or uneven heating is general_technical (heating diagnostic), NOT pipe_repair
- Be conservative on safety for leaks, but do NOT over-clarify non-safety queries
- The LAST user message is the primary signal`;

async function llmExtractMetadata(
  transcript: string,
  locale: string,
  currentMessage: string,
  timeoutMs = 3500,
): Promise<ExtractedMetadata | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.MISTRAL_CHAT_MODEL,
        temperature: 0,
        max_tokens: 400,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: `locale=${locale}\n\n--- TRANSCRIPT ---\n${transcript.slice(0, 5000)}\n\n--- CURRENT MESSAGE ---\n${currentMessage}` },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const raw = payload.choices?.[0]?.message?.content ?? "";
    let cleaned = raw.trim();
    const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    if (fence?.[1]) cleaned = fence[1].trim();

    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const validIntents = new Set<Intent>([
      "leak_repair", "sealing_assembly", "inaccessible_leak", "product_info",
      "installation_lubrication", "pipe_repair", "silicone_application",
      "bypass_issue", "general_technical", "reseller_query", "unknown",
    ]);

    const intent = (validIntents.has(parsed.intent as Intent) ? parsed.intent : "general_technical") as Intent;
    const confidence = Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : 0.7;

    const synonyms = buildSynonyms(
      intent,
      typeof parsed.fluid === "string" ? parsed.fluid : null,
      typeof parsed.material === "string" ? parsed.material : null,
    );

    return {
      intent,
      confidence,
      fluid: typeof parsed.fluid === "string" ? parsed.fluid : null,
      pressure: typeof parsed.pressure === "string" ? parsed.pressure : null,
      diameter: typeof parsed.diameter === "number" ? parsed.diameter : null,
      material: typeof parsed.material === "string" ? parsed.material : null,
      accessibility: (["accessible", "inaccessible", "unknown"] as const).includes(parsed.accessibility as never)
        ? (parsed.accessibility as ExtractedMetadata["accessibility"])
        : "unknown",
      damage_type: typeof parsed.damage_type === "string" ? parsed.damage_type : null,
      safety_keywords: Array.isArray(parsed.safety_keywords) ? parsed.safety_keywords.filter((s): s is string => typeof s === "string") : [],
      missing_params: Array.isArray(parsed.missing_params) ? parsed.missing_params.filter((s): s is string => typeof s === "string") : [],
      needs_clarification: Boolean(parsed.needs_clarification),
      synonyms,
      method: "llm",
    };
  } catch {
    return null;
  }
}

// ── Joint / pâte à joint: fluide au contact (gammes multiples) ────────────────

const JOINT_AMBIGUOUS_INTENTS: Intent[] = [
  "product_info",
  "general_technical",
  "sealing_assembly",
  "silicone_application",
];

function applyPersonalDrinkwareSanitizer(merged: ExtractedMetadata, conversationText: string): void {
  merged.intent = "general_technical";
  merged.damage_type = null;
  merged.needs_clarification = false;
  merged.missing_params = [];
  const pollutant =
    /fuite|colmat|patch|gebetanche|pate\s+joint|filasse|ptfe|ruban|resine|plomberie|raccord|filetage|desembou/i;
  merged.synonyms = merged.synonyms.filter((s) => !pollutant.test(s));
  merged.synonyms.push("hors catalogue", "gourde", "recipient personnel");
  merged.synonyms = [...new Set(merged.synonyms)];
  if (!merged.fluid) merged.fluid = "eau";
}

function applyDescalingSanitizer(merged: ExtractedMetadata, conversationText: string): void {
  const leakLike: Intent[] = ["leak_repair", "pipe_repair", "inaccessible_leak"];
  if (leakLike.includes(merged.intent)) {
    merged.intent = /\b(g60|g61|detartrans|compar|versus|ou\s+le)\b/i.test(conversationText)
      ? "product_info"
      : "general_technical";
    merged.confidence = Math.max(merged.confidence, 0.75);
  }
  merged.damage_type = null;
  const leakOnlyParams = new Set(["diameter", "pressure"]);
  merged.missing_params = merged.missing_params.filter((p) => !leakOnlyParams.has(p));
  merged.needs_clarification = merged.missing_params.length > 0;

  const pollutant = /desembou|embouage|boues|inhibiteur|\bg3\b|g70|fuite|colmat|patch|étanchéité|etancheite/i;
  merged.synonyms = [
    ...new Set([
      ...merged.synonyms.filter((s) => !pollutant.test(s)),
      "détartrant",
      "detartrant",
      "Detartrans",
      "calcaire",
      "tartre",
      "échangeur",
      "G60",
      "G61",
    ]),
  ];

  if (/\baluminium\b/i.test(conversationText) && !merged.material) {
    merged.material = "aluminium";
  }
  if (/\beau\s+sanitaire\b/i.test(conversationText) && !merged.fluid) {
    merged.fluid = "eau";
    merged.synonyms = buildSynonyms(merged.intent, "eau", merged.material).filter((s) => !pollutant.test(s));
    merged.synonyms.push("détartrant", "Detartrans", "G60", "G61");
    merged.synonyms = [...new Set(merged.synonyms)];
  }
}

function applyHeatingCircuitSanitizer(merged: ExtractedMetadata, conversationText: string): void {
  const leakLike: Intent[] = ["leak_repair", "pipe_repair", "inaccessible_leak"];
  if (leakLike.includes(merged.intent)) {
    merged.intent = /\b(g110|g10|g3|g70|universel|compar|versus|ou\s+le|alternative)\b/i.test(conversationText)
      ? "product_info"
      : "general_technical";
    merged.confidence = Math.max(merged.confidence, 0.75);
  }
  merged.damage_type = null;
  merged.missing_params = merged.missing_params.filter(
    (p) => !["joint_service_fluid", "fluid", "diameter", "pressure"].includes(p),
  );
  merged.needs_clarification = merged.missing_params.length > 0;
  if (!merged.fluid) merged.fluid = "chauffage";

  const pollutant =
    /fuite|colmat|patch|gebetanche|pate\s+joint|filasse|ptfe|ruban|resine|plomberie|raccord|filetage|etancheite|etanchéité/i;
  const wantsUniversal = /\b(universel|plus\s+universel|alternative|autre\s+produit|plutot|plutôt|compar)\b/i.test(
    conversationText,
  );
  merged.synonyms = [
    ...new Set([
      ...merged.synonyms.filter((s) => !pollutant.test(s)),
      ...buildSynonyms(merged.intent, "chauffage", merged.material),
      ...(wantsUniversal ? ["G110", "inhibiteur universel", "universel"] : []),
    ]),
  ];
}

function applyJointServiceFluidAndNonLeakSanitizer(
  merged: ExtractedMetadata,
  transcript: string,
  currentMessage: string,
  isLeakLike: boolean,
): void {
  const conversationText = `${transcript}\n${currentMessage}`;
  const pasteJointContext =
    asksMetalThreadPasteJoint(currentMessage) || asksMetalThreadPasteJoint(transcript);
  const heatingCircuitContext = hasHeatingCircuitContext(conversationText);
  const fluidKnown = jointServiceFluidStatedInText(conversationText);
  const parsedFluid = parseJointServiceFluid(conversationText);

  if (heatingCircuitContext && !pasteJointContext) {
    merged.missing_params = merged.missing_params.filter((p) => p !== "joint_service_fluid");
    if (!merged.fluid) merged.fluid = "chauffage";
    if (merged.missing_params.length === 0) merged.needs_clarification = false;
  }

  if (
    !isLeakLike &&
    pasteJointContext &&
    !heatingCircuitContext &&
    !fluidKnown &&
    JOINT_AMBIGUOUS_INTENTS.includes(merged.intent)
  ) {
    merged.missing_params = [...new Set([...merged.missing_params, "joint_service_fluid"])];
    merged.needs_clarification = true;
    const heatingExplicit = /\b(radiateur|boue|embouage|circuit\b.{0,50}(ferme|fermé|ctf|\bchaud\b)|caloporteur|\bglycol\b)\b/i.test(
      normalizeExtractionText(currentMessage),
    );
    if (merged.fluid === "chauffage" && !heatingExplicit) {
      merged.fluid = null;
      merged.synonyms = buildSynonyms(merged.intent, null, merged.material);
    }
  }

  if (!isLeakLike && pasteJointContext && fluidKnown && parsedFluid) {
    merged.missing_params = merged.missing_params.filter((p) => p !== "joint_service_fluid");
    merged.fluid = parsedFluid.metadataFluid;
    merged.synonyms = buildSynonyms(merged.intent, parsedFluid.metadataFluid, merged.material);
    if (merged.missing_params.length === 0) {
      merged.needs_clarification = false;
    }
  }

  if (!isLeakLike) {
    const preserveJointSf =
      merged.missing_params.includes("joint_service_fluid") &&
      pasteJointContext &&
      !heatingCircuitContext;
    const leakOnlyParams = new Set(["diameter", "pressure", "material"]);
    merged.missing_params = merged.missing_params.filter((p) => !leakOnlyParams.has(p));
    const hasAnyContext = Boolean(merged.fluid) || Boolean(merged.material)
      || (merged.intent !== "general_technical" && merged.intent !== "unknown");
    if (!preserveJointSf && (merged.missing_params.length === 0 || hasAnyContext)) {
      merged.needs_clarification = false;
      merged.missing_params = [];
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Single entry point replacing all regex/if-else diagnostic functions.
 * Runs LLM extraction in parallel with regex fallback; merges results.
 */
export async function runDiagnosticAnalysis(
  transcript: string,
  locale: string,
  currentMessage: string,
): Promise<DiagnosticAnalysis> {
  const fallback = regexFallbackExtraction(transcript, currentMessage);

  const llmResult = await llmExtractMetadata(transcript, locale, currentMessage);

  const conversationText = `${transcript}\n${currentMessage}`;
  const drinkwareOutOfCatalog = isPersonalDrinkwareOutOfCatalog(conversationText);
  const descalingContext =
    !drinkwareOutOfCatalog &&
    hasDescalingContext(conversationText) &&
    !hasObviousLeakOrPipeDamageIntent(conversationText);
  const heatingCircuitContext =
    !drinkwareOutOfCatalog &&
    !descalingContext &&
    hasHeatingCircuitContext(conversationText) &&
    !hasObviousLeakOrPipeDamageIntent(conversationText);

  if (!llmResult) {
    const m: ExtractedMetadata = { ...fallback };
    if (drinkwareOutOfCatalog) {
      applyPersonalDrinkwareSanitizer(m, conversationText);
      return {
        metadata: m,
        clarification_message: null,
      };
    }
    const isLeakLikeFb = ["leak_repair", "pipe_repair", "inaccessible_leak"].includes(fallback.intent);
    applyBuildingEnvelopeLeakEnrichment(m, conversationText);
    if (descalingContext) {
      applyDescalingSanitizer(m, conversationText);
      return {
        metadata: m,
        clarification_message: m.needs_clarification ? buildClarificationFromMetadata(m, locale) : null,
      };
    }
    if (heatingCircuitContext) {
      applyHeatingCircuitSanitizer(m, conversationText);
      return {
        metadata: m,
        clarification_message: m.needs_clarification ? buildClarificationFromMetadata(m, locale) : null,
      };
    }
    if (!isLeakLikeFb) {
      applyJointServiceFluidAndNonLeakSanitizer(m, transcript, currentMessage, isLeakLikeFb);
      return {
        metadata: m,
        clarification_message: m.needs_clarification ? buildClarificationFromMetadata(m, locale) : null,
      };
    }
    enrichLeakMetadataFromConversation(m, fallback, conversationText);
    const faucetLeakFb =
      FAUCET_LEAK_PATTERN.test(normalizeExtractionText(conversationText)) &&
      /\b(fuit|fuite|goutte|goutter|infiltration)\b/.test(normalizeExtractionText(conversationText));
    m.missing_params = resolveLeakMissingParams(m, conversationText, faucetLeakFb);
    m.needs_clarification = m.missing_params.length > 0;
    return {
      metadata: m,
      clarification_message: m.needs_clarification ? buildClarificationFromMetadata(m, locale) : null,
    };
  }

  // Merge: LLM as primary, safety regex as override
  const merged: ExtractedMetadata = {
    ...llmResult,
    method: "hybrid",
    safety_keywords: [...new Set([...llmResult.safety_keywords, ...fallback.safety_keywords])],
  };

  // Fluid specificity override: "chauffage" is more specific than "eau"
  // (e.g., "chauffage à eau" → LLM returns "eau" but correct answer is "chauffage")
  const FLUID_SPECIFICITY: Record<string, string[]> = {
    chauffage: ["eau"],   // "chauffage" is more specific than "eau"
    huile: ["eau"],       // "huile" is more specific than "eau"
  };
  if (fallback.fluid && fallback.fluid !== merged.fluid) {
    const overrides = FLUID_SPECIFICITY[fallback.fluid];
    if (overrides && (!merged.fluid || overrides.includes(merged.fluid))) {
      merged.fluid = fallback.fluid;
      merged.synonyms = buildSynonyms(merged.intent, merged.fluid, merged.material);
    }
  }

  // Safety override: if regex detects gas/leak and LLM missed it, force it
  if (fallback.safety_keywords.includes("gas") && !merged.safety_keywords.includes("gas")) {
    merged.safety_keywords.push("gas");
  }
  if (
    !drinkwareOutOfCatalog &&
    !descalingContext &&
    !heatingCircuitContext &&
    fallback.intent === "leak_repair" &&
    merged.intent === "general_technical"
  ) {
    merged.intent = fallback.intent;
    merged.confidence = Math.max(merged.confidence, 0.55);
  }
  if (fallback.intent === "inaccessible_leak" && merged.intent !== "inaccessible_leak") {
    if (SAFETY_PATTERNS.inaccessible.test(normalizeText(currentMessage))) {
      merged.intent = "inaccessible_leak";
    }
  }
  if (
    fallback.intent === "sealing_assembly" &&
    /\b(echappement|pot[\s-]?d['']?echappement)\b/.test(normalizeText(currentMessage)) &&
    merged.intent === "product_info"
  ) {
    merged.intent = "sealing_assembly";
    merged.synonyms = [
      ...new Set([
        ...buildSynonyms(merged.intent, merged.fluid, merged.material),
        "mastic echappement",
        "pate montage echappement",
        "reparation echappement",
        "collex",
        "haute temperature",
      ]),
    ];
  }

  if (drinkwareOutOfCatalog) {
    applyPersonalDrinkwareSanitizer(merged, conversationText);
  } else if (descalingContext) {
    applyDescalingSanitizer(merged, conversationText);
  } else if (heatingCircuitContext) {
    applyHeatingCircuitSanitizer(merged, conversationText);
  } else {
    applyBuildingEnvelopeLeakEnrichment(merged, conversationText);
    const isLeakLike = ["leak_repair", "pipe_repair", "inaccessible_leak"].includes(merged.intent);
    if (isLeakLike) {
      enrichLeakMetadataFromConversation(merged, fallback, conversationText);
    }
    applyJointServiceFluidAndNonLeakSanitizer(merged, transcript, currentMessage, isLeakLike);

    if (isLeakLike) {
      const faucetLeak = FAUCET_LEAK_PATTERN.test(normalizeExtractionText(conversationText)) &&
        /\b(fuit|fuite|goutte|goutter|infiltration)\b/.test(normalizeExtractionText(conversationText));
      merged.missing_params = resolveLeakMissingParams(merged, conversationText, faucetLeak);
      merged.needs_clarification = merged.missing_params.length > 0;
      if (!merged.needs_clarification) {
        merged.synonyms = buildSynonyms(merged.intent, merged.fluid, merged.material);
      }
    } else {
      merged.missing_params = merged.missing_params.filter(
        (p) => !["diameter", "pressure", "damage_extent"].includes(p),
      );
      merged.needs_clarification = merged.missing_params.length > 0;
    }
  }

  return {
    metadata: merged,
    clarification_message: merged.needs_clarification
      ? buildClarificationFromMetadata(merged, locale)
      : null,
  };
}

// ── Clarification builder ──────────────────────────────────────────────────────

type L = Record<string, Record<string, string>>;

const CLARIFICATION_TEMPLATES: L = {
  fluid: {
    fr: "- **Fluide / circuit** : eau potable, eaux usées et évacuation (gravitaire), chauffage, gaz, autre ?",
    en: "- **Fluid / circuit**: potable water, waste/drainage (gravity), heating, gas, other?",
    nl: "- **Medium / circuit**: drinkwater, afvalwater/riolering (zwaartekracht), verwarming, gas, anders?",
    pl: "- **Czynnik / obieg**: woda pitna, ścieki/kanalizacja (grawitacja), co, gaz, inne?",
  },
  diameter: {
    fr: "- **Canalisation** : diamètre nominal du tuyau (ex. DN32, Ø40 mm) — uniquement si la réparation porte sur un tube rigide percé/fissuré.",
    en: "- **Pipe**: nominal pipe diameter (e.g. DN32, 40 mm) — only for rigid pipe hole/crack repair.",
    nl: "- **Leiding**: nominale diameter (bijv. DN32, 40 mm) — alleen bij reparatie van een gat/scheur in een starre leiding.",
    pl: "- **Rura**: średnica nominalna (np. DN32, 40 mm) — tylko przy naprawie otworu/pęknięcia w sztywnej rurze.",
  },
  pressure: {
    fr: "- **Pression / régime** : sous pression (indiquez bar si connu) ou gravitaire / sans pression.",
    en: "- **Pressure / regime**: pressurized (bar if known) vs gravity / non-pressurized.",
    nl: "- **Druk / regime**: onder druk (bar indien bekend) versus zwaartekracht / niet onder druk.",
    pl: "- **Ciśnienie / reżim**: pod ciśnieniem (bar jeśli znane) vs grawitacyjnie / bez ciśnienia.",
  },
  joint_service_fluid: {
    fr: "- **Fluide ou milieu au contact du joint** : eau potable, eaux usées / évacuation gravitaire ou sous pression, eau glycolée ou caloporteur / circuit fermé chauffage, hydrocarbures (fuel, mazout, etc.), gaz (réseau, GPL…) ? _(Plusieurs familles produits selon les fiches technique — précision indispensable.)_",
    en: "- **Fluid contacting the seal**: potable water, sanitary waste / drained or pressurized, glycol / closed heating circuit, hydrocarbons, gas (natural, LPG…)?",
    nl: "- **Medium dat de afdichting raakt**: drinkwater, afvalwater/riolering, glycol/gesloten verwarmingscircuit, koolwaterstoffen, gas (aardgas, LPG…)?",
    pl: "- **Medium w kontakcie z uszczelnieniem**: woda pitna, ścieki kanalizacyjne, glikol / obieg zamknięty CO, węglowodory, gaz (LPG)?",
  },
};

const CLARIFICATION_HEADER: Record<string, string> = {
  fr: "Avant de recommander un produit **compatible et conforme** à votre situation, merci de préciser :",
  en: "Before recommending a **compatible, specification-backed** product, please confirm:",
  nl: "Voordat ik een **compatibel en documentatie-gestuurd** product aanbeveel, graag het volgende:",
  pl: "Zanim zaproponuję produkt **zgodny i poparty dokumentacją**, proszę o:",
};

const CLARIFICATION_FOOTER: Record<string, string> = {
  fr: "_Ces éléments permettent de croiser fiches techniques (TDS) et FDS (SDS) pour les limites d'usage._",
  en: "_These details allow cross-checking TDS application limits and SDS safety constraints._",
  nl: "_Zo kunnen TDS-toepassingsgrenzen en SDS-veiligheid worden vergeleken._",
  pl: "_To pozwala zestawić limity TDS i wymagania bezpieczeństwa SDS._",
};

function buildClarificationFromMetadata(metadata: ExtractedMetadata, locale: string): string {
  const lang = locale in CLARIFICATION_HEADER ? locale : "fr";
  const bullets: string[] = [];

  for (const param of metadata.missing_params) {
    const template = CLARIFICATION_TEMPLATES[param];
    if (template) {
      bullets.push(template[lang] ?? template["fr"] ?? "");
    }
  }

  if (bullets.length === 0 && metadata.needs_clarification) {
    const generic: Record<string, string> = {
      fr: "- Précisez le support, le fluide et l'emplacement (tuyau rigide, raccord fileté, évier, etc.).",
      en: "- Specify substrate, fluid, and location (rigid pipe, threaded joint, sink, etc.).",
      nl: "- Geef substraat, medium en plaats (starre leiding, schroefkoppeling, spoelbak, enz.).",
      pl: "- Określ podłoże, czynnik i miejsce (sztywna rura, połączenie gwintowane, zlew itd.).",
    };
    bullets.push(generic[lang] ?? generic["fr"] ?? "");
  }

  return [
    CLARIFICATION_HEADER[lang] ?? CLARIFICATION_HEADER["fr"] ?? "",
    ...bullets,
    "",
    CLARIFICATION_FOOTER[lang] ?? CLARIFICATION_FOOTER["fr"] ?? "",
  ].join("\n");
}
