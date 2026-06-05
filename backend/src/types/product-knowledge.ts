import type { Locale, ProductTheme } from "./index.js";

export type ProductApplication = {
  context: string;
  description: string;
  constraints: string | null;
};

/** LLM extraction output before DB normalization. */
export type SynthesizedProductFacts = {
  summary_technical: string;
  advantages: string[];
  compatible_materials: string[];
  incompatible_materials: string[];
  compatible_fluids: string[];
  incompatible_fluids: string[];
  use_case_tags: string[];
  applications: ProductApplication[];
  max_pressure_bar: number | null;
  temp_min_c: number | null;
  temp_max_c: number | null;
  curing_time: string | null;
  supports: string | null;
  certifications: string[];
  warnings: string[];
};

export type ProductKnowledgeRow = {
  id: string;
  wp_id: number;
  slug: string;
  locale: Locale | "fr" | "nl" | "pl";
  canonical_name: string;
  theme: ProductTheme | string | null;
  gamme_officielle?: string | null;
  wp_product_cat_slugs?: string[];
  theme_source?: "wordpress" | "heuristic" | null;
  audience: string;
  regulatory_scope: string;
  ft_url: string | null;
  fds_url: string | null;
  summary_technical: string | null;
  advantages: string[];
  compatible_materials: string[];
  incompatible_materials: string[];
  compatible_fluids: string[];
  incompatible_fluids: string[];
  use_case_tags: string[];
  applications: ProductApplication[];
  max_pressure_bar: number | null;
  temp_min_c: number | null;
  temp_max_c: number | null;
  curing_time: string | null;
  supports: string | null;
  certifications: string[];
  warnings: string[];
  source_ft_hash: string | null;
  extraction_version: string;
  extraction_model: string | null;
  extracted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type UpsertProductKnowledgeInput = {
  wp_id: number;
  slug: string;
  locale: "fr" | "nl" | "pl";
  canonical_name: string;
  theme: ProductTheme | null;
  theme_source?: "wordpress" | "heuristic" | null;
  gamme_officielle?: string | null;
  wp_product_cat_slugs?: string[];
  ft_url: string | null;
  fds_url: string | null;
  source_ft_hash: string;
  extraction_version: string;
  extraction_model: string;
  facts: SynthesizedProductFacts;
};

export const PRODUCT_KNOWLEDGE_EXTRACTION_VERSION = "1.0";
