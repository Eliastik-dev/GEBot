import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import type { Audience, Locale, ProductTheme, StoredMessage, ChatRole } from "../types/index.js";
import type { ExtractedMetadata } from "../intent-extractor.js";
import { VALID_THEMES } from "../config/constants.js";

export async function ensureSession(
  sessionId: string,
  locale: Locale,
  geoConsent?: boolean,
  geoCountry?: string | null,
): Promise<{ audience: Audience | null; geoCountry: string | null; geoConsent: boolean | null }> {
  const isMissingGeoColumnsError = (error: unknown): boolean => {
    const code = (error as { code?: string })?.code;
    const message = (error as { message?: string })?.message ?? "";
    return (
      (code === "PGRST204" || code === "42703") &&
      (/geo_consent/i.test(message) || /geo_country/i.test(message))
    );
  };

  const geoCountryCode = geoCountry?.toUpperCase() ?? null;
  const upsertPayload = {
    session_id: sessionId,
    locale,
    geo_consent: geoConsent ?? null,
    geo_country: geoCountryCode,
    last_seen_at: new Date().toISOString(),
  };
  const { error: upsertError } = await supabase.from("chat_sessions").upsert(
    upsertPayload,
    { onConflict: "session_id" },
  );
  if (upsertError) {
    const missingGeoColumns = isMissingGeoColumnsError(upsertError);
    if (!missingGeoColumns) throw upsertError;
    console.warn("[/api/chat] chat_sessions missing geo columns, using fallback upsert.");
    const { error: fallbackUpsertError } = await supabase.from("chat_sessions").upsert(
      {
        session_id: sessionId,
        locale,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "session_id" },
    );
    if (fallbackUpsertError) throw fallbackUpsertError;
  }

  const { data: existing, error: selectError } = await supabase
    .from("chat_sessions")
    .select("audience, geo_country, geo_consent")
    .eq("session_id", sessionId)
    .maybeSingle();

  if (selectError) {
    const missingGeoColumns = isMissingGeoColumnsError(selectError);
    if (!missingGeoColumns) throw selectError;
    const { data: fallbackExisting, error: fallbackSelectError } = await supabase
      .from("chat_sessions")
      .select("audience")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (fallbackSelectError) throw fallbackSelectError;
    const fallbackAudience =
      fallbackExisting?.audience === "professional" || fallbackExisting?.audience === "particulier"
        ? fallbackExisting.audience
        : null;
    return { audience: fallbackAudience, geoCountry: null, geoConsent: null };
  }

  const audience =
    existing?.audience === "professional" || existing?.audience === "particulier" ? existing.audience : null;
  const storedGeoCountry = typeof existing?.geo_country === "string" ? existing.geo_country.toUpperCase() : null;
  const storedGeoConsent = typeof existing?.geo_consent === "boolean" ? existing.geo_consent : null;
  return { audience, geoCountry: storedGeoCountry, geoConsent: storedGeoConsent };
}


export async function updateSessionAudience(sessionId: string, audience: Audience, locale: Locale): Promise<void> {
  const { error } = await supabase
    .from("chat_sessions")
    .update({
      audience,
      locale,
      last_seen_at: new Date().toISOString(),
    })
    .eq("session_id", sessionId);
  if (error) throw error;
}


export async function updateSessionTheme(sessionId: string, theme: ProductTheme): Promise<void> {
  const { error } = await supabase
    .from("chat_sessions")
    .update({
      theme,
      last_seen_at: new Date().toISOString(),
    })
    .eq("session_id", sessionId);
  if (error) throw error;
}


export async function getSessionTheme(sessionId: string): Promise<ProductTheme | null> {
  const { data, error } = await supabase
    .from("chat_sessions")
    .select("theme")
    .eq("session_id", sessionId)
    .maybeSingle();
  if (error) return null;
  const t = data?.theme;
  return VALID_THEMES.includes(t as ProductTheme) ? (t as ProductTheme) : null;
}


export async function saveMessage(
  sessionId: string,
  role: ChatRole,
  content: string,
  extra?: {
    metadata_extracted?: ExtractedMetadata | null;
    intent?: string | null;
    response_context?: Record<string, unknown> | null;
  },
): Promise<string | null> {
  const payload: Record<string, unknown> = {
    session_id: sessionId,
    role,
    content,
  };
  if (extra?.metadata_extracted) payload.metadata_extracted = extra.metadata_extracted;
  if (extra?.intent) payload.intent = extra.intent;
  if (extra?.response_context) payload.response_context = extra.response_context;

  const { data, error } = await supabase
    .from("chat_messages")
    .insert(payload)
    .select("id")
    .maybeSingle();

  if (error) {
    const msg = (error as { message?: string }).message ?? "";
    if (/metadata_extracted|intent|response_context/i.test(msg) || (error as { code?: string }).code === "42703") {
      const { data: fallbackData, error: fallbackError } = await supabase
        .from("chat_messages")
        .insert({ session_id: sessionId, role, content })
        .select("id")
        .maybeSingle();
      if (fallbackError) throw fallbackError;
      return fallbackData?.id ?? null;
    }
    throw error;
  }
  return data?.id ?? null;
}


export async function loadRecentMessages(sessionId: string): Promise<StoredMessage[]> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("role, content, response_context")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(Math.max(env.CHAT_HISTORY_LIMIT, 30));
  if (error) throw error;
  return [...(data ?? [])].reverse();
}


export async function logQuery(params: {
  sessionId: string;
  locale: Locale;
  audience: Audience | null;
  fluidType: string | null;
  query: string;
  responseMs: number;
  status: string;
}): Promise<void> {
  const isSchemaMismatch = (err: unknown): boolean => {
    const code = (err as { code?: string })?.code;
    const message = (err as { message?: string })?.message ?? "";
    return (
      code === "PGRST204" ||
      code === "42703" ||
      /Could not find the .* column/i.test(message) ||
      /column .* does not exist/i.test(message)
    );
  };

  const payload = {
    session_id: params.sessionId,
    locale: params.locale,
    audience: params.audience,
    fluid_type: params.fluidType,
    query: params.query,
    response_ms: params.responseMs,
    status: params.status,
  };
  const { error } = await supabase.from("chat_queries").insert(payload);
  if (!error) return;

  if (!isSchemaMismatch(error)) throw error;
  console.warn("[/api/chat] chat_queries schema mismatch:", (error as { message?: string }).message ?? error);

  const fallbackAttempts = [
    () =>
      supabase.from("chat_queries").insert({
        session_id: params.sessionId,
        query: params.query,
        response_ms: params.responseMs,
        status: params.status,
      }),
    () =>
      supabase.from("chat_queries").insert({
        session_id: params.sessionId,
        query: params.query,
        status: params.status,
      }),
    () =>
      supabase.from("chat_queries").insert({
        session_id: params.sessionId,
        query: params.query,
      }),
  ];

  for (const attempt of fallbackAttempts) {
    const { error: fallbackError } = await attempt();
    if (!fallbackError) return;
    if (!isSchemaMismatch(fallbackError)) throw fallbackError;
  }
  // Do not fail the chat flow when analytics schema is outdated.
}


export async function logProductAnalytics(params: {
  sessionId: string;
  locale: Locale;
  audience: Audience | null;
  query: string;
  recommendedProduct: string | null;
  amazonUrl: string;
  problemType: string;
  status: string;
}): Promise<void> {
  const { error } = await supabase.from("product_analytics").insert({
    session_id: params.sessionId,
    locale: params.locale,
    audience: params.audience,
    query: params.query,
    recommended_product: params.recommendedProduct,
    amazon_url: params.amazonUrl,
    problem_type: params.problemType,
    status: params.status,
  });
  if (!error) return;
  const message = (error as { message?: string }).message ?? "";
  if (
    (error as { code?: string }).code === "PGRST204" ||
    (error as { code?: string }).code === "PGRST205" ||
    /relation .*product_analytics.* does not exist/i.test(message) ||
    /could not find the table .*product_analytics/i.test(message)
  ) {
    console.warn("[/api/chat] product_analytics table missing:", message);
    return;
  }
  throw error;
}


export async function logProblemEvent(params: {
  sessionId: string;
  locale: Locale;
  audience: Audience | null;
  geoCountry: string | null;
  problemType: string;
  confidence: number;
  method: "rule" | "llm" | "hybrid";
}): Promise<void> {
  const { error } = await supabase.from("query_problem_events").insert({
    session_id: params.sessionId,
    primary_problem_code: params.problemType,
    detection_method: params.method,
    confidence: params.confidence,
    locale: params.locale,
    audience: params.audience,
    geo_country: params.geoCountry,
  });
  if (!error) return;
  const message = (error as { message?: string }).message ?? "";
  if (/query_problem_events/i.test(message) || (error as { code?: string }).code === "PGRST204") {
    console.warn("[/api/chat] query_problem_events table missing:", message);
    return;
  }
  throw error;
}

