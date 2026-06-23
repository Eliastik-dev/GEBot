export {
  PRODUCT_KNOWLEDGE_THEME_FALLBACK_MIN,
  type ProductKnowledgeSearchInput,
  type CatalogCitationResult,
} from "./types.js";

export {
  searchProductKnowledge,
  getProductKnowledgeBySlug,
  upsertProductKnowledge,
  countProductKnowledge,
  listProductKnowledgeSlugs,
  injectFeedbackBoostProducts,
} from "./search.js";

export {
  filterProductKnowledgeByQueryContext,
  filterProductKnowledgeByPenalties,
} from "./filters.js";

export {
  detectCatalogProductCitations,
  lookupCatalogProductsByCitation,
} from "./citations.js";

export {
  lookupExplicitCatalogProductForSheet,
  lookupCitedCatalogProductForRecommendation,
} from "./lookups.js";
