import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AmazonLocale = "fr" | "nl";
export type AmazonLinksByLocale = Record<AmazonLocale, Record<string, string>>;

const EMPTY_LINKS: AmazonLinksByLocale = { fr: {}, nl: {} };

/** Resolve backend package root (works from src/ and dist/). */
export function resolveBackendRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveAmazonLinksDataDir(configured: string): string {
  const trimmed = configured.trim();
  if (!trimmed) return path.join(resolveBackendRoot(), "data");
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed);
}

function parseLinksFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn("[startup] Invalid Amazon links JSON (expected object):", filePath);
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === "string" && typeof value === "string" && value.trim()) {
        out[key] = value.trim();
      }
    }
    return out;
  } catch (error) {
    console.warn("[startup] Cannot read Amazon links JSON:", filePath, error);
    return {};
  }
}

/** Load pre-generated Amazon product URLs from `backend/data/amazon-links.{fr,nl}.json`. */
export function loadAmazonLinksFromJson(dataDir: string): AmazonLinksByLocale {
  const baseDir = resolveAmazonLinksDataDir(dataDir);
  const fr = parseLinksFile(path.join(baseDir, "amazon-links.fr.json"));
  const nl = parseLinksFile(path.join(baseDir, "amazon-links.nl.json"));
  const links: AmazonLinksByLocale = { fr, nl };

  const frCount = Object.keys(fr).length;
  const nlCount = Object.keys(nl).length;
  if (frCount === 0 && nlCount === 0) {
    console.warn(
      `[startup] Amazon links JSON empty or missing in ${baseDir} — run: npm run convert-amazon-links --prefix backend`,
    );
  } else {
    console.log("[startup] Amazon links loaded", { dataDir: baseDir, fr: frCount, nl: nlCount });
  }

  return links;
}

export function emptyAmazonLinks(): AmazonLinksByLocale {
  return { fr: { ...EMPTY_LINKS.fr }, nl: { ...EMPTY_LINKS.nl } };
}
