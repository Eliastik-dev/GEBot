/**
 * Extracts postChat into backend/src/modules/chat/ phase modules (behavior-preserving).
 * Run: node scripts/extract-chat-pipeline-v2.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const controllerPath = path.join(root, "src/controllers/chat.controller.ts");
const outDir = path.join(root, "src/modules/chat");

const lines = fs.readFileSync(controllerPath, "utf8").split(/\r?\n/);
const importBlock = lines
  .slice(0, 95)
  .join("\n")
  .replaceAll('from "../', 'from "../../');
const helperLines = lines.slice(100, 143).join("\n");

const tryBody = lines.slice(155, 1786);

const phases = [
  { file: "resolve-session-context.ts", fn: "resolveSessionContext", start: 0, end: 345 },
  { file: "run-retrieval-pipeline.ts", fn: "runRetrievalPipeline", start: 346, end: 1349 },
  { file: "generate-and-stream-reply.ts", fn: "generateAndStreamReply", start: 1350, end: 1528 },
  { file: "post-process-reply.ts", fn: "postProcessReply", start: 1529, end: tryBody.length },
];

const SKIP_VARS = new Set(["res", "req", "deps", "b", "if", "else", "return", "await", "typeof", "null", "true", "false"]);

const topLevelDeclRe = /^      (const|let) ([A-Za-z_][\w]*) /;
const scopeVars = new Set();
for (const line of tryBody) {
  const m = line.match(topLevelDeclRe);
  if (m && !SKIP_VARS.has(m[2])) scopeVars.add(m[2]);
}

function unindent(linesSlice) {
  return linesSlice.map((l) => (l.startsWith("      ") ? l.slice(2) : l));
}

function protectLiterals(text) {
  const saved = [];
  const token = (m) => {
    saved.push(m);
    return `__LIT${saved.length - 1}__`;
  };
  let out = text.replace(/`(?:[^`\\]|\\.)*`/g, token);
  out = out.replace(/"(?:[^"\\]|\\.)*"/g, token);
  out = out.replace(/'(?:[^'\\]|\\.)*'/g, token);
  return { out, saved };
}

function restoreLiterals(text, saved) {
  return text.replace(/__LIT(\d+)__/g, (_, i) => saved[Number(i)]);
}

function fixBindingShorthandInObject(line) {
  return line.replace(/^(\s+)b\.(\w+),$/, "$1$2: b.$2,");
}

function transformDeclLine(line) {
  if (line.includes("b.")) return line;
  const decl =
    line.match(/^    (const|let) ([A-Za-z_][\w]*) = /) ??
    line.match(/^    (const|let) ([A-Za-z_][\w]*) =\s*$/);
  if (decl && scopeVars.has(decl[2])) {
    return line.replace(/^    (?:const|let) ([A-Za-z_][\w]*) =\s*/, "    b.$1 = ");
  }
  return line;
}

function transformBindings(code) {
  const lines = code.split("\n");
  let inTemplate = false;
  let braceDepth = 0;
  const out = [];

  for (const line of lines) {
    const tickCount = (line.match(/(?<!\\)`/g) ?? []).length;

    let transformed = inTemplate ? line : transformDeclLine(line);
    const { out: protectedLine, saved } = protectLiterals(transformed);
    let t = protectedLine;
    const sorted = [...scopeVars].sort((a, b) => b.length - a.length);
    for (const v of sorted) {
      const re = new RegExp(`(?<!b\\.)(?<![.\\w])${v}\\b(?!\\s*:)`, "g");
      t = t.replace(re, `b.${v}`);
    }
    t = t.replace(/b\.b\./g, "b.");
    t = restoreLiterals(t, saved);
    if (!inTemplate && (braceDepth > 0 || t.includes("{"))) {
      t = fixBindingShorthandInObject(t);
      if (t.includes("{")) {
        t = t.replace(/\{ b\.(\w+)\s*,/g, "{ $1: b.$1,");
        t = t.replace(/, b\.(\w+)\s*,/g, ", $1: b.$1,");
        t = t.replace(/, b\.(\w+)\s*\}/g, ", $1: b.$1 }");
      }
    }
    t = t.replace(/const b\./g, "b.");
    t = t.replace(/let b\./g, "b.");
    out.push(t);

    if (!inTemplate) {
      const openBraces = (t.match(/\{/g) ?? []).length;
      const closeBraces = (t.match(/\}/g) ?? []).length;
      braceDepth += openBraces - closeBraces;
      if (braceDepth < 0) braceDepth = 0;
    }

    if (tickCount % 2 === 1) inTemplate = !inTemplate;
  }

  let text = out.join("\n");
  text = text.replace(/res\.end\(\);\s*\n\s*return;/g, "res.end();\n    b.completed = true;\n    return;");
  return text;
}

function phaseHeader(extraImport = "") {
  return `${importBlock}
import type { ChatPipelineBindings } from "./chat-pipeline-bindings.js";
${extraImport}
`;
}

fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(
  path.join(outDir, "chat-helpers.ts"),
  `import type { Audience, ProductTheme } from "../../types/index.js";
import { ANSWER_CACHE_VERSION } from "../../config/constants.js";

${helperLines}
`,
);

const bindingOptional = [...scopeVars]
  .sort()
  .map((v) => `  ${v}?: unknown;`)
  .join("\n");

fs.writeFileSync(
  path.join(outDir, "chat-pipeline-bindings.ts"),
  `import type { Request, Response } from "express";
import type { ChatDeps, ValidatedChatBody } from "./chat.types.js";
import type { Audience, Locale } from "../../types/index.js";

/** Mutable per-request state shared across chat pipeline phases. */
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
  geoConsentFromBody?: boolean;
  geoCountryFromBody: string | null;
${bindingOptional}
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

for (const phase of phases) {
  const body = transformBindings(unindent(tryBody.slice(phase.start, phase.end)).join("\n"));
  const extra =
    phase.file === "run-retrieval-pipeline.ts"
      ? `import { buildAnswerCacheKey, filterRetrievalNodesByFeedbackPenalties } from "./chat-helpers.js";`
      : "";
  const content = `${phaseHeader(extra)}
export async function ${phase.fn}(b: ChatPipelineBindings): Promise<void> {
  if (b.completed) return;
  const { req, res, deps } = b;
  const {
    startedAt,
    body,
    message,
    locale,
    profileFromMetadata,
    sessionId,
    geoConsentFromBody,
    geoCountryFromBody,
  } = b;

${body}
}
`;
  fs.writeFileSync(path.join(outDir, phase.file), content);
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

function createBindings(req: Request, res: Response, deps: ChatDeps): ChatPipelineBindings {
  const body = req.body as ValidatedChatBody;
  return {
    completed: false,
    req,
    res,
    deps,
    startedAt: Date.now(),
    body,
    message: body.message,
    locale: normalizeLocale(body.locale),
    profileFromMetadata: normalizeAudience(body.profile ?? undefined),
    sessionId: getIncomingSessionId(req, body as ChatRequestBody),
    geoConsentFromBody: body.geoConsent,
    geoCountryFromBody: body.geoCountry ?? null,
  };
}

export async function executeChatTurn(req: Request, res: Response, deps: ChatDeps): Promise<void> {
  const b = createBindings(req, res, deps);
  const { res: response } = b;
  try {
    await resolveSessionContext(b);
    if (b.completed) return;
    await runRetrievalPipeline(b);
    if (b.completed) return;
    await generateAndStreamReply(b);
    if (b.completed) return;
    await postProcessReply(b);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/chat] fatal_error", {
      sessionId: b.sessionId,
      error: errorMessage,
    });
    console.error("DETAILED ERROR:", err);
    if (!response.headersSent) {
      fireAndForget(
        logQuery({
          sessionId: b.sessionId,
          locale: b.locale,
          audience: b.profileFromMetadata,
          fluidType: extractFluid(b.message),
          query: b.message,
          responseMs: Date.now() - b.startedAt,
          status: "fatal_error",
        }),
        "logQuery.fatal_error",
      );
      response.status(500).json(safeErrorPayload(errorMessage, err));
    } else {
      sseWriteWithSession(response, b.sessionId, { ...safeErrorPayload(errorMessage, err) }, "error");
      sseWriteWithSession(
        response,
        b.sessionId,
        {
          done: true,
          sessionId: b.sessionId,
          responseMs: Date.now() - b.startedAt,
          geoCountry: b.geoCountryFromBody,
        },
        "done",
      );
      response.end();
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

console.log("Done:", scopeVars.size, "binding fields,", phases.length, "phases");
