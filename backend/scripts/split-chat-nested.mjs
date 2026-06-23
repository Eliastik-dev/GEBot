/**
 * Extract chat pipeline phases into separate modules sharing ChatPipelineBindings.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const controllerPath = path.join(root, "src/controllers/chat.controller.ts");
const origPath = path.join(root, "scripts/_orig-chat.controller.ts");
let lines = fs.readFileSync(origPath, "utf8").split(/\r?\n/);
const outDir = path.join(root, "src/modules/chat");
const importBlock = lines.slice(0, 95).join("\n").replaceAll('from "../', 'from "../../');
const helperLines = lines.slice(100, 143).join("\n");
const tryBody = lines.slice(155, 1786);

const phases = [
  { file: "resolve-session-context.ts", fn: "resolveSessionContext", start: 0, end: 345 },
  { file: "run-retrieval-pipeline.ts", fn: "runRetrievalPipeline", start: 346, end: 1349 },
  { file: "generate-and-stream-reply.ts", fn: "generateAndStreamReply", start: 1350, end: 1528 },
  { file: "post-process-reply.ts", fn: "postProcessReply", start: 1529, end: tryBody.length },
];

const SKIP = new Set(["res", "req", "deps", "ctx"]);
const topDecl = /^      (const|let) ([A-Za-z_][\w]*) =/;
const scopeVars = new Set();
for (const line of tryBody) {
  const m = line.match(topDecl);
  if (m && !SKIP.has(m[2])) scopeVars.add(m[2]);
  const mt = line.match(/^      (const|let) ([A-Za-z_][\w]*):/);
  if (mt && !SKIP.has(mt[2])) scopeVars.add(mt[2]);
}

function protectLiterals(text) {
  const saved = [];
  const save = (m) => {
    saved.push(m);
    return `__LIT${saved.length - 1}__`;
  };
  let out = text.replace(/`(?:[^`\\]|\\.)*`/g, save);
  out = out.replace(/"(?:[^"\\]|\\.)*"/g, save);
  out = out.replace(/'(?:[^'\\]|\\.)*'/g, save);
  return { out, saved };
}
function replaceTemplateExpressions(line) {
  return line.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    let e = expr;
    for (const v of [...scopeVars].sort((a, b) => b.length - a.length)) {
      e = e.replace(new RegExp(`(?<!ctx\\.)(?<![.\\w])${v}\\b(?!\\s*:)`, "g"), `ctx.${v}`);
    }
    e = e.replace(/ctx\.ctx\./g, "ctx.");
    return '$' + '{' + e + '}';
  });
}

function restoreLiterals(text, saved) {
  return text.replace(/__LIT(\d+)__/g, (_, i) => saved[Number(i)]);
}

function transformBody(slice) {
  let lines = slice.map((l) => (l.startsWith("      ") ? l.slice(2) : l));
  lines = lines.map((line) => {
    if (line.includes("ctx.")) return line;
    const m =
      line.match(/^    (const|let) ([A-Za-z_][\w]*) =/) ??
      line.match(/^    (const|let) ([A-Za-z_][\w]*) =\s*$/);
    if (m && scopeVars.has(m[2])) return line.replace(/^    (?:const|let) ([A-Za-z_][\w]*) =\s*/, "    ctx.$1 = ");
    return line;
  });

  const out = [];
  for (const line of lines) {
    let t = line;
    const { out: p, saved } = protectLiterals(t);
    t = p;
    for (const v of [...scopeVars].sort((a, b) => b.length - a.length)) {
      t = t.replace(new RegExp(`(?<!ctx\\.)(?<![.\\w])${v}\\b(?!\\s*:)`, "g"), `ctx.${v}`);
    }
    t = t.replace(/ctx\.ctx\./g, "ctx.");
    t = restoreLiterals(t, saved);
    t = replaceTemplateExpressions(t);
    out.push(t);
  }
  return out
    .join("\n")
    .replace(/res\.end\(\);\s*\n\s*return;/g, "ctx.completed = true;\n    res.end();\n    return;");
}

function fixInnerObjectProps(inner) {
  return inner
    .split(",")
    .map((part) => {
      const p = part.trim();
      if (p.startsWith("ctx.") && !p.includes(":")) {
        const key = p.slice(4);
        return `${key}: ${p}`;
      }
      return part;
    })
    .join(",");
}

function fixObjectLiteralsOnLine(line) {
  return line.replace(/\{([^}]+)\}/g, (_, inner) => `{${fixInnerObjectProps(inner)}}`);
}

function finalize(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/^(\s+)const ctx\./, "$1ctx.").replace(/^(\s+)let ctx\./, "$1ctx."))
    .join("\n");
}

fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(
  path.join(outDir, "chat-helpers.ts"),
  `import type { Audience, ProductTheme } from "../../types/index.js";
import { ANSWER_CACHE_VERSION } from "../../config/constants.js";

${helperLines.replace(/^function /gm, "export function ")}
`,
);

const optional = [...scopeVars].sort().map((v) => `  ${v}?: any;`).join("\n");
fs.writeFileSync(
  path.join(outDir, "chat-pipeline-bindings.ts"),
  `import type { Request, Response } from "express";
import type { ChatDeps, ValidatedChatBody } from "./chat.types.js";
import type { Audience, Locale } from "../../types/index.js";

export interface ChatPipelineBindings {
  completed: boolean;
  req: Request;
  res: Response;
  deps: ChatDeps;
  startedAt: number;
  body: ValidatedChatBody;
  message: string;
  locale: Locale;
  profileFromMetadata: Audience | null;
  sessionId: string;
  geoConsentFromBody?: boolean | undefined;
  geoCountryFromBody: string | null;
${optional}
}
`,
);

fs.writeFileSync(
  path.join(outDir, "chat.types.ts"),
  `import type { z } from "zod";
import type { chatBodySchema } from "../../validation/schemas.js";
import type { VectorStoreIndex } from "llamaindex";
export type ValidatedChatBody = z.infer<typeof chatBodySchema>;
export type ChatDeps = { index: VectorStoreIndex; vectorStore: unknown };
`,
);

for (const p of phases) {
  let body = finalize(transformBody(tryBody.slice(p.start, p.end)));
  const extra =
    p.file === "run-retrieval-pipeline.ts"
      ? `import { buildAnswerCacheKey, filterRetrievalNodesByFeedbackPenalties } from "./chat-helpers.js";\n`
      : "";
  fs.writeFileSync(
    path.join(outDir, p.file),
    `${importBlock}
import type { ChatPipelineBindings } from "./chat-pipeline-bindings.js";
${extra}
export async function ${p.fn}(ctx: ChatPipelineBindings): Promise<void> {
  if (ctx.completed) return;
  const { req, res, deps, startedAt, body, message, locale, profileFromMetadata, sessionId, geoConsentFromBody, geoCountryFromBody } = ctx;

${body}
}
`,
  );
}

fs.writeFileSync(
  path.join(outDir, "execute-chat-turn.ts"),
  `import type { Request, Response } from "express";
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
  try {
    await resolveSessionContext(ctx);
    if (ctx.completed) return;
    await runRetrievalPipeline(ctx);
    if (ctx.completed) return;
    await generateAndStreamReply(ctx);
    if (ctx.completed) return;
    await postProcessReply(ctx);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/chat] fatal_error", { sessionId: ctx.sessionId, error: errorMessage });
    console.error("DETAILED ERROR:", err);
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
`,
);

fs.writeFileSync(
  path.join(root, "src/controllers/chat.controller.ts"),
  `import type { Request, Response } from "express";
import { executeChatTurn, type ChatDeps } from "../modules/chat/execute-chat-turn.js";
export type { ChatDeps };
export async function postChat(req: Request, res: Response, deps: ChatDeps) {
  await executeChatTurn(req, res, deps);
}
`,
);

console.log("ok", scopeVars.size);

