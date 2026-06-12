/**
 * Phase 2: Route chat queries to pre-synthesized product_knowledge rows.
 */

import {
  isAutomotiveExhaustContext,
} from "../dynamic-reranker.js";
import {
  isPersonalDrinkwareOutOfCatalog,
  isPiscineInaccessiblePipeLeak,
  isBuildingSurfaceSealingContext,
  isWoodStoveCosmeticCareContext,
} from "../utils/diagnostic-rules.js";
import type { ExtractedMetadata } from "../intent-extractor.js";
import type { Audience, Locale, ProductTheme } from "../types/index.js";
import type { ProductKnowledgeRow } from "../types/product-knowledge.js";
import {
  asksMetalThreadPasteJoint,
  asksThreadedMetalSealing,
  categoryToUseCaseTags,
  parseJointServiceFluid,
} from "../utils/joint-paste.js";
import { searchProductKnowledge } from "./product-knowledge.service.js";
import type { FeedbackSlugAdjustments } from "./feedback-retrieval.service.js";
import {
  buildCatalogMismatchHints,
  inferCatalogProductAudience,
  normalizeStoredProductTheme,
} from "./product-theme.service.js";

export type ProductRouterInput = {
  locale: string;
  query: string;
  searchQuery: string;
  /** Message utilisateur brut — citation produit explicite (fiche technique, référence…). */
  userQuery?: string;
  theme: ProductTheme | null;
  metadata: ExtractedMetadata;
  limit?: number;
  audience?: Audience | null;
  feedbackAdjustments?: FeedbackSlugAdjustments;
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Map user query + intent + theme to product_knowledge.use_case_tags filters. */
export function resolveUseCaseTags(input: ProductRouterInput): string[] {
  const combinedText = `${input.query} ${input.searchQuery}`;
  if (isPersonalDrinkwareOutOfCatalog(combinedText)) {
    return [];
  }

  const tags = new Set<string>();
  const q = normalizeText(combinedText);
  const { metadata, theme } = input;
  const pasteJoint = asksMetalThreadPasteJoint(combinedText);
  const threadedSealing = asksThreadedMetalSealing(combinedText);
  const parsedJointFluid = parseJointServiceFluid(combinedText);

  if (
    /\bcolmateur\b/.test(q) &&
    /\b(pool|piscine|fuite|fuit|fuites|lekdichter)\b/.test(q)
  ) {
    tags.add("piscine");
    tags.add("reparation_fuite");
    return [...tags];
  }

  if (/\b(kit\s+.*liner|liner.*kit|reparation\s+liner|kit\s+reparation\s+liner)\b/.test(q)) {
    tags.add("piscine");
    tags.add("reparation_fuite");
    return [...tags];
  }

  if (isWoodStoveCosmeticCareContext(combinedText)) {
    tags.add("cheminee");
    return [...tags];
  }

  if (
    metadata.intent === "inaccessible_leak" ||
    isPiscineInaccessiblePipeLeak(combinedText)
  ) {
    if (theme === "piscine" || /\bpiscine\b/.test(q)) {
      tags.add("piscine");
      tags.add("reparation_fuite");
      return [...tags];
    }
  }

  if ((pasteJoint || threadedSealing) && parsedJointFluid) {
    for (const tag of categoryToUseCaseTags(parsedJointFluid.category)) {
      tags.add(tag);
    }
    return [...tags];
  }

  if (isAutomotiveExhaustContext(input.query, input.searchQuery)) {
    tags.add("echappement");
    tags.add("montage_auto");
    tags.add("haute_temperature");
  }

  if (theme === "automobile") {
    tags.add("montage_auto");
    tags.add("reparation_auto");
  }
  if (theme === "piscine") tags.add("piscine");
  if (theme === "chauffage") {
    tags.add("chauffage");
    const heatingMaintenance =
      metadata.fluid === "chauffage" ||
      /\b(inhibiteur|desembou|embouage|g110|g10\b|g3\b|g70\b|neutralisant|plancher\s+chauffant|radiateur)\b/.test(q);
    if (heatingMaintenance) {
      tags.add("desembouage");
    } else {
      tags.add("haute_temperature");
    }
  }
  if (theme === "batiment") {
    tags.add("facade");
    tags.add("carrelage");
    if (/gouttiere|gouttieres|zinc|zinguerie|descente\s+pluviale|toiturol|ms[\s*-]?zinc/i.test(q)) {
      tags.add("toiture");
      tags.add("reparation_fuite");
    }
  }
  if (theme === "maintenance") tags.add("maintenance");

  if (metadata.intent === "sealing_assembly") {
    const buildingSurface =
      isBuildingSurfaceSealingContext(combinedText) ||
      (metadata.material != null &&
        /carrelage|terrasse|balcon|dalle|beton|pierre|facade|mur|brique/.test(metadata.material));
    if (buildingSurface) {
      tags.add("facade");
      tags.add("carrelage");
      if (/gouttiere|gouttieres|zinc|zinguerie|descente\s+pluviale|toiturol|ms[\s*-]?zinc/i.test(q)) {
        tags.add("toiture");
      }
    } else {
      tags.add("etancheite_filetage");
      tags.add("plomberie_raccord");
      if (/eau potable|potable|sanitaire/.test(q)) tags.add("eau_potable");
      if (/evacuation|egout|usee/.test(q)) tags.add("evacuation");
    }
  }
  const isDescaling = /\b(detartr|descal|calcaire|tartre|detartrans|g6[0-3])\b/.test(q);
  if (isDescaling) {
    tags.add("maintenance");
  }
  if (
    !isDescaling &&
    (metadata.intent === "leak_repair" ||
      metadata.intent === "pipe_repair" ||
      metadata.intent === "inaccessible_leak")
  ) {
    tags.add("reparation_fuite");
  }
  if (metadata.intent === "silicone_application") {
    tags.add("silicone_sanitaire");
  }
  if (/silicone|mastic\s+sanitaire|\bchrono\b|sechage|seche|secher/.test(q)) {
    tags.add("silicone_sanitaire");
  }
  if (metadata.intent === "installation_lubrication") {
    tags.add("lubrification");
  }

  if (
    metadata.intent === "product_info" &&
    /colle|coller|solvant|primaire|abs|\bpvc\b|pehd|multicouche|raccord|manchon|tuyau|canalisation/i.test(q)
  ) {
    tags.add("plomberie_raccord");
  }
  const linerKitFocus = /\b(kit\s+.*liner|liner.*kit|reparation\s+liner|kit\s+reparation\s+liner)\b/.test(q);
  if (
    !linerKitFocus &&
    /colle|coller|abs|\bpvc\b|pehd|polypropylene|multicouche|gebsooplast|manchon|raccord\s+pvc/i.test(q)
  ) {
    tags.add("plomberie_raccord");
  }

  if (!pasteJoint && /debouch|bouch|obstru/.test(q)) tags.add("debouchage");
  if (!pasteJoint && !isDescaling && /desembou|embouage|radiateur|inhibiteur/.test(q)) tags.add("desembouage");
  if (
    /\buniversel\b/.test(q) &&
    /\b(inhibiteur|desembou|chauffage|plancher|radiateur|g110|g10\b)\b/.test(q)
  ) {
    tags.add("chauffage");
    tags.add("desembouage");
  }
  if (/cheminee|poele|insert|refractaire/.test(q)) tags.add("cheminee");
  if (metadata.fluid === "gaz" || /gaz|gpl/.test(q)) tags.add("gaz");
  if (metadata.fluid === "chauffage") tags.add("chauffage");

  return [...tags];
}

export function productKnowledgeLocale(locale: string): "fr" | "nl" | "pl" {
  if (locale === "nl" || locale === "pl") return locale;
  return "fr";
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- Non précisé dans la fiche";
}

export type ProductKnowledgeRenderContext = {
  sessionAudience?: Audience | null;
  sessionTheme?: ProductTheme | null;
  locale?: Locale;
};

export function formatProductKnowledgeContext(
  product: ProductKnowledgeRow,
  renderContext?: ProductKnowledgeRenderContext,
): string {
  const apps = Array.isArray(product.applications)
    ? product.applications
        .slice(0, 2)
        .map((app) => `• ${app.context}: ${app.description}${app.constraints ? ` (${app.constraints})` : ""}`)
        .join("\n")
    : "";
  const advantages = product.advantages.slice(0, 3);
  const warnings = product.warnings.slice(0, 2);
  const compatibleFluids = product.compatible_fluids.join(", ") || "non précisé";
  const incompatibleFluids =
    product.incompatible_fluids.length > 0 ? product.incompatible_fluids.join(", ") : "";
  const incompatibleMaterials =
    product.incompatible_materials.length > 0 ? product.incompatible_materials.join(", ") : "";
  const compatibleMaterials =
    product.compatible_materials.length > 0 ? product.compatible_materials.join(", ") : "";

  const mismatchHints = renderContext
    ? buildCatalogMismatchHints({
        sessionAudience: renderContext.sessionAudience,
        sessionTheme: renderContext.sessionTheme,
        product: {
          canonical_name: product.canonical_name,
          slug: product.slug,
          audience: product.audience,
          theme: normalizeStoredProductTheme(product.theme),
        },
        locale: renderContext.locale,
      })
    : [];

  return [
    `# ${product.canonical_name}`,
    `Slug: ${product.slug}`,
    `Ligne catalogue: ${inferCatalogProductAudience(product.canonical_name, product.slug, product.audience ?? "all")}`,
    product.theme ? `Domaine catalogue: ${product.theme}` : "",
    ...mismatchHints,
    `Tags: ${product.use_case_tags.slice(0, 8).join(", ") || "non précisé"}`,
    product.summary_technical ?? "Non précisé dans la fiche",
    advantages.length > 0 ? `Avantages: ${advantages.join("; ")}` : "",
    product.supports
      ? `Supports: ${product.supports}`
      : compatibleMaterials
        ? `Supports: ${compatibleMaterials}`
        : "Supports: non précisé",
    incompatibleMaterials ? `Incompatible: ${incompatibleMaterials}` : "",
    `Fluides OK: ${compatibleFluids}`,
    incompatibleFluids ? `Fluides exclus: ${incompatibleFluids}` : "",
    `- Pression max: ${product.max_pressure_bar != null ? `${product.max_pressure_bar} bar` : "Non précisé"}`,
    `- Temp: ${product.temp_min_c != null || product.temp_max_c != null ? `${product.temp_min_c ?? "?"}–${product.temp_max_c ?? "?"}°C` : "Non précisé"}`,
    `- Séchage: ${product.curing_time ?? "Non précisé"}`,
    apps ? `Applications: ${apps}` : "",
    warnings.length > 0 ? `Garde: ${warnings.join("; ")}` : "",
    product.ft_url ? `FT: ${product.ft_url}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildRetrieverNodesFromProductKnowledge(
  products: ProductKnowledgeRow[],
  renderContext?: ProductKnowledgeRenderContext,
): unknown[] {
  return products.map((product, idx) => {
    const text = formatProductKnowledgeContext(product, renderContext);
    return {
      score: 1 - idx * 0.02,
      node: {
        metadata: {
          title: product.canonical_name,
          slug: product.slug,
          source_url: product.ft_url ?? "",
          url: product.ft_url ?? "",
          theme: product.theme,
          type: "product_knowledge",
          locale: product.locale,
          sheet_type: "ft",
        },
        text,
        getContent: () => text,
      },
    };
  });
}

export async function routeProductKnowledge(input: ProductRouterInput): Promise<{
  products: ProductKnowledgeRow[];
  tags: string[];
}> {
  const combined = `${input.query}\n${input.searchQuery}`;
  if (isPersonalDrinkwareOutOfCatalog(combined)) {
    return { products: [], tags: [] };
  }

  const locale = productKnowledgeLocale(input.locale);
  const tags = resolveUseCaseTags(input);

  const products = await searchProductKnowledge({
    locale,
    theme: input.theme,
    tags,
    material: input.metadata.material,
    fluid: input.metadata.fluid,
    query: input.query,
    searchQuery: input.searchQuery,
    ...(input.userQuery ? { userQuery: input.userQuery } : {}),
    limit: input.limit ?? 3,
    audience: input.audience ?? null,
    ...(input.feedbackAdjustments ? { feedbackAdjustments: input.feedbackAdjustments } : {}),
  });

  return { products, tags };
}

export function summarizeProductKnowledgeForDebug(product: ProductKnowledgeRow): Record<string, string | string[]> {
  return {
    title: product.canonical_name,
    slug: product.slug,
    theme: product.theme ?? "",
    use_case_tags: product.use_case_tags,
    source: "product_knowledge",
  };
}
