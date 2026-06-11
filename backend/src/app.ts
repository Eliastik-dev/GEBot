import express from "express";
import { configureLlm } from "./config/llm.js";
import { getBuildInfo } from "./config/build-info.js";
import { env } from "./config/env.js";
import { buildQueryEngine } from "./services/rag.service.js";
import { countProductKnowledge } from "./services/product-knowledge.service.js";
import { registerRoutes, RETRIEVAL_FEATURES_VERSION } from "./routes/index.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { applySecurityMiddleware } from "./middleware/security.js";

export async function createApp(): Promise<express.Express> {
  configureLlm();
  const { index, vectorStore } = await buildQueryEngine();

  const app = express();
  applySecurityMiddleware(app);
  app.use(express.json({ limit: "64kb" }));

  registerRoutes(app, { index, vectorStore });
  app.use(errorHandler);

  return app;
}

export async function startServer(): Promise<void> {
  const app = await createApp();
  const build = getBuildInfo();
  const productKnowledgeFr = env.PRODUCT_KNOWLEDGE_ENABLED
    ? await countProductKnowledge("fr").catch(() => 0)
    : 0;
  app.listen(env.PORT, () => {
    console.log(`Backend listening on http://localhost:${env.PORT}`);
    console.log("[startup]", {
      commit: build.commit,
      builtAt: build.builtAt,
      productKnowledgeEnabled: env.PRODUCT_KNOWLEDGE_ENABLED,
      productKnowledgeFr,
      catalogReady: env.PRODUCT_KNOWLEDGE_ENABLED && productKnowledgeFr > 0,
      retrievalVersion: RETRIEVAL_FEATURES_VERSION,
    });
    if (env.PRODUCT_KNOWLEDGE_ENABLED && productKnowledgeFr === 0) {
      console.warn(
        "[startup] product_knowledge catalog is EMPTY for locale fr — chat falls back to vector-only retrieval. " +
          "Run: npm run synthesize-products --prefix backend",
      );
    }
  });
}
