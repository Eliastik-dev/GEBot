import { hasHeatingCircuitContext } from "./diagnostic-rules.js";

function normalizeFluidContextText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Chaudière gaz / ballon ECS — le mot « gaz » désigne le combustible, pas le fluide au robinet. */
export function isGasHeatingEquipmentContext(text: string): boolean {
  const n = normalizeFluidContextText(text);
  if (/\bchaudiere\s+gaz\b/.test(n) || /\bchauffe\s+eau\s+gaz\b/.test(n)) return true;
  return (
    /\b(chaudiere|cumulus|ballon)\b/.test(n) &&
    /\b(gaz|gas)\b/.test(n) &&
    /\b(eau\s+chaude|ecs|sanitaire|robinet|pression|odeur|ballon)\b/.test(n)
  );
}

/** Gaz transporté dans une canalisation (fuite gaz, raccord gaz…) — pas équipement ECS. */
export function isTransportedGasContext(text: string): boolean {
  const n = normalizeFluidContextText(text);
  if (isGasHeatingEquipmentContext(text)) return false;
  return (
    /\b(gaz|gas|gpl|butane|propane|gaz\s+de\s+ville)\b/.test(n) &&
    /\b(tuyau|canalisation|raccord|fuite|leak|conduit|installation\s+gaz|compteur|detendeur|bruleur)\b/.test(n)
  );
}

export function hasNegatedLeakInText(text: string): boolean {
  const n = normalizeFluidContextText(text);
  return /\b(pas\s+de\s+fuite|pas\s+d[\s']?infiltration|aucune\s+fuite|sans\s+fuite|no\s+leak)\b/.test(n);
}

/** Perte / manque de pression ou débit sur robinetterie ou ECS — diagnostic hydraulique, pas fuite filetage. */
export function hasHydraulicPressureIssueContext(text: string): boolean {
  const n = normalizeFluidContextText(text);
  const pressureIssue =
    /\b(plus\s+de\s+pression|perte\s+de\s+pression|peu\s+de\s+pression|manque\s+de\s+pression|pression\s+(faible|basse)|debit\s+(faible|bas)|manque\s+d[\s']?eau)\b/.test(
      n,
    );
  const hydraulicContext = /\b(robinet|mitigeur|mousseur|eau\s+chaude|eau\s+froide|ecs|sanitaire|douche|lavabo|ballon|chaudiere|cumulus)\b/.test(
    n,
  );
  return pressureIssue && hydraulicContext;
}

/** Nouveau symptôme ou question de diagnostic — ne pas traiter comme follow-up produit. */
export function isNewDiagnosticTurn(query: string): boolean {
  const n = normalizeFluidContextText(query);
  if (hasHydraulicPressureIssueContext(query)) return true;
  if (/\b(comment\s+retrouver|comment\s+regler|pourquoi\s+(j'ai|ai\s+je))\b/.test(n)) return true;
  if (/\bodeur\b/.test(n) && /\b(eau\s+chaude|ecs|sanitaire|ballon|chaudiere|cumulus)\b/.test(n)) {
    return true;
  }
  if (/\bchaudiere\b/.test(n) && !/\b(ce\s+produit|celui|le\s+meme|produit\s+conseille)\b/.test(n)) {
    return true;
  }
  return false;
}

/** Pression ECS / entretien chaudière — hors étanchéité filetée, coupe-feu, piscine. */
export function isHydraulicEcsDiagnosticContext(text: string): boolean {
  const n = normalizeFluidContextText(text);
  if (hasHydraulicPressureIssueContext(text)) return true;
  if (isGasHeatingEquipmentContext(text)) return true;
  if (hasHeatingCircuitContext(text) && /\b(pression|robinet|ecs|odeur|debit)\b/.test(n)) return true;
  if (hasNegatedLeakInText(text) && /\b(pression|robinet|eau\s+chaude|ecs|chaudiere)\b/.test(n)) {
    return true;
  }
  return false;
}

/** Missing clarification keys for thin ECS pressure diagnostics (equipment type, tap scope). */
export function getHydraulicEcsMissingClarificationParams(text: string): string[] {
  if (!isHydraulicEcsDiagnosticContext(text)) return [];
  const n = normalizeFluidContextText(text);
  const pressureMentioned =
    hasHydraulicPressureIssueContext(text) ||
    /\b(pression|debit|manque\s+d[\s']?eau|moins\s+d[\s']?eau)\b/.test(n);

  const hasEquipment =
    /\b(chaudiere|cumulus|ballon(\s+ecs)?|chauffe\s+eau|ballon\s+de\s+eau\s+chaude)\b/.test(n);
  const hasScope =
    /\b(tous\s+(les\s+)?robinet|chaque\s+robinet|un\s+seul|seul\s+robinet|partout|sur\s+tous)\b/.test(n) ||
    (/\b(robinet|mitigeur|douche|lavabo|evier)\b/.test(n) &&
      /\b(eau\s+froide|eau\s+chaude|ecs|sanitaire)\b/.test(n));

  const params: string[] = [];
  if (pressureMentioned && !hasEquipment) params.push("ecs_equipment");
  if ((pressureMentioned || hasEquipment) && !hasScope) params.push("ecs_pressure_scope");
  return params;
}
