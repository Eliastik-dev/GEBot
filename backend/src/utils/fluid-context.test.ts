import { describe, expect, it } from "vitest";
import {
  getHydraulicEcsMissingClarificationParams,
  hasHydraulicPressureIssueContext,
  hasNegatedLeakInText,
  isGasHeatingEquipmentContext,
  isHydraulicEcsDiagnosticContext,
  isNewDiagnosticTurn,
  isTransportedGasContext,
} from "./fluid-context.js";
import { extractFluid } from "./text.js";
import {
  getLastDiscussedProductFromHistory,
  isProductFollowUpQuestion,
} from "./conversation-context.js";
import type { StoredMessage } from "../types/index.js";

describe("fluid-context", () => {
  it("treats chaudiere gaz as heating equipment, not transported gas", () => {
    expect(isGasHeatingEquipmentContext("chaudiere gaz")).toBe(true);
    expect(isTransportedGasContext("chaudiere gaz")).toBe(false);
    expect(extractFluid("chaudiere gaz")).toBe("chauffage");
  });

  it("detects transported gas on pipe leak context", () => {
    expect(isTransportedGasContext("fuite sur tuyau gaz de ville")).toBe(true);
    expect(extractFluid("fuite sur tuyau gaz de ville")).toBe("gaz");
  });

  it("detects hydraulic pressure loss without leak", () => {
    expect(hasHydraulicPressureIssueContext("peu de pression sur tous mes robinets eau chaude sanitaire")).toBe(true);
    expect(hasNegatedLeakInText("pas de fuite")).toBe(true);
  });

  it("flags new diagnostic turns", () => {
    expect(isNewDiagnosticTurn("mon eau chaude à une odeur")).toBe(true);
    expect(isNewDiagnosticTurn("comment retrouver la pression dans mes robinets")).toBe(true);
    expect(isNewDiagnosticTurn("chaudiere gaz")).toBe(true);
    expect(isNewDiagnosticTurn("est-ce que ce produit résiste à l'eau chaude")).toBe(false);
  });

  it("detects hydraulic ECS diagnostic context", () => {
    expect(isHydraulicEcsDiagnosticContext("chaudiere gaz")).toBe(true);
    expect(isHydraulicEcsDiagnosticContext("pas de fuite peu de pression eau chaude")).toBe(true);
  });

  it("requests ECS clarification params when context is thin", () => {
    expect(getHydraulicEcsMissingClarificationParams("je n'ai plus de pression eau chaude")).toEqual([
      "ecs_equipment",
      "ecs_pressure_scope",
    ]);
    expect(getHydraulicEcsMissingClarificationParams("chaudiere gaz")).toEqual(["ecs_pressure_scope"]);
    expect(
      getHydraulicEcsMissingClarificationParams(
        "peu de pression sur tous mes robinets eau chaude sanitaire chaudiere gaz",
      ),
    ).toEqual([]);
  });
});

describe("conversation-context product follow-up", () => {
  const historyWithResin: StoredMessage[] = [
    { role: "user", content: "pression eau chaude" },
    {
      role: "assistant",
      content: "### 📦 Produit Recommandé : **RESINE D'ETANCHEITE TOUS FLUIDES**\nDescription...",
    },
  ];

  const historyWithRejection: StoredMessage[] = [
    ...historyWithResin,
    { role: "user", content: "chaudiere gaz" },
    {
      role: "assistant",
      content:
        "Non — **GEBSOMOUSSE INTUMESCENTE COUPE-FEU** est conçu pour le calfeutrement coupe-feu, pas pour les circuits de gaz.",
    },
  ];

  it("does not treat odor on hot water as product follow-up", () => {
    expect(isProductFollowUpQuestion("mon eau chaude à une odeur", historyWithRejection)).toBe(false);
  });

  it("does not treat pressure recovery question as product follow-up", () => {
    expect(isProductFollowUpQuestion("comment retrouver la pression dans mes robinets", historyWithRejection)).toBe(
      false,
    );
  });

  it("skips rejected product when resolving last discussed product", () => {
    expect(getLastDiscussedProductFromHistory(historyWithRejection)).toBe("RESINE D'ETANCHEITE TOUS FLUIDES");
  });
});
