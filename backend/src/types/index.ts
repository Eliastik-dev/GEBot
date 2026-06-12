export type ChatRequestBody = {
  message?: string;
  sessionId?: string;
  locale?: string;
  profile?: string;
  theme?: string;
  geoConsent?: boolean;
  geoCountry?: string;
};

export type Audience = "professional" | "particulier";
export type ProductTheme = "plomberie" | "piscine" | "chauffage" | "batiment" | "maintenance" | "automobile" | "eco-conception";
export type Locale = "fr" | "en" | "nl" | "pl";
export type ChatRole = "user" | "assistant";
export type ResponseContextSnapshot = {
  search_query?: string;
  query_for_retrieval?: string;
  training_query?: string;
  feedback_correction?: boolean;
  conversation_transcript?: string;
  product_slugs?: string[];
  recommended_product?: string;
  retrieval_path?: "product_knowledge" | "vector_rag";
  use_case_tags?: string[];
};

export type StoredMessage = {
  role: ChatRole;
  content: string;
  id?: string;
  user_feedback?: number | null;
  response_context?: ResponseContextSnapshot | null;
};
export type Reseller = { name: string; url?: string; city?: string; country?: string };
export type RecommendationDetails = { productName: string | null; amazonUrl: string };
export type HandoffPayload = { label: string; phone: string } | null;

export type CacheEntry = {
  value: string;
  expiresAt: number;
};

export type ProblemClassification = {
  problemType: string;
  confidence: number;
  method: "rule" | "llm" | "hybrid";
};

