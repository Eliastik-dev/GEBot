import { z } from "zod";
import { env } from "../config/env.js";
import { isValidIsoCountry, isValidUuid, sanitizeUserText } from "../utils/sanitize.js";

const sessionIdSchema = z
  .string()
  .trim()
  .refine((v) => isValidUuid(v), { message: "sessionId must be a valid UUID" });

const localeSchema = z.enum(["fr", "en", "nl", "pl"]).optional();

const profileSchema = z.enum(["professional", "particulier"]).nullish();

const themeSchema = z
  .enum(["plomberie", "piscine", "chauffage", "batiment", "maintenance", "automobile", "eco-conception"])
  .nullish();

export const chatBodySchema = z.object({
  message: z
    .string()
    .transform((v) => sanitizeUserText(v, env.CHAT_MESSAGE_MAX_LENGTH))
    .refine((v) => v.length > 0, { message: "Missing 'message'" }),
  sessionId: sessionIdSchema.optional(),
  locale: localeSchema,
  profile: profileSchema,
  theme: themeSchema,
  geoConsent: z.boolean().optional(),
  geoCountry: z.preprocess(
    (v) => (typeof v === "string" && v.trim() ? v.trim().toUpperCase() : undefined),
    z
      .string()
      .refine((v) => isValidIsoCountry(v), { message: "geoCountry must be a 2-letter ISO code" })
      .optional(),
  ),
});

export const feedbackBodySchema = z.object({
  messageId: z.preprocess(
    (val) => (val == null || val === "" ? val : String(val)),
    z
      .string()
      .trim()
      .min(1)
      .refine((v) => /^\d+$/.test(v) || isValidUuid(v), {
        message: "messageId must be a numeric id or UUID",
      }),
  ),
  sessionId: sessionIdSchema,
  sessionToken: z.string().trim().min(1).optional(),
  feedback: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
});

export const geolocationQuerySchema = z.object({
  locale: localeSchema,
  sessionId: sessionIdSchema.optional(),
});
