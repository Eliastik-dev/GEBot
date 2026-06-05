export type ResponseContextSnapshot = {
  search_query?: string;
  /** Enriched user question used for retrieval (may merge prior turns). */
  query_for_retrieval?: string;
  /** Multi-turn transcript at answer time — used when recording feedback. */
  conversation_transcript?: string;
  source_urls?: string[];
  retrieval_count?: number;
  retrieval_path?: "product_knowledge" | "vector_rag";
  product_slugs?: string[];
  use_case_tags?: string[];
};

export type RetrievalFeedbackEvent = {
  id: string;
  message_id: string;
  session_id: string;
  feedback: -1 | 0 | 1;
  locale: string | null;
  theme: string | null;
  user_query: string | null;
  assistant_reply: string | null;
  search_query: string | null;
  intent: string | null;
  retrieval_path: string | null;
  product_slugs: string[];
  use_case_tags: string[];
  recommended_product: string | null;
  judge_score: number | null;
  metadata_extracted: Record<string, unknown> | null;
  retrieval_mismatch: boolean;
  notes: string | null;
  created_at: string;
};
