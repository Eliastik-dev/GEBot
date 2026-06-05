import { randomUUID } from "node:crypto";
import type express from "express";
import type { ChatRequestBody } from "../types/index.js";

export function getIncomingSessionId(req: express.Request, body: ChatRequestBody): string {
  const fromBody = (body.sessionId ?? "").trim();
  if (fromBody) return fromBody;
  const fromHeader = req.header("x-session-id")?.trim() ?? "";
  if (fromHeader) return fromHeader;
  return randomUUID();
}


export function getClientIp(req: express.Request): string | null {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  const realIp = req.header("x-real-ip");
  if (realIp) return realIp.trim();
  const ip = req.ip?.replace("::ffff:", "").trim();
  return ip || null;
}

