import type { ChatPipelineBindings } from "./chat-pipeline-bindings.js";

export function logPipelineTiming(ctx: ChatPipelineBindings): void {
  const timing = ctx.pipelineTiming;
  if (!timing) return;

  const totalMs = Math.round(performance.now() - timing.requestStart);
  console.log("[/api/chat] pipeline_timing", {
    sessionId: ctx.sessionId,
    totalMs,
    phases: {
      resolveSessionContext: timing.resolveSessionContextMs ?? null,
      runRetrievalPipeline: timing.runRetrievalPipelineMs ?? null,
      generateAndStreamReply: timing.generateAndStreamReplyMs ?? null,
      postProcessReply: timing.postProcessReplyMs ?? null,
    },
    retrieval: {
      intentExtractor: timing.intentExtractorMs ?? null,
      vectorSearch: timing.vectorSearchMs ?? null,
    },
    generation: {
      ttft: timing.ttftMs ?? null,
    },
    earlyExit: ctx.completed && timing.postProcessReplyMs == null,
  });
}
