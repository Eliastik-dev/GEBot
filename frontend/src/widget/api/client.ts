import type { Audience, ChatStreamPayload, GeolocationConsent, Locale, ProductTheme } from "../types.js";

export async function streamChat(
  apiBaseUrl: string,
  message: string,
  sessionId: string,
  locale: Locale,
  profile: Exclude<Audience, null> | null,
  theme: Exclude<ProductTheme, null> | null,
  geoConsent: GeolocationConsent,
  geoCountry: string | null,
  onDelta: (delta: string) => void,
  onMeta: (meta: ChatStreamPayload) => void,
  onReplace?: (content: string) => void,
): Promise<void> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({
      message,
      sessionId,
      locale,
      ...(profile ? { profile } : {}),
      ...(theme ? { theme } : {}),
      geoConsent: geoConsent === "accepted" ? true : geoConsent === "declined" ? false : undefined,
      ...(geoCountry ? { geoCountry } : {}),
    }),
  });
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Chat API error (${res.status}): ${txt}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const lines = frame.split("\n").filter(Boolean);
      const dataLine = lines.find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const json = dataLine.slice("data: ".length);
      try {
        const payload = JSON.parse(json) as ChatStreamPayload;
        if (payload.error) throw new Error(payload.error);
        if (payload.replaceContent !== undefined) {
          onReplace?.(payload.replaceContent);
        } else if (payload.delta) onDelta(payload.delta);
        onMeta(payload);
      } catch {
        // ignore malformed chunks
      }
    }
  }
}

export async function fetchGeoCountry(
  apiBaseUrl: string,
  sessionId: string,
  locale: Locale,
  onSessionToken?: (token: string) => void,
): Promise<string | null> {
  const endpoint = `${apiBaseUrl.replace(/\/$/, "")}/api/geolocation?sessionId=${encodeURIComponent(sessionId)}&locale=${encodeURIComponent(locale)}`;
  const response = await fetch(endpoint, {
    headers: { "x-session-id": sessionId, Accept: "application/json" },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { countryCode?: string | null; sessionToken?: string };
  if (payload.sessionToken) onSessionToken?.(payload.sessionToken);
  return typeof payload.countryCode === "string" ? payload.countryCode : null;
}

export async function submitFeedback(
  apiBaseUrl: string,
  sessionId: string,
  sessionToken: string,
  messageId: string,
  feedback: 1 | -1,
): Promise<void> {
  await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/feedback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": sessionId,
      ...(sessionToken ? { "X-Session-Token": sessionToken } : {}),
    },
    body: JSON.stringify({
      messageId,
      sessionId,
      feedback,
      ...(sessionToken ? { sessionToken } : {}),
    }),
  });
}
