import { describe, expect, it } from "vitest";
import { issueSessionToken, readSessionTokenFromRequest, verifySessionToken } from "./session-token.js";

const VALID_SESSION = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_SESSION = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

describe("issueSessionToken / verifySessionToken", () => {
  it("round-trips a valid token", () => {
    const token = issueSessionToken(VALID_SESSION, 1_700_000_000_000);
    expect(verifySessionToken(token, VALID_SESSION, 1_700_000_000_000)).toBe(true);
  });

  it("rejects tampered sessionId in request body", () => {
    const token = issueSessionToken(VALID_SESSION, 1_700_000_000_000);
    expect(verifySessionToken(token, OTHER_SESSION, 1_700_000_000_000)).toBe(false);
  });

  it("rejects expired tokens", () => {
    const token = issueSessionToken(VALID_SESSION, 1_700_000_000_000);
    expect(verifySessionToken(token, VALID_SESSION, 1_700_086_400_001)).toBe(false);
  });

  it("rejects malformed tokens", () => {
    expect(verifySessionToken("not-a-token", VALID_SESSION)).toBe(false);
    expect(verifySessionToken("v1.only.three", VALID_SESSION)).toBe(false);
  });

  it("rejects invalid sessionId at issue time", () => {
    expect(() => issueSessionToken("bad-id")).toThrow(/invalid sessionId/i);
  });

  it("uses timing-safe comparison (tampered signature fails)", () => {
    const token = issueSessionToken(VALID_SESSION, 1_700_000_000_000);
    const parts = token.split(".");
    parts[3] = parts[3]!.slice(0, -1) + (parts[3]!.endsWith("a") ? "b" : "a");
    expect(verifySessionToken(parts.join("."), VALID_SESSION, 1_700_000_000_000)).toBe(false);
  });
});

describe("readSessionTokenFromRequest", () => {
  it("prefers the header over the body", () => {
    expect(readSessionTokenFromRequest("header-token", "body-token")).toBe("header-token");
  });

  it("falls back to body token", () => {
    expect(readSessionTokenFromRequest(undefined, "body-token")).toBe("body-token");
  });
});
