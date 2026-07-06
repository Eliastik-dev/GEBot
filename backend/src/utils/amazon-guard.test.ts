import { describe, expect, it } from "vitest";
import {
  getAmazonDefaultUrl,
  hasValidRecommendedProduct,
  isGenericAmazonSearchUrl,
  shouldInjectAmazonSection,
} from "./amazon.js";

describe("amazon guard", () => {
  it("detects generic Amazon search URLs", () => {
    expect(isGenericAmazonSearchUrl(getAmazonDefaultUrl("fr", null))).toBe(true);
    expect(isGenericAmazonSearchUrl("https://www.amazon.fr/dp/B0123456")).toBe(false);
  });

  it("blocks injection without a valid product", () => {
    const answer = "Voici des pistes de diagnostic sans produit nommé.";
    const recommendation = { productName: null, amazonUrl: getAmazonDefaultUrl("fr", null) };
    expect(shouldInjectAmazonSection(answer, recommendation)).toBe(false);
  });

  it("blocks injection when only a generic search URL is available", () => {
    const answer = "### 📦 Produit Recommandé : **DESEMBOUANT G3**\nDescription...";
    expect(hasValidRecommendedProduct(answer)).toBe(true);
    const recommendation = { productName: "DESEMBOUANT G3", amazonUrl: getAmazonDefaultUrl("fr", "DESEMBOUANT G3") };
    expect(shouldInjectAmazonSection(answer, recommendation)).toBe(false);
  });
});
