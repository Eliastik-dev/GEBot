import { describe, expect, it } from "vitest";
import { detectProblemType } from "./ai.service.js";

describe("detectProblemType", () => {
  it("classifies ECS pressure on raw user message", () => {
    expect(detectProblemType("je n'ai plus de pression eau chaude")).toBe("ecs_pressure_issue");
    expect(detectProblemType("pas de fuite")).toBe("general_technical");
    expect(detectProblemType("chaudiere gaz")).toBe("general_technical");
  });

  it("does not classify enriched leak synonyms as leak when user negated leak", () => {
    expect(detectProblemType("pas de fuite peu de pression eau chaude sanitaire")).toBe("ecs_pressure_issue");
    expect(
      detectProblemType(
        "pas de fuite peu de pression eau chaude\nfuite colmatage silicone gebetanche",
      ),
    ).toBe("ecs_pressure_issue");
  });
});
