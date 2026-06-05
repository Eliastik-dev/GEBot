import axios from "axios";
import * as cheerio from "cheerio";
import { parseWpCatalogFromProduct } from "./wp-catalog-theme.service.js";
import type { ScrapedProductRow } from "./product-theme.service.js";

const LOCALES = ["fr", "nl", "pl"] as const;
const WP_PRODUCT_API_BY_LOCALE: Record<(typeof LOCALES)[number], string> = {
  fr: "https://www.geb.fr/wp-json/wp/v2/product",
  nl: "https://www.geb.fr/nl/wp-json/wp/v2/product",
  pl: "https://www.geb.fr/pl/wp-json/wp/v2/product",
};
const PER_PAGE = 100;
const PRODUCT_REQUEST_DELAY_MS = 500;
const HTTP_TIMEOUT_MS = 15000;

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

function findAnyFrenchPdfCandidates($: cheerio.CheerioAPI, pageUrl: string): string[] {
  const out: string[] = [];
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const absolute = makeAbsoluteUrl(href, pageUrl);
    if (!absolute || !/\.pdf(\?|#|$)/i.test(absolute)) return;
    if (/_FR_/i.test(absolute)) out.push(absolute);
  });
  return out;
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

async function guessPdfUrlByTitle(
  title: string,
  locale: string,
  logger: ScrapeLogger = console,
): Promise<{ ft_url: string | null; fds_url: string | null }> {
  const token = getLanguageToken(locale);
  const normalized = normalizeTitleForPdfUrl(title);
  if (!normalized) return { ft_url: null, fds_url: null };

  const ftCandidate = `https://www.geb.fr/pdf/tech/T_${token}_${normalized}.pdf`;
  const fdsCandidate = `https://www.geb.fr/pdf/tech/S_${token}_${normalized}.pdf`;
  const [ftExists, fdsExists] = await Promise.all([
    urlExistsByHead(ftCandidate, logger),
    urlExistsByHead(fdsCandidate, logger),
  ]);
  return {
    ft_url: ftExists ? ftCandidate : null,
    fds_url: fdsExists ? fdsCandidate : null,
  };
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
    const guessedFrenchCandidates = findAnyFrenchPdfCandidates($, productLink);

    if (!ftRaw && guessedFrenchCandidates.length > 0) ftRaw = guessedFrenchCandidates[0] ?? null;
    if (!fdsRaw && guessedFrenchCandidates.length > 1) fdsRaw = guessedFrenchCandidates[1] ?? null;

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

    if (!ft_url && !fds_url) {
      const title =
        product.title && typeof product.title === "object"
          ? String((product.title as { rendered?: string }).rendered ?? "")
          : typeof product.title === "string"
            ? product.title
            : "";
      const guessed = await guessPdfUrlByTitle(title, locale, logger);
      if (guessed.ft_url) {
        logger.info?.("[scraper] PDF URL guessed from title pattern", { title, ft_url: guessed.ft_url });
        ft_url = guessed.ft_url;
      }
      if (guessed.fds_url) fds_url = guessed.fds_url;
    }

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

async function fetchAllWpProductsForLocale(
  locale: (typeof LOCALES)[number],
  logger: ScrapeLogger = console,
): Promise<Record<string, unknown>[]> {
  const endpoint = WP_PRODUCT_API_BY_LOCALE[locale];
  const out: Record<string, unknown>[] = [];
  let page = 1;
  let totalPagesFromHeader: number | null = null;

  while (true) {
    logger.info?.(`[scraper] Fetching [${locale.toUpperCase()}] page ${page}...`);
    try {
      const response = await axios.get(endpoint, {
        params: { per_page: PER_PAGE, page, _embed: "wp:term" },
        headers: { Accept: "application/json", ...getAuthHeader() },
        timeout: HTTP_TIMEOUT_MS,
      });

      const items = Array.isArray(response.data) ? (response.data as Record<string, unknown>[]) : [];
      if (items.length === 0) break;
      out.push(...items);

      const header = response.headers["x-wp-totalpages"];
      if (header && totalPagesFromHeader == null) {
        const parsed = Number(header);
        if (Number.isFinite(parsed) && parsed > 0) totalPagesFromHeader = parsed;
      }
      if (totalPagesFromHeader && page >= totalPagesFromHeader) break;
      if (items.length < PER_PAGE) break;
      page += 1;
    } catch (error) {
      logger.error?.("[scraper] Failed to fetch WP products page", {
        locale,
        page,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }

  logger.info?.(`[scraper] [${locale.toUpperCase()}] fetched ${out.length} products.`);
  return out;
}

function getProductTitle(product: Record<string, unknown>): string {
  if (product.title && typeof product.title === "object") {
    return String((product.title as { rendered?: string }).rendered ?? "");
  }
  return typeof product.title === "string" ? product.title : "";
}

/** Scrape GEB products: PDF URLs + official WP product_cat gamme. */
export async function scrapeGebProductPdfs(logger: ScrapeLogger = console): Promise<ScrapedProductRow[]> {
  const results: ScrapedProductRow[] = [];
  const frBySlug = new Map<string, { ft_url: string | null; fds_url: string | null; catalog: ReturnType<typeof parseWpCatalogFromProduct> }>();

  for (const locale of LOCALES) {
    const products = await fetchAllWpProductsForLocale(locale, logger);

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
