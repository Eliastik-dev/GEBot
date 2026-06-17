import axios from "axios";
import * as cheerio from "cheerio";
import { parseWpCatalogFromProduct } from "./wp-catalog-theme.service.js";
import type { ScrapedProductRow } from "./product-theme.service.js";

export const SCRAPE_LOCALES = ["fr", "nl", "pl"] as const;
export type ScrapeLocale = (typeof SCRAPE_LOCALES)[number];

/** Curated FAQ / general knowledge row (also loadable from output/faq-knowledge.json). */
export type ScrapedFaqRow = {
  id: string;
  locale: ScrapeLocale;
  question: string;
  answer: string;
  theme?: string | null;
  audience?: "professional" | "particulier" | "all";
  source_url?: string | null;
  tags?: string[];
};

const LOCALES = SCRAPE_LOCALES;
const WP_PRODUCT_API_BY_LOCALE: Record<(typeof LOCALES)[number], string> = {
  fr: "https://www.geb.fr/wp-json/wp/v2/product",
  nl: "https://www.geb.fr/nl/wp-json/wp/v2/product",
  pl: "https://www.geb.fr/pl/wp-json/wp/v2/product",
};
const PER_PAGE = 100;
const PRODUCT_REQUEST_DELAY_MS = 500;
const HTTP_TIMEOUT_MS = 15000;
const WP_API_TIMEOUT_MS = Number(process.env.SCRAPE_WP_TIMEOUT_MS ?? "45000");
const WP_API_PAGE_DELAY_MS = Number(process.env.SCRAPE_WP_PAGE_DELAY_MS ?? "1000");
const WP_API_MAX_RETRIES = Number(process.env.SCRAPE_WP_MAX_RETRIES ?? "3");

type ScrapeLogger = Pick<Console, "info" | "warn" | "error">;

function getAuthHeader(): Record<string, string> {
  const user = process.env.WP_USER;
  const appPassword = process.env.WP_APP_PASSWORD;
  if (!user || !appPassword) return {};
  const token = Buffer.from(`${user}:${appPassword}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getLanguageToken(locale: string): string {
  if (locale === "nl") return "NL";
  if (locale === "pl") return "PL";
  return "FR";
}

function makeAbsoluteUrl(href: string, baseUrl: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function safeEncodeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return encodeURI(url);
  } catch {
    return url;
  }
}

function replaceLanguageTokenInUrl(url: string, targetLocale: string): string {
  const token = getLanguageToken(targetLocale);
  return url
    .replace(/_FR_/gi, `_${token}_`)
    .replace(/_NL_/gi, `_${token}_`)
    .replace(/_PL_/gi, `_${token}_`);
}

async function urlExistsByHead(url: string, logger: ScrapeLogger = console): Promise<boolean> {
  try {
    const response = await axios.head(url, {
      timeout: HTTP_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
    });
    return response.status === 200;
  } catch (error) {
    logger.warn?.("[scraper] HEAD failed", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function buildLabelMatchers() {
  const ftNeedles = [
    "fiche technique",
    "technical sheet",
    "technical data sheet",
    "technische fiche",
    "technische gegevens",
    "karta techniczna",
    "ft",
  ].map(normalizeText);

  const fdsNeedles = [
    "fiche de donnees de securite",
    "fiche de données de sécurité",
    "safety data sheet",
    "veiligheidsinformatieblad",
    "karta charakterystyki",
    "fds",
    "msds",
    "sds",
  ].map(normalizeText);

  return {
    ftMatcher: (value: string) => ftNeedles.some((needle) => value.includes(needle)),
    fdsMatcher: (value: string) => fdsNeedles.some((needle) => value.includes(needle)),
  };
}

function findPdfLinkByLabel(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  matcher: (value: string) => boolean,
): string | null {
  let found: string | null = null;
  $("a").each((_, el) => {
    if (found) return;
    const text = normalizeText($(el).text());
    const href = $(el).attr("href");
    if (!href) return;
    const absolute = makeAbsoluteUrl(href, pageUrl);
    if (!absolute || !/\.pdf(\?|#|$)/i.test(absolute)) return;
    if (matcher(text)) found = absolute;
  });
  return found;
}

function classifyPdfUrl(url: string): "ft" | "fds" | "unknown" {
  const path = url.split("?")[0]!.toUpperCase();
  if (/\/T_(FR|NL|PL)_/.test(path) || /\/PDF\/TECH\/T_/.test(path)) return "ft";
  if (/\/S_(FR|NL|PL)_/.test(path) || /\/PDF\/TECH\/S_/.test(path)) return "fds";
  if (/FDS|MSDS|SDS|SAFETY/.test(path)) return "fds";
  if (/FICHE.?TECH|TECHNICAL|TDS|_FT_/.test(path)) return "ft";
  return "unknown";
}

function collectPdfUrlsOnPage($: cheerio.CheerioAPI, pageUrl: string): string[] {
  const out: string[] = [];
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const absolute = makeAbsoluteUrl(href, pageUrl);
    if (!absolute || !/\.pdf(\?|#|$)/i.test(absolute)) return;
    out.push(absolute);
  });
  return out;
}

function pickFtFdsFromUrls(urls: string[]): { ft: string | null; fds: string | null } {
  let ft: string | null = null;
  let fds: string | null = null;
  for (const url of urls) {
    const kind = classifyPdfUrl(url);
    if (kind === "ft" && !ft) ft = url;
    if (kind === "fds" && !fds) fds = url;
  }
  return { ft, fds };
}

async function resolveLocalizedPdfUrl(
  url: string,
  locale: string,
  logger: ScrapeLogger = console,
): Promise<string | null> {
  const localized = replaceLanguageTokenInUrl(url, locale);
  const encoded = safeEncodeUrl(localized);
  if (!encoded) return null;
  const exists = await urlExistsByHead(encoded, logger);
  return exists ? encoded : null;
}

function normalizeTitleForPdfUrl(title: string): string {
  return String(title || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/°/g, "")
    .replace(/&#0?38;/g, "")
    .replace(/&amp;/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

const PDF_SUFFIX_VARIANTS = ["_BRILLANT", "_MAT", "_PRO", "_PLUS", "_SPRAY", "_2", "_KIT"] as const;

/** GEB PDFs often use JOINT_ET_FIX while WP titles read "JOINT & FIX". */
function expandPdfNameBases(bases: string[]): string[] {
  const out = new Set(bases.filter(Boolean));
  for (const base of bases) {
    if (/^JOINT_FIX_/i.test(base)) out.add(base.replace(/^JOINT_FIX_/i, "JOINT_ET_FIX_"));
    if (/^JOINT_[A-Z]/i.test(base) && !/_ET_FIX_/i.test(base)) {
      out.add(base.replace(/^JOINT_/i, "JOINT_ET_FIX_"));
    }
  }
  return [...out];
}

function suffixHintsFromSlug(slug: string): string[] {
  const hints: string[] = [];
  if (/brillant/i.test(slug)) hints.push("_BRILLANT");
  if (/(?:^|-)mat(?:-|$)/i.test(slug)) hints.push("_MAT");
  if (/\bpro\b/i.test(slug)) hints.push("_PRO");
  if (/spray/i.test(slug)) hints.push("_SPRAY");
  if (/kit/i.test(slug)) hints.push("_KIT");
  return hints;
}

function buildPdfCandidates(
  base: string,
  locale: string,
  kind: "T" | "S",
  slug: string,
): string[] {
  const token = getLanguageToken(locale);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (suffix: string) => {
    const url = `https://www.geb.fr/pdf/tech/${kind}_${token}_${base}${suffix}.pdf`;
    if (!seen.has(url)) {
      seen.add(url);
      ordered.push(url);
    }
  };

  for (const suffix of suffixHintsFromSlug(slug)) add(suffix);
  add("");
  for (const suffix of PDF_SUFFIX_VARIANTS) add(suffix);
  return ordered;
}

async function guessPdfUrlByTitle(
  title: string,
  locale: string,
  slug: string,
  logger: ScrapeLogger = console,
): Promise<{ ft_url: string | null; fds_url: string | null }> {
  const normalized = normalizeTitleForPdfUrl(title);
  if (!normalized) return { ft_url: null, fds_url: null };

  const slugNorm = normalizeTitleForPdfUrl(slug.replace(/-/g, " "));
  const bases = expandPdfNameBases([normalized, ...(slugNorm && slugNorm !== normalized ? [slugNorm] : [])]);

  let ft_url: string | null = null;
  let fds_url: string | null = null;

  for (const base of bases) {
    if (ft_url) break;
    for (const candidate of buildPdfCandidates(base, locale, "T", slug)) {
      if (await urlExistsByHead(candidate, logger)) {
        ft_url = candidate;
        logger.info?.("[scraper] PDF URL guessed from title pattern", { title, slug, ft_url });
        break;
      }
    }
  }

  for (const base of bases) {
    if (fds_url) break;
    for (const candidate of buildPdfCandidates(base, locale, "S", slug)) {
      if (await urlExistsByHead(candidate, logger)) {
        fds_url = candidate;
        break;
      }
    }
  }

  return { ft_url, fds_url };
}

function getProductTitle(product: Record<string, unknown>): string {
  if (product.title && typeof product.title === "object") {
    return String((product.title as { rendered?: string }).rendered ?? "");
  }
  return typeof product.title === "string" ? product.title : "";
}

async function resolveValidFtUrl(
  current: string | null,
  title: string,
  locale: string,
  slug: string,
  logger: ScrapeLogger,
): Promise<string | null> {
  const encoded = current ? safeEncodeUrl(current) : null;
  if (encoded && classifyPdfUrl(encoded) === "ft" && (await urlExistsByHead(encoded, logger))) {
    return encoded;
  }
  const guessed = await guessPdfUrlByTitle(title, locale, slug, logger);
  return guessed.ft_url;
}

async function resolveValidFdsUrl(
  current: string | null,
  title: string,
  locale: string,
  slug: string,
  logger: ScrapeLogger,
): Promise<string | null> {
  const encoded = current ? safeEncodeUrl(current) : null;
  if (encoded && classifyPdfUrl(encoded) === "fds" && (await urlExistsByHead(encoded, logger))) {
    return encoded;
  }
  const guessed = await guessPdfUrlByTitle(title, locale, slug, logger);
  return guessed.fds_url ?? (encoded && classifyPdfUrl(encoded) === "fds" ? encoded : null);
}

async function scrapeProductPage(
  product: Record<string, unknown>,
  locale: string,
  logger: ScrapeLogger = console,
): Promise<{ ft_url: string | null; fds_url: string | null }> {
  const productLink = typeof product.link === "string" ? product.link : null;
  if (!productLink) return { ft_url: null, fds_url: null };

  try {
    const response = await axios.get(productLink, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      timeout: HTTP_TIMEOUT_MS,
      maxRedirects: 5,
    });
    const $ = cheerio.load(response.data);
    const { ftMatcher, fdsMatcher } = buildLabelMatchers();

    let ftRaw = findPdfLinkByLabel($, productLink, ftMatcher);
    let fdsRaw = findPdfLinkByLabel($, productLink, fdsMatcher);
    const fromUrls = pickFtFdsFromUrls(collectPdfUrlsOnPage($, productLink));
    if (!ftRaw && fromUrls.ft) ftRaw = fromUrls.ft;
    if (!fdsRaw && fromUrls.fds) fdsRaw = fromUrls.fds;
    if (ftRaw && classifyPdfUrl(ftRaw) === "fds") ftRaw = fromUrls.ft;
    if (fdsRaw && classifyPdfUrl(fdsRaw) === "ft") fdsRaw = fromUrls.fds;

    let ft_url = safeEncodeUrl(ftRaw);
    let fds_url = safeEncodeUrl(fdsRaw);

    if (locale !== "fr") {
      if (ft_url) ft_url = (await resolveLocalizedPdfUrl(ft_url, locale, logger)) || ft_url;
      if (fds_url) fds_url = (await resolveLocalizedPdfUrl(fds_url, locale, logger)) || fds_url;
      if (!ft_url && ftRaw && /_FR_/i.test(ftRaw)) {
        ft_url = await resolveLocalizedPdfUrl(ftRaw, locale, logger);
      }
      if (!fds_url && fdsRaw && /_FR_/i.test(fdsRaw)) {
        fds_url = await resolveLocalizedPdfUrl(fdsRaw, locale, logger);
      }
    }

    const title = getProductTitle(product);
    const productSlug = typeof product.slug === "string" ? product.slug : "";
    ft_url = await resolveValidFtUrl(ft_url, title, locale, productSlug, logger);
    fds_url = await resolveValidFdsUrl(fds_url, title, locale, productSlug, logger);

    return { ft_url, fds_url };
  } catch (error) {
    logger.warn?.("[scraper] Product page fetch failed", {
      locale,
      link: productLink,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ft_url: null, fds_url: null };
  }
}

async function fetchWpProductsPage(
  endpoint: string,
  page: number,
  logger: ScrapeLogger,
): Promise<{ items: Record<string, unknown>[]; totalPages: number | null; totalItems: number | null }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= WP_API_MAX_RETRIES; attempt += 1) {
    try {
      const response = await axios.get(endpoint, {
        params: { per_page: PER_PAGE, page, _embed: "wp:term" },
        headers: { Accept: "application/json", ...getAuthHeader() },
        timeout: WP_API_TIMEOUT_MS,
      });
      const items = Array.isArray(response.data) ? (response.data as Record<string, unknown>[]) : [];
      const totalPagesRaw = response.headers["x-wp-totalpages"];
      const totalItemsRaw = response.headers["x-wp-total"];
      const totalPages = totalPagesRaw ? Number(totalPagesRaw) : null;
      const totalItems = totalItemsRaw ? Number(totalItemsRaw) : null;
      return {
        items,
        totalPages: Number.isFinite(totalPages) && totalPages! > 0 ? totalPages : null,
        totalItems: Number.isFinite(totalItems) && totalItems! > 0 ? totalItems : null,
      };
    } catch (error) {
      lastError = error;
      logger.warn?.("[scraper] WP products page fetch retry", {
        page,
        attempt,
        maxRetries: WP_API_MAX_RETRIES,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt < WP_API_MAX_RETRIES) await sleep(WP_API_PAGE_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

async function fetchAllWpProductsForLocale(
  locale: (typeof LOCALES)[number],
  logger: ScrapeLogger = console,
): Promise<Record<string, unknown>[]> {
  const endpoint = WP_PRODUCT_API_BY_LOCALE[locale];
  const out: Record<string, unknown>[] = [];
  let page = 1;
  let totalPagesFromHeader: number | null = null;
  let totalItemsFromHeader: number | null = null;

  while (true) {
    logger.info?.(`[scraper] Fetching [${locale.toUpperCase()}] page ${page}...`);
    const { items, totalPages, totalItems } = await fetchWpProductsPage(endpoint, page, logger);
    if (totalPages != null) totalPagesFromHeader = totalPages;
    if (totalItems != null) totalItemsFromHeader = totalItems;

    if (items.length === 0) break;
    out.push(...items);

    if (totalPagesFromHeader && page >= totalPagesFromHeader) break;
    if (items.length < PER_PAGE) break;
    page += 1;
    await sleep(WP_API_PAGE_DELAY_MS);
  }

  if (totalItemsFromHeader != null && out.length < totalItemsFromHeader) {
    logger.error?.("[scraper] Incomplete WP product fetch", {
      locale,
      fetched: out.length,
      expected: totalItemsFromHeader,
      pagesFetched: page,
      totalPages: totalPagesFromHeader,
    });
  }

  logger.info?.(`[scraper] [${locale.toUpperCase()}] fetched ${out.length} products.`, {
    expected: totalItemsFromHeader,
    pages: page,
  });
  return out;
}

/** Scrape GEB products: PDF URLs + official WP product_cat gamme. */
export async function scrapeGebProductPdfs(
  logger: ScrapeLogger = console,
  locales: readonly ScrapeLocale[] = LOCALES,
  slugFilter: string | null = null,
): Promise<ScrapedProductRow[]> {
  const results: ScrapedProductRow[] = [];
  const frBySlug = new Map<string, { ft_url: string | null; fds_url: string | null; catalog: ReturnType<typeof parseWpCatalogFromProduct> }>();

  for (const locale of locales) {
    let products = await fetchAllWpProductsForLocale(locale, logger);
    if (slugFilter) {
      products = products.filter((product) => product.slug === slugFilter);
      if (products.length === 0) {
        logger.warn?.(`[scraper] No product for slug=${slugFilter} [${locale}]`);
        continue;
      }
    }

    for (let i = 0; i < products.length; i += 1) {
      const product = products[i]!;
      const wp_id = Number(product.id);
      const slug = typeof product.slug === "string" ? product.slug : "";
      const title = getProductTitle(product);
      const catalog = parseWpCatalogFromProduct(product);

      logger.info?.(`[scraper] Processing [${locale.toUpperCase()}] - Product ${i + 1}/${products.length}...`);

      const { ft_url, fds_url } = await scrapeProductPage(product, locale, logger);

      const row: ScrapedProductRow = {
        wp_id,
        slug,
        language: locale,
        title,
        ft_url,
        fds_url,
        gamme_officielle: catalog.gamme_officielle,
        wp_product_cat_slugs: catalog.wp_product_cat_slugs,
        wp_product_cat_names: catalog.wp_product_cat_names,
      };
      results.push(row);

      if (locale === "fr" && slug) {
        frBySlug.set(slug, { ft_url, fds_url, catalog });
      }

      if (i < products.length - 1) await sleep(PRODUCT_REQUEST_DELAY_MS);
    }
  }

  for (const row of results) {
    if (row.language === "fr") continue;
    const fr = frBySlug.get(row.slug);
    if (!fr) continue;

    if (!row.ft_url && fr.ft_url && /_FR_/i.test(fr.ft_url)) {
      row.ft_url = await resolveLocalizedPdfUrl(fr.ft_url, row.language, logger);
    }
    if (!row.fds_url && fr.fds_url && /_FR_/i.test(fr.fds_url)) {
      row.fds_url = await resolveLocalizedPdfUrl(fr.fds_url, row.language, logger);
    }
    if (!row.gamme_officielle && fr.catalog.gamme_officielle) {
      row.gamme_officielle = fr.catalog.gamme_officielle;
    }
    if ((!row.wp_product_cat_slugs || row.wp_product_cat_slugs.length === 0) && fr.catalog.wp_product_cat_slugs.length > 0) {
      row.wp_product_cat_slugs = fr.catalog.wp_product_cat_slugs;
      row.wp_product_cat_names = fr.catalog.wp_product_cat_names;
    }
  }

  logger.info?.("[scraper] Completed scraping all locales", { count: results.length });
  return results;
}
