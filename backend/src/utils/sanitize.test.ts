import { describe, expect, it } from "vitest";
import { isValidIsoCountry, isValidUuid, sanitizeUserText } from "./sanitize.js";

describe("sanitizeUserText", () => {
  it("strips null bytes and control characters", () => {
    expect(sanitizeUserText("hello\u0000world\x07", 100)).toBe("helloworld");
  });

  it("preserves newlines and tabs", () => {
    expect(sanitizeUserText("line1\nline2\ttab", 100)).toBe("line1\nline2\ttab");
  });

  it("trims after enforcing max length", () => {
    expect(sanitizeUserText("  abcdefghij  ", 5)).toBe("abc");
  });
});

describe("isValidUuid", () => {
  it("accepts RFC-4122 UUIDs", () => {
    expect(isValidUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("rejects malformed values", () => {
    expect(isValidUuid("not-a-uuid")).toBe(false);
    expect(isValidUuid("550e8400-e29b-41d4-a716")).toBe(false);
  });
});

describe("isValidIsoCountry", () => {
  it("accepts two-letter uppercase codes", () => {
    expect(isValidIsoCountry("FR")).toBe(true);
    expect(isValidIsoCountry("PL")).toBe(true);
  });

  it("rejects invalid codes", () => {
    expect(isValidIsoCountry("fr")).toBe(false);
    expect(isValidIsoCountry("FRA")).toBe(false);
  });
});
