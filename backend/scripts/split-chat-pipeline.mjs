/**
 * One-off helper: splits chat.controller.ts try-body into phase module files.
 * Run from backend/: node scripts/split-chat-pipeline.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const srcPath = path.join(root, "src/controllers/chat.controller.ts");
const lines = fs.readFileSync(srcPath, "utf8").split(/\r?\n/);

const importBlock = lines.slice(0, 95).join("\n");
const helpers = lines.slice(100, 143).join("\n");

const phaseRanges = {
  "resolve-session-context.ts": { start: 155, end: 500, fn: "resolveSessionContext" },
  "run-retrieval-pipeline.ts": { start: 501, end: 1504, fn: "runRetrievalPipeline" },
  "generate-and-stream-reply.ts": { start: 1504, end: 1683, fn: "generateAndStreamReply" },
  "post-process-reply.ts": { start: 1684, end: 1786, fn: "postProcessReply" },
};

const sharedHeader = `${importBlock}
import type { ChatPipelineContext } from "./chat.types.js";
import { buildAnswerCacheKey, filterRetrievalNodesByFeedbackPenalties } from "./chat-helpers.js";

`;

const helpersFile = `${importBlock.split("\n").filter((l) => !l.includes("chat.controller")).join("\n")}
import type { Audience, ProductTheme } from "../types/index.js";
import { ANSWER_CACHE_VERSION } from "../config/constants.js";

${helpers}
`;

function wrapPhase(fnName, bodyLines) {
  const body = bodyLines
    .map((line) => {
      if (line.startsWith("      ")) return line.slice(2);
      if (line.startsWith("    ")) return line.slice(2);
      return line;
    })
    .join("\n");

  return `${sharedHeader}
export async function ${fnName}(ctx: ChatPipelineContext): Promise<void> {
  if (ctx.completed) return;
  const {
    req, res, deps, startedAt,
    body, message, locale, profileFromMetadata, sessionId,
    geoConsentFromBody, geoCountryFromBody,
  } = ctx;

${body}
}
`;
}

const outDir = path.join(root, "src/modules/chat");
fs.mkdirSync(outDir, { recursive: true });

for (const [file, { start, end, fn }] of Object.entries(phaseRanges)) {
  const body = lines.slice(start - 1, end);
  fs.writeFileSync(path.join(outDir, file), wrapPhase(fn, body));
}

fs.writeFileSync(path.join(outDir, "chat-helpers.ts"), helpersFile);

console.log("Wrote phase modules to", outDir);
