import type { NextFunction, Request, Response } from "express";
import { safeErrorPayload } from "../utils/http.js";

export function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const message = error instanceof Error ? error.message : "Internal error";
  if (/cors blocked/i.test(message)) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  res.status(500).json(safeErrorPayload(message, error));
}
