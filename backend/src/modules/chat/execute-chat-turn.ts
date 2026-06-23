import type { Request, Response } from "express";
import type { ChatDeps, ValidatedChatBody } from "./chat.types.js";
import type { ChatPipelineBindings } from "./chat-pipeline-bindings.js";
import { resolveSessionContext } from "./resolve-session-context.js";
import { runRetrievalPipeline } from "./run-retrieval-pipeline.js";
import { generateAndStreamReply } from "./generate-and-stream-reply.js";
import { postProcessReply } from "./post-process-reply.js";
import { getIncomingSessionId } from "../../utils/session.js";
import { normalizeAudience, normalizeLocale } from "../../utils/locale.js";
import type { ChatRequestBody } from "../../types/index.js";
import { fireAndForget } from "../../utils/async.js";
import { logQuery } from "../../services/database.service.js";
import { extractFluid } from "../../utils/text.js";
import { safeErrorPayload } from "../../utils/http.js";
import { sseWriteWithSession } from "../../utils/sse.js";
import { logPipelineTiming } from "./chat-timing.js";
export type { ChatDeps } from "./chat.types.js";

function createCtx(req: Request, res: Response, deps: ChatDeps): ChatPipelineBindings {
  const body = req.body as ValidatedChatBody;
  return {
    completed: false, req, res, deps,
    startedAt: Date.now(), body, message: body.message,
    locale: normalizeLocale(body.locale),
    profileFromMetadata: normalizeAudience(body.profile ?? undefined),
    sessionId: getIncomingSessionId(req, body as ChatRequestBody),
    geoConsentFromBody: body.geoConsent,
    geoCountryFromBody: body.geoCountry ?? null,
  };
}

export async function executeChatTurn(req: Request, res: Response, deps: ChatDeps): Promise<void> {
  const ctx = createCtx(req, res, deps);
  ctx.pipelineTiming = { requestStart: performance.now() };
  try {
    let phaseStart = performance.now();
    await resolveSessionContext(ctx);
    ctx.pipelineTiming.resolveSessionContextMs = Math.round(performance.now() - phaseStart);
    if (ctx.completed) {
      logPipelineTiming(ctx);
      return;
    }

    phaseStart = performance.now();
    await runRetrievalPipeline(ctx);
    ctx.pipelineTiming.runRetrievalPipelineMs = Math.round(performance.now() - phaseStart);
    if (ctx.completed) {
      logPipelineTiming(ctx);
      return;
    }

    phaseStart = performance.now();
    await generateAndStreamReply(ctx);
    ctx.pipelineTiming.generateAndStreamReplyMs = Math.round(performance.now() - phaseStart);
    if (ctx.completed) {
      logPipelineTiming(ctx);
      return;
    }

    phaseStart = performance.now();
    await postProcessReply(ctx);
    ctx.pipelineTiming.postProcessReplyMs = Math.round(performance.now() - phaseStart);
    logPipelineTiming(ctx);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/chat] fatal_error", { sessionId: ctx.sessionId, error: errorMessage });
    console.error("DETAILED ERROR:", err);
    logPipelineTiming(ctx);
    if (!ctx.res.headersSent) {
      fireAndForget(logQuery({ sessionId: ctx.sessionId, locale: ctx.locale, audience: ctx.profileFromMetadata, fluidType: extractFluid(ctx.message), query: ctx.message, responseMs: Date.now() - ctx.startedAt, status: "fatal_error" }), "logQuery.fatal_error");
      ctx.res.status(500).json(safeErrorPayload(errorMessage, err));
    } else {
      sseWriteWithSession(ctx.res, ctx.sessionId, { ...safeErrorPayload(errorMessage, err) }, "error");
      sseWriteWithSession(ctx.res, ctx.sessionId, { done: true, sessionId: ctx.sessionId, responseMs: Date.now() - ctx.startedAt, geoCountry: ctx.geoCountryFromBody }, "done");
      ctx.res.end();
    }
  }
}
