/**
 * Extracts postChat try-body into backend/src/modules/chat/ phase modules.
 * Run: node scripts/extract-chat-phases.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const controllerPath = path.join(root, "src/controllers/chat.controller.ts");
const outDir = path.join(root, "src/modules/chat");

const raw = fs.readFileSync(controllerPath, "utf8");
const lines = raw.split(/\r?\n/);

// Imports from controller (lines 1-95), helpers (101-143)
const importLines = lines.slice(0, 95);
const helperLines = lines.slice(100, 143);

// Try body: lines 156-1786 (1-based), content inside try { }
const tryBodyStart = 155; // 0-based index of line 156
const tryBodyEnd = 1786; // exclusive (line 1786 is res.end())
const tryBody = lines.slice(tryBodyStart, tryBodyEnd);

const phases = [
  { file: "resolve-session-context.ts", fn: "resolveSessionContext", start: 0, end: 345 }, // through line 500
  { file: "run-retrieval-pipeline.ts", fn: "runRetrievalPipeline", start: 346, end: 1349 }, // 502-1504
  { file: "generate-and-stream-reply.ts", fn: "generateAndStreamReply", start: 1350, end: 1528 }, // 1505-1683
  { file: "post-process-reply.ts", fn: "postProcessReply", start: 1529, end: tryBody.length },
];

// Top-level try declarations (exactly 6 spaces before const/let)
const topLevelDeclRe = /^      (const|let) ([A-Za-z_][\w]*) /;
const scopeVars = new Set();
for (const line of tryBody) {
  const m = line.match(topLevelDeclRe);
  if (m) scopeVars.add(m[2]);
}

// Initial scope fields from postChat before try
const initialScopeVars = [
  "startedAt",
  "body",
  "message",
  "locale",
  "profileFromMetadata",
  "sessionId",
  "geoConsentFromBody",
  "geoCountryFromBody",
];

function fixImports(block) {
  return block
    .split("\n")
    .map((line) => {
      if (line.startsWith('import ') && line.includes('from "../')) {
        return line.replace('from "../', 'from "../../');
      }
      if (line.startsWith('import ') && line.includes("from '../")) {
        return line.replace("from '../", "from '../../");
      }
      return line;
    })
    .join("\n");
}

function dedupeImports(importBlock) {
  const seen = new Set();
  const out = [];
  for (const line of importBlock.split("\n")) {
    if (!line.startsWith("import ")) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.join("\n");
}

function transformPhaseBody(bodyLines) {
  let out = bodyLines.map((line) => {
    // Unindent by 2 spaces (from try block 6-space to function 4-space base... actually keep 4-space inner)
    let l = line;
    if (l.startsWith("      ")) l = l.slice(2);

    const decl = l.match(/^    (const|let) ([A-Za-z_][\w]*) /);
    if (decl && scopeVars.has(decl[2])) {
      l = l.replace(/^    (const|let) ([A-Za-z_][\w]*) /, "    scope.$2 = ");
    }

    return l;
  });

  const text = out.join("\n");

  // Early exit: res.end(); return; -> set completed
  const withExits = text.replace(
    /res\.end\(\);\s*\n\s*return;/g,
    "res.end();\n    scope.completed = true;\n    return;",
  );

  // Replace scope variable reads (word boundary) — skip scope. itself and property assignments
  const sortedVars = [...scopeVars].sort((a, b) => b.length - a.length);
  let result = withExits;
  for (const v of sortedVars) {
    const re = new RegExp(`(?<!scope\\.)\\b${v}\\b(?!\\s*:)`, "g");
    result = result.replace(re, `scope.${v}`);
  }

  // Fix double scope.scope.
  result = result.replace(/scope\.scope\./g, "scope.");

  // Fix destructuring mistakes scope.scope in object literals - scope.sessionId in keys is fine

  return result;
}

function phaseImports(extra = "") {
  const base = dedupeImports(fixImports(importLines.join("\n")));
  return `${base}
import type { ChatTurnScope } from "./chat.types.js";
${extra}`;
}

fs.mkdirSync(outDir, { recursive: true });

// chat-helpers.ts
const helpersImports = dedupeImports(
  fixImports(
    importLines
      .filter((l) => l.includes("types/index") || l.includes("config/constants"))
      .join("\n"),
  ),
);
fs.writeFileSync(
  path.join(outDir, "chat-helpers.ts"),
  `${helpersImports}
import type { Audience, ProductTheme } from "../../types/index.js";
import { ANSWER_CACHE_VERSION } from "../../config/constants.js";

${helperLines.join("\n")}
`,
);

// chat.types.ts
const scopeFields = [...new Set([...initialScopeVars, "completed", ...scopeVars])];
const scopeInterface = scopeFields
  .map((f) => `  ${f}: unknown;`)
  .join("\n");

fs.writeFileSync(
  path.join(outDir, "chat.types.ts"),
  `import type { Request, Response } from "express";
import type { z } from "zod";
import type { chatBodySchema } from "../../validation/schemas.js";
import type { VectorStoreIndex } from "llamaindex";
import type { ChatRequestBody, Audience, Locale } from "../../types/index.js";

export type ValidatedChatBody = z.infer<typeof chatBodySchema>;

export type ChatDeps = { index: VectorStoreIndex; vectorStore: unknown };

/** Mutable per-request state shared across chat pipeline phases. */
export interface ChatTurnScope {
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
  // Populated progressively by pipeline phases
${scopeInterface}
}
`,
);

// Phase files
const extraImportsByPhase = {
  "resolve-session-context.ts": "",
  "run-retrieval-pipeline.ts": `import { buildAnswerCacheKey, filterRetrievalNodesByFeedbackPenalties } from "./chat-helpers.js";`,
  "generate-and-stream-reply.ts": "",
  "post-process-reply.ts": "",
};

for (const phase of phases) {
  const body = transformPhaseBody(tryBody.slice(phase.start, phase.end));
  const content = `${phaseImports(extraImportsByPhase[phase.file] ?? "")}

export async function ${phase.fn}(scope: ChatTurnScope): Promise<void> {
  if (scope.completed) return;
  const { req, res, deps } = scope;

${body}
}
`;
  fs.writeFileSync(path.join(outDir, phase.file), content);
}

// execute-chat-turn.ts
fs.writeFileSync(
  path.join(outDir, "execute-chat-turn.ts"),
  `${phaseImports(`import type { ChatTurnScope } from "./chat.types.js";
import { resolveSessionContext } from "./resolve-session-context.js";
import { runRetrievalPipeline } from "./run-retrieval-pipeline.js";
import { generateAndStreamReply } from "./generate-and-stream-reply.js";
import { postProcessReply } from "./post-process-reply.js";`)}

import type { ChatDeps, ValidatedChatBody } from "./chat.types.js";
import { getIncomingSessionId } from "../../utils/session.js";
import { normalizeAudience, normalizeLocale } from "../../utils/locale.js";
import type { ChatRequestBody } from "../../types/index.js";
import { fireAndForget } from "../../utils/async.js";
import { logQuery } from "../../services/database.service.js";
import { extractFluid } from "../../utils/text.js";
import { safeErrorPayload, isProduction } from "../../utils/http.js";
import { sseWriteWithSession } from "../../utils/sse.js";

export type { ChatDeps } from "./chat.types.js";

function createScope(req: Request, res: Response, deps: ChatDeps): ChatTurnScope {
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
  const scope = createScope(req, res, deps);
  try {
    await resolveSessionContext(scope);
    if (scope.completed) return;
    await runRetrievalPipeline(scope);
    if (scope.completed) return;
    await generateAndStreamReply(scope);
    if (scope.completed) return;
    await postProcessReply(scope);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/chat] fatal_error", {
      sessionId: scope.sessionId,
      error: errorMessage,
    });
    console.error("DETAILED ERROR:", err);
    if (!res.headersSent) {
      fireAndForget(
        logQuery({
          sessionId: scope.sessionId,
          locale: scope.locale,
          audience: scope.profileFromMetadata,
          fluidType: extractFluid(scope.message),
          query: scope.message,
          responseMs: Date.now() - scope.startedAt,
          status: "fatal_error",
        }),
        "logQuery.fatal_error",
      );
      res.status(500).json(safeErrorPayload(errorMessage, err));
    } else {
      sseWriteWithSession(res, scope.sessionId, { ...safeErrorPayload(errorMessage, err) }, "error");
      sseWriteWithSession(
        res,
        scope.sessionId,
        {
          done: true,
          sessionId: scope.sessionId,
          responseMs: Date.now() - scope.startedAt,
          geoCountry: scope.geoCountryFromBody,
        },
        "done",
      );
      res.end();
    }
  }
}
`,
);

// Thin controller
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

console.log("Extracted", scopeVars.size, "scope variables into", outDir);
console.log("Phases:", phases.map((p) => p.file).join(", "));
