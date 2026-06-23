import type { Express } from "express";
import { getHealth, getHealthDetail } from "../controllers/health.controller.js";
import { postChat, type ChatDeps } from "../controllers/chat.controller.js";
import { getGeolocation } from "../controllers/geolocation.controller.js";
import { postFeedback } from "../controllers/feedback.controller.js";
import {
  chatRateLimiter,
  feedbackRateLimiter,
  geolocationRateLimiter,
} from "../middleware/security.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { chatBodySchema, feedbackBodySchema, geolocationQuerySchema } from "../validation/schemas.js";

export { RETRIEVAL_FEATURES_VERSION } from "../config/retrieval.js";

export function registerRoutes(app: Express, chatDeps: ChatDeps): void {
  app.get(
    "/api/geolocation",
    geolocationRateLimiter,
    validateQuery(geolocationQuerySchema),
    getGeolocation,
  );
  app.post(
    "/api/chat",
    chatRateLimiter,
    validateBody(chatBodySchema),
    (req, res) => postChat(req, res, chatDeps),
  );
  app.post("/api/feedback", feedbackRateLimiter, validateBody(feedbackBodySchema), postFeedback);
  app.get("/health", getHealth);
  app.get("/health/detail", getHealthDetail);
}
