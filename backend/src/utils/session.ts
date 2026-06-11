import { randomUUID } from "node:crypto";
import type express from "express";
import type { ChatRequestBody } from "../types/index.js";
import { isValidUuid } from "./sanitize.js";

function resolveSessionId(candidate: string | undefined): string | null {
  const trimmed = candidate?.trim() ?? "";
  if (!trimmed) return null;
  return isValidUuid(trimmed) ? trimmed : null;
}

export function getIncomingSessionId(req: express.Request, body: ChatRequestBody): string {
  return (
    resolveSessionId(body.sessionId) ??
    resolveSessionId(req.header("x-session-id") ?? undefined) ??
    randomUUID()
  );
}


export function getClientIp(req: express.Request): string | null {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  const realIp = req.header("x-real-ip");
  if (realIp) return realIp.trim();
  const ip = req.ip?.replace("::ffff:", "").trim();
  return ip || null;
}

