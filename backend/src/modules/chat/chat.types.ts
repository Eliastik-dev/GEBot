import type { z } from "zod";
import type { chatBodySchema } from "../../validation/schemas.js";
import type { VectorStoreIndex } from "llamaindex";
export type ValidatedChatBody = z.infer<typeof chatBodySchema>;
export type ChatDeps = { index: VectorStoreIndex; vectorStore: unknown };
