import axios from "axios";
import * as cheerio from "cheerio";

const LOCALES = ["fr", "nl", "pl"];
const WP_PRODUCT_API_BY_LOCALE = {
  fr: "https://www.geb.fr/wp-json/wp/v2/product",
  nl: "https://www.geb.fr/nl/wp-json/wp/v2/product",
  pl: "https://www.geb.fr/pl/wp-json/wp/v2/product",
};
const PER_PAGE = 100;
const PRODUCT_REQUEST_DELAY_MS = 500;
const HTTP_TIMEOUT_MS = 15000;

function getAuthHeader() {
  const user = process.env.WP_USER;
  const appPassword = process.env.WP_APP_PASSWORD;
  if (!user || !appPassword) return {};
  const token = Buffer.from(`${user}:${appPassword}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getLanguageToken(locale) {
  if (locale === "nl") return "NL";
  if (locale === "pl") return "PL";
  return "FR";
}

function makeAbsoluteUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function safeEncodeUrl(url) {
  if (!url) return null;
  try {
    return encodeURI(url);
  } catch {
    return url;
  }
}

function replaceLanguageTokenInUrl(url, targetLocale) {
  if (!url) return null;
  const token = getLanguageToken(targetLocale);
  return url
    .replace(/_FR_/gi, `_${token}_`)
    .replace(/_NL_/gi, `_${token}_`)
    .replace(/_PL_/gi, `_${token}_`);
}

async function urlExistsByHead(url, logger = console) {
  if (!url) return false;
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
      error: error && error.message ? error.message : String(error),
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
    ftMatcher: (value) => ftNeedles.some((needle) => value.includes(needle)),
    fdsMatcher: (value) => fdsNeedles.some((needle) => value.includes(needle)),
  };
}

function findPdfLinkByLabel($, pageUrl, matcher) {
  let found = null;
  $("a").each((_, el) => {
    if (found) return;
    const text = normalizeText($(el).text());
    const href = $(el).attr("href");
    if (!href) return;

    const absolute = makeAbsoluteUrl(href, pageUrl);
    if (!absolute) return;
    const isPdf = /\.pdf(\?|#|$)/i.test(absolute);
    if (!isPdf) return;

    if (matcher(text)) {
      found = absolute;
    }
  });
  return found;
}

function findAnyFrenchPdfCandidates($, pageUrl) {
  const out = [];
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const absolute = makeAbsoluteUrl(href, pageUrl);
    if (!absolute) return;
    if (!/\.pdf(\?|#|$)/i.test(absolute)) return;
    if (/_FR_/i.test(absolute)) {
      out.push(absolute);
    }
  });
  return out;
}

async function resolveLocalizedPdfUrl(url, locale, logger = console) {
  if (!url) return null;
  const localized = replaceLanguageTokenInUrl(url, locale);
  const encoded = safeEncodeUrl(localized);
  const exists = await urlExistsByHead(encoded, logger);
  if (exists) return encoded;
  return null;
}

function normalizeTitleForPdfUrl(title) {
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

async function guessPdfUrlByTitle(title, locale, logger = console) {
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

async function scrapeProductPage(product, locale, logger = console) {
  const productLink = typeof product.link === "string" ? product.link : null;
  if (!productLink) {
    return { ft_url: null, fds_url: null };
  }

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

    if (!ftRaw && guessedFrenchCandidates.length > 0) {
      ftRaw = guessedFrenchCandidates[0];
    }
    if (!fdsRaw && guessedFrenchCandidates.length > 1) {
      fdsRaw = guessedFrenchCandidates[1];
    }

    let ft_url = safeEncodeUrl(ftRaw);
    let fds_url = safeEncodeUrl(fdsRaw);

    if (locale !== "fr") {
      if (ft_url) {
        const resolved = await resolveLocalizedPdfUrl(ft_url, locale, logger);
        ft_url = resolved || ft_url;
      }
      if (fds_url) {
        const resolved = await resolveLocalizedPdfUrl(fds_url, locale, logger);
        fds_url = resolved || fds_url;
      }

      // If missing in locale pages, try guessing from French tokenized URL.
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
          ? product.title.rendered || ""
          : typeof product.title === "string"
            ? product.title
            : "";
      const guessed = await guessPdfUrlByTitle(title, locale, logger);
      if (guessed.ft_url) {
        logger.info?.("[scraper] PDF URL guessed from title pattern", { title, ft_url: guessed.ft_url });
        ft_url = guessed.ft_url;
      }
      if (guessed.fds_url) {
        fds_url = guessed.fds_url;
      }
    }

    return { ft_url, fds_url };
  } catch (error) {
    logger.warn?.("[scraper] Product page fetch failed", {
      locale,
      link: productLink,
      error: error && error.message ? error.message : String(error),
    });
    return { ft_url: null, fds_url: null };
  }
}

async function fetchAllWpProductsForLocale(locale, logger = console) {
  const endpoint = WP_PRODUCT_API_BY_LOCALE[locale];
  const out = [];
  let page = 1;
  let totalPagesFromHeader = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    logger.info?.(`[scraper] Fetching [${locale.toUpperCase()}] page ${page}...`);
    try {
      const response = await axios.get(endpoint, {
        params: {
          per_page: PER_PAGE,
          page,
        },
        headers: {
          Accept: "application/json",
          ...getAuthHeader(),
        },
        timeout: HTTP_TIMEOUT_MS,
      });

      const items = Array.isArray(response.data) ? response.data : [];
      if (items.length === 0) {
        logger.info?.(`[scraper] [${locale.toUpperCase()}] no more products at page ${page}.`);
        break;
      }

      out.push(...items);

      const header = response.headers["x-wp-totalpages"];
      if (header && totalPagesFromHeader == null) {
        const parsed = Number(header);
        if (Number.isFinite(parsed) && parsed > 0) {
          totalPagesFromHeader = parsed;
          logger.info?.(
            `[scraper] [${locale.toUpperCase()}] total pages detected: ${totalPagesFromHeader}`,
          );
        }
      }

      if (totalPagesFromHeader && page >= totalPagesFromHeader) {
        break;
      }

      if (items.length < PER_PAGE) {
        logger.info?.("[scraper] Last partial page detected, stopping", {
          page,
          count: items.length,
        });
        break;
      }

      page += 1;
    } catch (error) {
      logger.error?.("[scraper] Failed to fetch WP products page", {
        locale,
        page,
        error: error && error.message ? error.message : String(error),
      });
      break;
    }
  }

  logger.info?.(`[scraper] [${locale.toUpperCase()}] fetched ${out.length} products.`);
  return out;
}

export async function scrapeGebProductPdfs(logger = console) {
  const results = [];
  const frBySlug = new Map();

  for (const locale of LOCALES) {
    const products = await fetchAllWpProductsForLocale(locale, logger);

    for (let i = 0; i < products.length; i += 1) {
      const product = products[i];
      const wp_id = Number(product.id);
      const slug = typeof product.slug === "string" ? product.slug : "";
      const title =
        product.title && typeof product.title === "object"
          ? product.title.rendered || ""
          : typeof product.title === "string"
            ? product.title
            : "";

      logger.info?.(
        `[scraper] Processing [${locale.toUpperCase()}] - Product ${i + 1}/${products.length}...`,
      );

      const { ft_url, fds_url } = await scrapeProductPage(product, locale, logger);

      const row = {
        wp_id,
        slug,
        language: locale,
        title,
        ft_url,
        fds_url,
      };
      results.push(row);
      if (locale === "fr" && slug) {
        frBySlug.set(slug, { ft_url, fds_url });
      }

      if (i < products.length - 1) {
        await sleep(PRODUCT_REQUEST_DELAY_MS);
      }
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
  }

  logger.info?.("[scraper] Completed scraping all locales", { count: results.length });
  return results;
}

