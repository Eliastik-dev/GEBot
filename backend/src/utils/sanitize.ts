/** Strip control chars (keep \\n, \\r, \\t) and null bytes from user-provided text. */
export function sanitizeUserText(input: string, maxLength: number): string {
  const stripped = input
    .replace(/\0/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return stripped.slice(0, maxLength).trim();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

const ISO_COUNTRY_RE = /^[A-Z]{2}$/;

export function isValidIsoCountry(value: string): boolean {
  return ISO_COUNTRY_RE.test(value);
}
