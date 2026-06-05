import { existsSync } from "node:fs";
import * as XLSX from "xlsx";

type AmazonLocale = "fr" | "nl";

type AmazonWorkbookRow = {
  ref_geb?: string | number;
  URL?: string;
  URLs?: string;
  url?: string;
  designation?: string;
  Désignation?: string;
  pays?: string;
};

export type AmazonLinksByLocale = Record<AmazonLocale, Record<string, string>>;

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCountry(country: string): AmazonLocale | null {
  const value = normalizeText(country);
  if (value === "france" || value === "fr") return "fr";
  if (value === "nl" || value === "nederland" || value === "pays bas" || value === "netherlands") return "nl";
  return null;
}

function inferLocaleFromSheetName(sheetName: string): AmazonLocale | null {
  const normalized = normalizeText(sheetName);
  if (normalized.includes("amazon fr")) return "fr";
  if (normalized.includes("amazon nl")) return "nl";
  return null;
}

function readStringField(row: Record<string, unknown>, names: string[]): string {
  for (const key of names) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value).trim();
  }
  return "";
}

function normalizeAmazonProductUrl(rawUrl: string): string {
  if (!rawUrl) return "";
  const url = rawUrl.trim();
  if (!url) return "";
  if (!/amazon\./i.test(url)) return "";
  return url;
}

function normalizeRef(ref: string | number | undefined): string | null {
  const raw = String(ref ?? "")
    .replace(/\s+/g, "")
    .trim();
  return raw ? raw : null;
}

export function loadAmazonLinksFromWorkbook(filePath: string): AmazonLinksByLocale {
  const links: AmazonLinksByLocale = { fr: {}, nl: {} };
  if (!filePath || !existsSync(filePath)) return links;

  try {
    const xlsxApi = (XLSX as unknown as { default?: { readFile?: typeof XLSX.read; utils?: typeof XLSX.utils } }).default;
    const readFile = xlsxApi?.readFile;
    const utils = xlsxApi?.utils ?? XLSX.utils;
    if (typeof readFile !== "function") {
      throw new TypeError("XLSX readFile API unavailable");
    }
    const workbook = readFile(filePath);
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const rows = utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      if (rows.length === 0) continue;

      const localeFromSheet = inferLocaleFromSheetName(sheetName);

      for (const row of rows) {
        const rawUrl =
          readStringField(row, ["URL", "URLs", "url", "Lien fixe", "Lien dynamique", "Original_URL"]) ||
          "";
        const url = normalizeAmazonProductUrl(rawUrl);
        if (!url) continue;

        const designation = readStringField(row, ["designation", "Désignation", " Désignation Produit"]);
        const countryRaw = readStringField(row, ["pays"]);
        const country = normalizeCountry(countryRaw) ?? localeFromSheet;
        if (!country) continue;

        const ref = normalizeRef(
          readStringField(row, ["ref_geb", " Code ", "SKU", "Code boutique", "CODE GEB"]) || undefined,
        );

        if (designation) {
          links[country][normalizeText(designation)] = url;
        }
        if (ref) {
          links[country][`ref_geb:${ref}`] = url;
        }
      }
    }
  } catch (error) {
    console.warn("[startup] Cannot parse Amazon workbook:", error);
  }

  return links;
}

