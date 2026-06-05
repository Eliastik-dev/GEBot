
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}


export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}


export function fireAndForget<T>(promise: Promise<T>, label: string): void {
  void promise.catch((error) => {
    console.warn(`[async:${label}]`, error);
  });
}


export function isRetryableMistralError(error: unknown): boolean {
  const statusCode = (error as { statusCode?: number })?.statusCode;
  const message = (error as { message?: string })?.message ?? "";
  return statusCode === 429 || statusCode === 503 || /service_tier_capacity_exceeded/i.test(message);
}


export function parseFallbackModels(raw: string): string[] {
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

