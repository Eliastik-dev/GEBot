import { VALID_THEMES } from "../config/constants.js";
import type { Audience, Locale, ProductTheme } from "../types/index.js";

export function normalizeStoredProductTheme(theme: ProductTheme | string | null | undefined): ProductTheme | null {
  if (!theme) return null;
  return VALID_THEMES.includes(theme as ProductTheme) ? (theme as ProductTheme) : null;
}

export type ScrapedProductRow = {
  wp_id: number;
  slug: string;
  language: "fr" | "nl" | "pl";
  title: string;
  ft_url: string | null;
  fds_url: string | null;
  /** WP product_cat breadcrumb (official gamme). */
  gamme_officielle?: string | null;
  wp_product_cat_slugs?: string[];
  wp_product_cat_names?: string[];
};

export const THEME_KEYWORDS: Record<ProductTheme, string[]> = {
  plomberie: [
    "fuite", "joint", "raccord", "tuyau", "siphon", "evier", "robinet",
    "sanitaire", "evacuation", "ptfe", "filasse", "plomberie", "vidage",
    "filete", "filetage", "colmat", "etancheite filetage", "manchon",
    "vanne", "mitigeur", "canalisation", "cuivre", "pvc", "per",
  ],
  piscine: [
    "piscine", "pool", "bassin", "liner", "filtration", "chlore",
    "spa", "skimmer", "buse", "refoulement",
  ],
  chauffage: [
    "chauffage", "chaudiere", "radiateur", "fioul", "poele", "cheminee",
    "refractaire", "fumisterie", "desembouant", "inhibiteur", "caloporteur",
    "combustion", "conduit", "tubage", "insert", "foyer", "buche",
    "ramonage", "boue", "neutralisant", "g3", "g70", "g110",
    "tresse", "collafeu", "cordon", "vitre", "ciment refractaire",
    "mastic refractaire", "colle refractaire", "joint refractaire",
    "porte insert", "fibre ceramique", "fibre verre", "haute temperature",
    "feu", "flamme", "900", "1100", "resistant chaleur",
  ],
  batiment: [
    "facade", "toiture", "mur", "beton", "terrasse", "carrelage",
    "bardage", "gouttiere", "couverture", "zinguerie", "charpente",
    "etancheite toiture", "bitume", "membrane",
  ],
  maintenance: [
    "entretien", "nettoyant", "decapant", "degraissant", "lubrifiant",
    "graisse", "degrippant", "deboucheur", "detartrant", "solvant",
    "maintenance", "protection",
  ],
  automobile: [
    "auto", "vehicule", "moteur", "echappement", "pot echappement",
    "radiateur auto", "carter", "automobile", "moto", "diesel",
  ],
  "eco-conception": [
    "bio", "ecologique", "eco", "recyclable", "biosource",
    "environnement", "vert", "durable", "green",
  ],
};

export function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function classifyProductTheme(title: string, content: string): ProductTheme {
  const text = `${title} ${content}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const scores: Record<ProductTheme, number> = {
    plomberie: 0,
    piscine: 0,
    chauffage: 0,
    batiment: 0,
    maintenance: 0,
    automobile: 0,
    "eco-conception": 0,
  };

  for (const [theme, keywords] of Object.entries(THEME_KEYWORDS) as Array<[ProductTheme, string[]]>) {
    for (const kw of keywords) {
      const normalized = kw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (text.includes(normalized)) {
        scores[theme] += 1;
      }
    }
  }

  let best: ProductTheme = "plomberie";
  let bestScore = 0;
  for (const [theme, score] of Object.entries(scores) as Array<[ProductTheme, number]>) {
    if (score > bestScore) {
      bestScore = score;
      best = theme;
    }
  }
  // Tie-break: prefer domain-specific themes over generic plomberie when scores are equal.
  if (bestScore > 0) {
    const tied = (Object.entries(scores) as Array<[ProductTheme, number]>)
      .filter(([, s]) => s === bestScore)
      .map(([t]) => t);
    const priority: ProductTheme[] = [
      "automobile",
      "piscine",
      "chauffage",
      "batiment",
      "maintenance",
      "eco-conception",
      "plomberie",
    ];
    for (const p of priority) {
      if (tied.includes(p)) return p;
    }
  }
  return best;
}

/** Controlled vocabulary for use_case_tags — used in synthesis prompt and SQL filters. */
export const USE_CASE_TAG_VOCABULARY = [
  "echappement",
  "montage_auto",
  "reparation_auto",
  "eau_potable",
  "eau_usee",
  "evacuation",
  "gaz",
  "chauffage",
  "piscine",
  "facade",
  "toiture",
  "carrelage",
  "plomberie_raccord",
  "etancheite_filetage",
  "reparation_fuite",
  "silicone_sanitaire",
  "lubrification",
  "debouchage",
  "desembouage",
  "haute_temperature",
  "cheminee",
  "maintenance",
] as const;

export type UseCaseTag = (typeof USE_CASE_TAG_VOCABULARY)[number];

/** Stored or inferred catalogue line: pro (GEBSOPLAST…) vs DIY (POOL*, certaines colles grand public). */
export type CatalogAudience = "professional" | "particulier" | "all";

/**
 * Infer who a product row is primarily aimed at. When `storedAudience` in DB is already set, it wins.
 */
export function inferCatalogProductAudience(
  canonicalName: string,
  slug: string,
  storedAudience: string,
): CatalogAudience {
  if (storedAudience === "professional" || storedAudience === "particulier") {
    return storedAudience;
  }
  const marker = `${canonicalName} ${slug}`
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (/GEBSOPLAST|GEB.?ORIZON.*GEBSOPLAST/.test(marker) || slug.toLowerCase().includes("gebsoplast")) {
    return "professional";
  }

  if (
    slug.includes("colle-haute-performance") ||
    slug.startsWith("pool-") ||
    /^POOL[\s*]/i.test(canonicalName)
  ) {
    return "particulier";
  }

  if (/(PRO|PROFESSIONNEL|CHANTIER|B2B)/.test(marker)) return "professional";
  if (/(PARTICULIER|CONSO|DIY|B2C)/.test(marker)) return "particulier";

  return "all";
}

/** Whether a product ligne matches the session profile (used for ranking + disclaimer hints, not hard exclusion). */
export function catalogAudienceVisibleForSession(
  sessionAudience: Audience,
  canonicalName: string,
  slug: string,
  storedAudience: string,
): boolean {
  const eff = inferCatalogProductAudience(canonicalName, slug, storedAudience);
  if (eff === "all") return true;
  if (sessionAudience === "professional") return eff !== "particulier";
  if (sessionAudience === "particulier") return eff !== "professional";
  return true;
}

export function hasCatalogAudienceMismatch(
  sessionAudience: Audience | null | undefined,
  canonicalName: string,
  slug: string,
  storedAudience: string,
): boolean {
  if (!sessionAudience) return false;
  return !catalogAudienceVisibleForSession(sessionAudience, canonicalName, slug, storedAudience);
}

export function hasThemeMismatch(
  sessionTheme: ProductTheme | null | undefined,
  productTheme: ProductTheme | null | undefined,
): boolean {
  return Boolean(sessionTheme && productTheme && sessionTheme !== productTheme);
}

const PRODUCT_THEME_LABELS: Record<Locale, Record<ProductTheme, string>> = {
  fr: {
    plomberie: "Plomberie / Sanitaire",
    piscine: "Piscine",
    chauffage: "Chauffage / Feu",
    batiment: "Bâtiment",
    maintenance: "Maintenance",
    automobile: "Automobile",
    "eco-conception": "Éco-conception",
  },
  en: {
    plomberie: "Plumbing / Sanitary",
    piscine: "Pool",
    chauffage: "Heating / Fire",
    batiment: "Building",
    maintenance: "Maintenance",
    automobile: "Automotive",
    "eco-conception": "Eco-design",
  },
  nl: {
    plomberie: "Loodgieterij / Sanitair",
    piscine: "Zwembad",
    chauffage: "Verwarming / Vuur",
    batiment: "Bouw",
    maintenance: "Onderhoud",
    automobile: "Auto",
    "eco-conception": "Eco-design",
  },
  pl: {
    plomberie: "Hydraulika / Sanitarne",
    piscine: "Basen",
    chauffage: "Ogrzewanie / Ogień",
    batiment: "Budownictwo",
    maintenance: "Konserwacja",
    automobile: "Motoryzacja",
    "eco-conception": "Eko-projektowanie",
  },
};

export function productThemeLabel(theme: ProductTheme, locale: Locale): string {
  return PRODUCT_THEME_LABELS[locale]?.[theme] ?? PRODUCT_THEME_LABELS.fr[theme];
}

export function catalogAudienceLabel(line: CatalogAudience, locale: Locale): string {
  if (line === "professional") {
    return locale === "en" ? "professional" : locale === "nl" ? "professional" : locale === "pl" ? "profesjonalny" : "professionnel";
  }
  if (line === "particulier") {
    return locale === "en" ? "consumer / DIY" : locale === "nl" ? "particulier" : locale === "pl" ? "konsumencki" : "particulier";
  }
  return locale === "en" ? "all profiles" : locale === "nl" ? "alle profielen" : locale === "pl" ? "wszystkie profile" : "tous profils";
}

export function sessionAudienceLabel(audience: Audience, locale: Locale): string {
  if (audience === "professional") {
    return locale === "en" ? "professional" : locale === "nl" ? "professional" : locale === "pl" ? "profesjonalista" : "professionnel";
  }
  return locale === "en" ? "consumer" : locale === "nl" ? "particulier" : locale === "pl" ? "konsument" : "particulier";
}

/** LLM-facing hints when a product is outside the session catalogue line or domain. */
export function buildCatalogMismatchHints(input: {
  sessionAudience?: Audience | null | undefined;
  sessionTheme?: ProductTheme | null | undefined;
  product: { canonical_name: string; slug: string; audience?: string | null; theme?: ProductTheme | null };
  locale?: Locale | undefined;
}): string[] {
  const locale = input.locale ?? "fr";
  const hints: string[] = [];
  const line = inferCatalogProductAudience(
    input.product.canonical_name,
    input.product.slug,
    input.product.audience ?? "all",
  );

  if (input.sessionAudience && hasCatalogAudienceMismatch(input.sessionAudience, input.product.canonical_name, input.product.slug, input.product.audience ?? "all")) {
    if (locale === "en") {
      hints.push(
        `Catalogue alert: product line is **${catalogAudienceLabel(line, locale)}** while the user session is **${sessionAudienceLabel(input.sessionAudience, locale)}** — if you recommend it, state clearly that it belongs to the other catalogue line.`,
      );
    } else if (locale === "nl") {
      hints.push(
        `Cataloguswaarschuwing: productlijn **${catalogAudienceLabel(line, locale)}**, sessie **${sessionAudienceLabel(input.sessionAudience, locale)}** — vermeld expliciet de andere cataloguslijn bij aanbeveling.`,
      );
    } else if (locale === "pl") {
      hints.push(
        `Alert katalogowy: linia produktu **${catalogAudienceLabel(line, locale)}**, sesja **${sessionAudienceLabel(input.sessionAudience, locale)}** — przy rekomendacji wskaż inną linię katalogową.`,
      );
    } else {
      hints.push(
        `Alerte catalogue : ligne produit **${catalogAudienceLabel(line, locale)}** alors que la session est **${sessionAudienceLabel(input.sessionAudience, locale)}** — si vous le recommandez, précisez clairement qu'il relève de l'autre ligne catalogue.`,
      );
    }
  }

  if (hasThemeMismatch(input.sessionTheme, input.product.theme ?? null)) {
    const productDomain = productThemeLabel(input.product.theme!, locale);
    const sessionDomain = productThemeLabel(input.sessionTheme!, locale);
    if (locale === "en") {
      hints.push(
        `Domain alert: product domain is **${productDomain}** while the user selected **${sessionDomain}** — if you recommend it, name the correct domain explicitly.`,
      );
    } else if (locale === "nl") {
      hints.push(
        `Domeinwaarschuwing: productdomein **${productDomain}**, gekozen domein **${sessionDomain}** — noem het juiste domein bij aanbeveling.`,
      );
    } else if (locale === "pl") {
      hints.push(
        `Alert domeny: domena produktu **${productDomain}**, wybrana domena **${sessionDomain}** — wskaż właściwą domenę przy rekomendacji.`,
      );
    } else {
      hints.push(
        `Alerte domaine : domaine produit **${productDomain}** alors que l'utilisateur a choisi **${sessionDomain}** — si vous le recommandez, indiquez explicitement le bon domaine.`,
      );
    }
  }

  return hints;
}

/** Short disclaimer for deterministic MODE 2 replies (direct sheet / cited product). */
export function formatUserFacingMismatchNote(input: {
  sessionAudience?: Audience | null | undefined;
  sessionTheme?: ProductTheme | null | undefined;
  product: { canonical_name: string; slug: string; audience?: string | null; theme?: ProductTheme | null };
  locale: Locale;
}): string {
  const locale = input.locale;
  const line = inferCatalogProductAudience(
    input.product.canonical_name,
    input.product.slug,
    input.product.audience ?? "all",
  );
  const parts: string[] = [];

  if (input.sessionAudience && hasCatalogAudienceMismatch(input.sessionAudience, input.product.canonical_name, input.product.slug, input.product.audience ?? "all")) {
    if (locale === "en") {
      parts.push(
        `Note: this product is from the **${catalogAudienceLabel(line, locale)}** catalogue line, while your session profile is **${sessionAudienceLabel(input.sessionAudience, locale)}**.`,
      );
    } else if (locale === "nl") {
      parts.push(
        `Let op: dit product hoort bij de cataloguslijn **${catalogAudienceLabel(line, locale)}**, uw sessie is **${sessionAudienceLabel(input.sessionAudience, locale)}**.`,
      );
    } else if (locale === "pl") {
      parts.push(
        `Uwaga: produkt z linii **${catalogAudienceLabel(line, locale)}**, profil sesji: **${sessionAudienceLabel(input.sessionAudience, locale)}**.`,
      );
    } else {
      parts.push(
        `Note : ce produit relève du catalogue **${catalogAudienceLabel(line, locale)}**, alors que votre profil indiqué est **${sessionAudienceLabel(input.sessionAudience, locale)}**.`,
      );
    }
  }

  if (hasThemeMismatch(input.sessionTheme, input.product.theme ?? null)) {
    const productDomain = productThemeLabel(input.product.theme!, locale);
    const sessionDomain = productThemeLabel(input.sessionTheme!, locale);
    if (locale === "en") {
      parts.push(`Note: product domain is **${productDomain}**, not **${sessionDomain}** which you selected.`);
    } else if (locale === "nl") {
      parts.push(`Let op: productdomein **${productDomain}**, niet het gekozen domein **${sessionDomain}**.`);
    } else if (locale === "pl") {
      parts.push(`Uwaga: domena produktu **${productDomain}**, nie wybrana **${sessionDomain}**.`);
    } else {
      parts.push(`Note : ce produit relève du domaine **${productDomain}**, et non du domaine **${sessionDomain}** que vous avez choisi.`);
    }
  }

  return parts.join(" ");
}
