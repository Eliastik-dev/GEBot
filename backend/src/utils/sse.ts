import type express from "express";

export function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  } as const;
}


export function startSse(res: express.Response) {
  if (res.headersSent) return;
  res.status(200);
  Object.entries(sseHeaders()).forEach(([k, v]) => res.setHeader(k, v));
  res.flushHeaders?.();
}


export function sseWrite(res: express.Response, data: unknown, event?: string) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

