import { describe, expect, it } from "vitest";
import { sanitizeIlikeSearchTerm } from "./product-mention.js";

describe("sanitizeIlikeSearchTerm", () => {
  it("returns safe product-like terms", () => {
    expect(sanitizeIlikeSearchTerm("g110")).toBe("g110");
    expect(sanitizeIlikeSearchTerm("  ms zinc  ")).toBe("ms zinc");
  });

  it("rejects terms containing ilike metacharacters", () => {
    expect(sanitizeIlikeSearchTerm("g%110_")).toBeNull();
    expect(sanitizeIlikeSearchTerm("term%")).toBeNull();
  });

  it("rejects punctuation and injection-like input", () => {
    expect(sanitizeIlikeSearchTerm("foo;drop")).toBeNull();
    expect(sanitizeIlikeSearchTerm("a,b")).toBeNull();
  });

  it("rejects terms that are too short or too long", () => {
    expect(sanitizeIlikeSearchTerm("a")).toBeNull();
    expect(sanitizeIlikeSearchTerm("x".repeat(49))).toBeNull();
  });

  it("rejects long multi-word sentences", () => {
    expect(sanitizeIlikeSearchTerm("un deux trois quatre cinq")).toBeNull();
  });
});
