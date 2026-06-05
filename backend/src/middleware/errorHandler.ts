import type { NextFunction, Request, Response } from "express";

export function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const message = error instanceof Error ? error.message : "Internal error";
  res.status(500).json({
    error: message,
    stack: error instanceof Error ? error.stack : undefined,
  });
}
