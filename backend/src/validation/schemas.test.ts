import { describe, expect, it } from "vitest";
import { chatBodySchema, feedbackBodySchema, geolocationQuerySchema } from "./schemas.js";
import { issueSessionToken } from "../utils/session-token.js";

const VALID_SESSION = "550e8400-e29b-41d4-a716-446655440000";

describe("chatBodySchema", () => {
  it("parses a minimal valid chat body", () => {
    const result = chatBodySchema.safeParse({ message: "  Quel produit pour PVC ?  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe("Quel produit pour PVC ?");
    }
  });

  it("rejects empty message after sanitization", () => {
    const result = chatBodySchema.safeParse({ message: "   \u0000  " });
    expect(result.success).toBe(false);
  });

  it("normalizes geoCountry to uppercase", () => {
    const result = chatBodySchema.safeParse({
      message: "test",
      geoCountry: "fr",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.geoCountry).toBe("FR");
    }
  });

  it("rejects invalid sessionId", () => {
    const result = chatBodySchema.safeParse({
      message: "test",
      sessionId: "bad-session",
    });
    expect(result.success).toBe(false);
  });
});

describe("feedbackBodySchema", () => {
  const sessionToken = issueSessionToken(VALID_SESSION);

  it("accepts thumbs up/down/clear feedback", () => {
    for (const feedback of [1, -1, 0] as const) {
      const result = feedbackBodySchema.safeParse({
        messageId: "42",
        sessionId: VALID_SESSION,
        sessionToken,
        feedback,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects non-numeric messageId", () => {
    const result = feedbackBodySchema.safeParse({
      messageId: "abc",
      sessionId: VALID_SESSION,
      sessionToken,
      feedback: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("geolocationQuerySchema", () => {
  it("accepts optional locale and sessionId", () => {
    const result = geolocationQuerySchema.safeParse({
      locale: "nl",
      sessionId: VALID_SESSION,
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty query object", () => {
    expect(geolocationQuerySchema.safeParse({}).success).toBe(true);
  });
});
