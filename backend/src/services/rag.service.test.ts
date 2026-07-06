import { describe, expect, it } from "vitest";
import { filterProductKnowledgeByQueryContext } from "../modules/retrieval/product-knowledge/filters.js";
import { buildEnrichedSearchQuery } from "../modules/retrieval/dynamic-reranker.js";
import type { ExtractedMetadata } from "../modules/retrieval/intent-extractor.js";
import type { ProductKnowledgeRow } from "../types/product-knowledge.js";
import { enrichRetrievalQuery } from "./rag.service.js";
import type { StoredMessage } from "../types/index.js";

const meta = (overrides: Partial<ExtractedMetadata> = {}): ExtractedMetadata => ({
  intent: "general_technical",
  confidence: 0.9,
  fluid: "chauffage",
  pressure: "low",
  diameter: null,
  material: null,
  accessibility: "unknown",
  damage_type: null,
  safety_keywords: [],
  missing_params: [],
  needs_clarification: false,
  synonyms: ["fuite", "colmatage", "silicone", "mastic sanitaire", "desembouant"],
  method: "hybrid",
  ...overrides,
});

const row = (slug: string, name: string): ProductKnowledgeRow =>
  ({
    slug,
    canonical_name: name,
    locale: "fr",
    use_case_tags: [],
    compatible_materials: [],
    incompatible_materials: [],
    compatible_fluids: [],
    incompatible_fluids: [],
  }) as ProductKnowledgeRow;

describe("enrichRetrievalQuery", () => {
  const history: StoredMessage[] = [
    { role: "user", content: "je n'ai plus de pression eau chaude" },
    { role: "assistant", content: "comparaison produits..." },
    { role: "user", content: "peu de pression sur tous mes robinets eau chaude sanitaire" },
    { role: "assistant", content: "resine..." },
    { role: "user", content: "pas de fuite" },
  ];

  it("does not keep leak thread after user negates leak", () => {
    const q = enrichRetrievalQuery("chaudiere gaz", history, "chaudiere gaz");
    expect(q).not.toMatch(/\(fluide:\s*gaz\)/i);
    expect(q.toLowerCase()).toContain("chaudiere gaz");
    expect(q.toLowerCase()).toContain("pression");
  });

  it("merges ECS pressure context for thin follow-up", () => {
    const q = enrichRetrievalQuery("pas de fuite", history, "pas de fuite");
    expect(q.toLowerCase()).toContain("pas de fuite");
    expect(q.toLowerCase()).toMatch(/pression|robinet|eau chaude/);
  });
});

describe("buildEnrichedSearchQuery hydraulic ECS", () => {
  it("strips leak and silicone synonyms for pressure diagnostic", () => {
    const q = buildEnrichedSearchQuery(
      "peu de pression sur tous mes robinets eau chaude sanitaire",
      meta(),
    );
    expect(q).not.toMatch(/silicone|mastic sanitaire|fuite|colmatage/i);
  });
});

describe("filterProductKnowledgeByQueryContext hydraulic ECS", () => {
  it("removes coupe-feu and piscine products from pressure ECS queries", () => {
    const products = [
      row("gebsomousse-intumescente-coupe-feu", "GEBSOMOUSSE INTUMESCENTE COUPE-FEU"),
      row("pool-kit-de-reparation-liner", "POOL KIT REPARATION LINER"),
      row("desembouant-g3", "DESEMBOUANT G3"),
    ];
    const filtered = filterProductKnowledgeByQueryContext(
      products,
      "peu de pression sur tous mes robinets eau chaude sanitaire",
      "plomberie",
    );
    expect(filtered.map((p) => p.slug)).toEqual(["desembouant-g3"]);
  });

  it("removes thread paste when user denied leak", () => {
    const products = [
      row("gebetanche-eau-potable-rt1-geb", "GEBETANCHE EAU POTABLE RT1"),
      row("desembouant-g3", "DESEMBOUANT G3"),
    ];
    const filtered = filterProductKnowledgeByQueryContext(
      products,
      "pas de fuite peu de pression eau chaude sanitaire",
      "plomberie",
    );
    expect(filtered.some((p) => p.slug.includes("gebetanche"))).toBe(false);
    expect(filtered.some((p) => p.slug.includes("desembou"))).toBe(true);
  });
});
