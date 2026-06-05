import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { ensureSession } from "../services/database.service.js";
import { geolocateIp } from "../services/rag.service.js";
import { normalizeLocale } from "../utils/locale.js";
import { getClientIp } from "../utils/session.js";

export async function getGeolocation(req: Request, res: Response) {
    const locale = normalizeLocale(typeof req.query.locale === "string" ? req.query.locale : undefined);
    const headerSessionId = req.header("x-session-id")?.trim() ?? "";
    const querySessionId = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
    const sessionId = headerSessionId || querySessionId || randomUUID();
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
