const ALLOWED_PROTOCOLS = new Set(["https:", "http:", "tel:"]);

export function isSafeHref(href: string | undefined): boolean {
  if (!href?.trim()) return false;
  const trimmed = href.trim();
  if (trimmed.startsWith("//")) return false;
  try {
    const url = new URL(trimmed, "https://safe.local");
    return ALLOWED_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

export function sanitizeTel(phone: string): string | null {
  const normalized = phone.replace(/\s+/g, "");
  if (!/^\+?[\d().-]{6,20}$/.test(normalized)) return null;
  return normalized;
}
