import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { isValidUuid } from "./sanitize.js";

const TOKEN_VERSION = "v1";

function signingSecret(): string {
  return env.SESSION_TOKEN_SECRET;
}

function signPayload(sessionId: string, expSec: number): string {
  const message = `${TOKEN_VERSION}|${sessionId}|${expSec}`;
  return createHmac("sha256", signingSecret()).update(message).digest("base64url");
}

/** Issue a short-lived HMAC token bound to `sessionId`. */
export function issueSessionToken(sessionId: string, nowMs = Date.now()): string {
  if (!isValidUuid(sessionId)) {
    throw new Error("Cannot issue session token for invalid sessionId");
  }
  const expSec = Math.floor(nowMs / 1000) + Math.floor(env.SESSION_TOKEN_TTL_MS / 1000);
  const sessionPart = Buffer.from(sessionId, "utf8").toString("base64url");
  const signature = signPayload(sessionId, expSec);
  return `${TOKEN_VERSION}.${sessionPart}.${expSec}.${signature}`;
}

/** Verify token signature, expiry, and that it matches the claimed `sessionId`. */
export function verifySessionToken(token: string, sessionId: string, nowMs = Date.now()): boolean {
  if (!token?.trim() || !isValidUuid(sessionId)) return false;

  const parts = token.trim().split(".");
  if (parts.length !== 4) return false;

  const [version, sessionPart, expPart, signature] = parts;
  if (version !== TOKEN_VERSION || !sessionPart || !expPart || !signature) return false;

  const expSec = Number(expPart);
  if (!Number.isFinite(expSec) || expSec <= Math.floor(nowMs / 1000)) return false;

  let tokenSessionId: string;
  try {
    tokenSessionId = Buffer.from(sessionPart, "base64url").toString("utf8");
  } catch {
    return false;
  }
  if (tokenSessionId !== sessionId) return false;

  const expected = signPayload(sessionId, expSec);
  const provided = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length) return false;
  return timingSafeEqual(provided, expectedBuf);
}

/** Read `X-Session-Token` header or JSON `sessionToken` field. */
export function readSessionTokenFromRequest(
  headerValue: string | undefined,
  bodyToken: string | undefined,
): string {
  const fromHeader = headerValue?.trim() ?? "";
  if (fromHeader) return fromHeader;
  return bodyToken?.trim() ?? "";
}

export function sessionAuthFields(sessionId: string): { sessionId: string; sessionToken: string } {
  return { sessionId, sessionToken: issueSessionToken(sessionId) };
}
