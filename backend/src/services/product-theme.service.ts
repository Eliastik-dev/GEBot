import type { Audience, ProductTheme } from "../types/index.js";

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

/** Pro: hide DIY-only rows. Particulier: hide pro-only rows (GEBSOPLAST…). "all" stays visible for both. */
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
