import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { ensureSession } from "../services/database.service.js";
import { geolocateIp } from "../services/rag.service.js";
import { normalizeLocale } from "../utils/locale.js";
import { isValidUuid } from "../utils/sanitize.js";
import { getClientIp } from "../utils/session.js";
import type { geolocationQuerySchema } from "../validation/schemas.js";
import type { z } from "zod";

type GeolocationQuery = z.infer<typeof geolocationQuerySchema>;

export async function getGeolocation(req: Request, res: Response) {
    const query = (req as Request & { validatedQuery?: GeolocationQuery }).validatedQuery;
    const locale = normalizeLocale(query?.locale);
    const headerSessionId = req.header("x-session-id")?.trim() ?? "";
    const querySessionId = query?.sessionId ?? "";
    const sessionId =
      (isValidUuid(headerSessionId) && headerSessionId) ||
      (isValidUuid(querySessionId) && querySessionId) ||
      randomUUID();
    try {
      const ip = getClientIp(req);
      const geolocation = await geolocateIp(ip);
      await ensureSession(sessionId, locale, true, geolocation.countryCode);
      res.json({
        sessionId,
        countryCode: geolocation.countryCode,
        isOutsideFrance: geolocation.countryCode ? geolocation.countryCode !== "FR" : null,
      });
    } catch (error) {
      console.warn("[/api/geolocation] failed:", error);
      res.json({
        sessionId,
        countryCode: null,
        isOutsideFrance: null,
      });
    }
}
