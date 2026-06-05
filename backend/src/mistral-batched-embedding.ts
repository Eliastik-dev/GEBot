import { Mistral } from "@mistralai/mistralai";
import { BaseEmbedding } from "@llamaindex/core/embeddings";

function isRateLimited(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if (!("statusCode" in err)) return false;
  return (err as { statusCode: unknown }).statusCode === 429;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * LlamaIndex's default {@link @llamaindex/mistral#MistralAIEmbedding} calls the Mistral API once per text.
 * With many chunks that exhausts low tiers (e.g. ~60 requests/min). Mistral supports multiple `inputs` per call;
 * this implementation sends one HTTP request per LlamaIndex batch.
 */
export class MistralBatchedEmbedding extends BaseEmbedding {
  private readonly client: Mistral;
  private readonly minIntervalMs: number;
  private readonly mistralModel: string;
  private lastBatchAt = 0;

  constructor(opts: {
    apiKey: string;
    embedBatchSize?: number;
    minIntervalMs?: number;
    model?: string;
  }) {
    super();
    this.client = new Mistral({ apiKey: opts.apiKey });
    this.embedBatchSize = opts.embedBatchSize ?? 32;
    this.minIntervalMs = opts.minIntervalMs ?? 0;
    this.mistralModel = opts.model ?? "mistral-embed";
    this.getTextEmbeddings = (texts: string[]) => this.embedMany(texts);
  }

  async getTextEmbedding(text: string): Promise<number[]> {
    const out = await this.embedMany([text]);
    const first = out[0];
    if (!first) throw new Error("Mistral embedding response missing data");
    return first;
  }

  private async pace(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const now = Date.now();
    const elapsed = now - this.lastBatchAt;
    if (this.lastBatchAt > 0 && elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastBatchAt = Date.now();
  }

  private async embedMany(texts: string[]): Promise<number[][]> {
    await this.pace();
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const { data } = await this.client.embeddings.create({
          model: this.mistralModel,
          inputs: texts,
        });
        return data.map((row) => row.embedding ?? []);
      } catch (err) {
        if (!isRateLimited(err)) throw err;
        const waitMs = Math.min(90_000, 1500 * 2 ** attempt);
        console.warn(`Mistral rate limit (429), retrying in ${waitMs}ms…`);
        await sleep(waitMs);
      }
    }
    throw new Error("Mistral embeddings: too many rate-limit retries");
  }
}
