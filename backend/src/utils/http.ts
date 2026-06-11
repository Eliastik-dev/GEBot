import { env } from "../config/env.js";

export function isProduction(): boolean {
  return env.NODE_ENV === "production";
}

export function safeErrorPayload(message: string, err?: unknown): { error: string; stack?: string } {
  const payload: { error: string; stack?: string } = { error: message };
  if (!isProduction() && err instanceof Error && err.stack) {
    payload.stack = err.stack;
  }
  return payload;
}
