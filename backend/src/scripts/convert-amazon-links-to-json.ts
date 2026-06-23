/**
 * One-time / maintenance utility: convert the Amazon links Excel workbook to static JSON.
 *
 * Usage (from repository root):
 *   npm run convert-amazon-links --prefix backend
 *   npm run convert-amazon-links --prefix backend -- --input "P:\path\to\workbook.xlsx"
 *   npm run convert-amazon-links --prefix backend -- --out-dir backend/data
 *
 * Requires `xlsx` (dev-only). After removal from package.json, re-install temporarily to re-run:
 *   npm install -D xlsx --workspace backend
 *   npm run convert-amazon-links --prefix backend
 *   npm uninstall xlsx --workspace backend
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import type { AmazonLinksByLocale } from "../amazon-links.js";

type AmazonLocale = "fr" | "nl";

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

function loadAmazonLinksFromWorkbook(filePath: string): AmazonLinksByLocale {
  const links: AmazonLinksByLocale = { fr: {}, nl: {} };
  if (!filePath || !existsSync(filePath)) return links;

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
        readStringField(row, ["URL", "URLs", "url", "Lien fixe", "Lien dynamique", "Original_URL"]) || "";
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

  return links;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, "../..");

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function resolveDefaultInput(): string {
  const fromCli = readArg("--input");
  if (fromCli) return path.resolve(fromCli);
  if (process.env.AMAZON_LINKS_XLSX_PATH?.trim()) {
    return path.resolve(process.env.AMAZON_LINKS_XLSX_PATH.trim());
  }
  return "P:\\Ecommerce\\Liens produits GEB toutes plateformes.xlsx";
}

function resolveOutDir(): string {
  const fromCli = readArg("--out-dir");
  if (fromCli) return path.resolve(fromCli);
  if (process.env.AMAZON_LINKS_DATA_DIR?.trim()) {
    return path.resolve(process.env.AMAZON_LINKS_DATA_DIR.trim());
  }
  return path.join(backendRoot, "data");
}

function main(): void {
  const inputPath = resolveDefaultInput();
  const outDir = resolveOutDir();
  mkdirSync(outDir, { recursive: true });

  console.log("[convert-amazon-links] Reading workbook:", inputPath);
  const links = loadAmazonLinksFromWorkbook(inputPath);

  const outputs = [
    { locale: "fr" as const, file: "amazon-links.fr.json" },
    { locale: "nl" as const, file: "amazon-links.nl.json" },
  ];

  for (const { locale, file } of outputs) {
    const entries = Object.entries(links[locale]).sort(([a], [b]) => a.localeCompare(b));
    const payload = Object.fromEntries(entries);
    const outPath = path.join(outDir, file);
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`[convert-amazon-links] Wrote ${entries.length} entries → ${outPath}`);
  }

  console.log("[convert-amazon-links] Done.");
}

main();
