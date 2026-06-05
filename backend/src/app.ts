import cors from "cors";
import express from "express";
import { configureLlm } from "./config/llm.js";
import { env } from "./config/env.js";
import { buildQueryEngine } from "./services/rag.service.js";
import { registerRoutes } from "./routes/index.js";
import { errorHandler } from "./middleware/errorHandler.js";

export async function createApp(): Promise<express.Express> {
  configureLlm();
  const { index, vectorStore } = await buildQueryEngine();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  registerRoutes(app, { index, vectorStore });
  app.use(errorHandler);

  return app;
}

export async function startServer(): Promise<void> {
  const app = await createApp();
  app.listen(env.PORT, () => {
    console.log(`Backend listening on http://localhost:${env.PORT}`);
  });
}
