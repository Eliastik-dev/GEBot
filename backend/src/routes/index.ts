import type { Express } from "express";
import { postChat, type ChatDeps } from "../controllers/chat.controller.js";
import { getGeolocation } from "../controllers/geolocation.controller.js";
import { postFeedback } from "../controllers/feedback.controller.js";

export function registerRoutes(app: Express, chatDeps: ChatDeps): void {
  app.get("/api/geolocation", getGeolocation);
  app.post("/api/chat", (req, res) => postChat(req, res, chatDeps));
  app.post("/api/feedback", postFeedback);
  app.get("/health", (_req, res) => res.json({ ok: true }));
}
