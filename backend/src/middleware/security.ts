import cors from "cors";
import type { Express, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { env } from "../config/env.js";

function buildAllowedOrigins(): Set<string> {
  const origins = new Set<string>([
    "http://localhost:5173",
    "http://localhost:4173",
    "http://127.0.0.1:5173",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
  ]);

  for (const entry of env.CORS_ALLOWED_ORIGINS) {
    const trimmed = entry.trim().replace(/\/$/, "");
    if (trimmed) origins.add(trimmed);
  }

  try {
    const wp = new URL(env.WP_URL);
    origins.add(wp.origin);
    if (wp.hostname.startsWith("www.")) {
      origins.add(`${wp.protocol}//${wp.hostname.slice(4)}`);
    } else {
      origins.add(`${wp.protocol}//www.${wp.hostname}`);
    }
  } catch {
    // WP_URL validated at startup; ignore parse edge cases here.
  }

  return origins;
}

const allowedOrigins = buildAllowedOrigins();

function isSameProxyHost(origin: string, requestHost: string | undefined): boolean {
  if (!requestHost) return false;
  try {
    const originUrl = new URL(origin);
    const [hostName] = requestHost.toLowerCase().split(":");
    return originUrl.hostname.toLowerCase() === hostName;
  } catch {
    return false;
  }
}

/** CORS with same-vhost bypass (widget + /api on one Nginx server_name). */
export const corsMiddleware: RequestHandler = (req, res, next) => {
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      const normalized = origin.replace(/\/$/, "");
      if (allowedOrigins.has(normalized)) {
        callback(null, true);
        return;
      }
      if (isSameProxyHost(normalized, req.headers.host)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Session-Id"],
    exposedHeaders: ["Content-Type"],
    maxAge: 86_400,
    credentials: false,
  })(req, res, next);
};

export const helmetMiddleware: RequestHandler = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

export const generalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

export const chatRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Chat rate limit exceeded. Please wait before sending more messages." },
});

export const feedbackRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Feedback rate limit exceeded." },
});

export const geolocationRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Geolocation rate limit exceeded." },
});

export function applySecurityMiddleware(app: Express): void {
  if (env.TRUST_PROXY) {
    app.set("trust proxy", 1);
  }
  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(generalRateLimiter);
}
