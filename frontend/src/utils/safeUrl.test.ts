import { describe, expect, it } from "vitest";
import { isSafeHref, sanitizeTel } from "./safeUrl.js";

describe("isSafeHref", () => {
  it("allows http(s) and tel links", () => {
    expect(isSafeHref("https://www.geb.fr/produit")).toBe(true);
    expect(isSafeHref("http://localhost:8787/health")).toBe(true);
    expect(isSafeHref("tel:+33123456789")).toBe(true);
  });

  it("blocks protocol-relative and dangerous schemes", () => {
    expect(isSafeHref("//evil.example")).toBe(false);
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,hi")).toBe(false);
  });

  it("rejects empty or whitespace hrefs", () => {
    expect(isSafeHref(undefined)).toBe(false);
    expect(isSafeHref("   ")).toBe(false);
  });
});

describe("sanitizeTel", () => {
  it("normalizes valid phone numbers", () => {
    expect(sanitizeTel("+33 1 23 45 67 89")).toBe("+33123456789");
  });

  it("rejects invalid phone strings", () => {
    expect(sanitizeTel("not-a-phone")).toBeNull();
    expect(sanitizeTel("12")).toBeNull();
  });
});
