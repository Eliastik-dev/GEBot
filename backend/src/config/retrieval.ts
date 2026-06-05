/**
 * Phase 4: Vector RAG runs in "lite" mode when product_knowledge covers the locale.
 * Skips scenario-specific reranking patches (exhaust supplement, automotive boosts).
 */

export type VectorRagLiteMode = "auto" | "true" | "false";

export function resolveVectorRagLite(catalogSize: number): boolean {
  const mode = (process.env.VECTOR_RAG_LITE ?? "auto") as VectorRagLiteMode;
  if (mode === "false") return false;
  if (mode === "true") return true;
  return catalogSize > 0;
}
