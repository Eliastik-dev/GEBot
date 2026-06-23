/**
 * Splits postChat try-body into nested async functions inside execute-chat-turn.ts.
 * Run: node scripts/build-chat-pipeline.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const controllerPath = path.join(root, "src/controllers/chat.controller.ts");
const outDir = path.join(root, "src/modules/chat");

const lines = fs.readFileSync(controllerPath, "utf8").split(/\r?\n/);

const importBlock = lines.slice(0, 95).join("\n").replaceAll('from "../', 'from "../../');
const helperLines = lines.slice(100, 143).join("\n");

const tryBody = lines.slice(155, 1786); // lines 156-1786

const phaseSplits = [
  { name: "resolveSessionContext", start: 0, end: 345 },
  { name: "runRetrievalPipeline", start: 346, end: 1349 },
  { name: "generateAndStreamReply", start: 1350, end: 1528 },
  { name: "postProcessReply", start: 1529, end: tryBody.length },
];

function unindentPhase(linesSlice) {
  return linesSlice
    .map((line) => (line.startsWith("      ") ? line.slice(2) : line))
    .join("\n")
    .replace(/res\.end\(\);\s*\n\s*return;/g, "res.end();\n    completed = true;\n    return;");
}

fs.mkdirSync(outDir, { recursive: true });

// helpers
const helpersImports = `import type { Audience, ProductTheme } from "../../types/index.js";
import { ANSWER_CACHE_VERSION } from "../../config/constants.js";
`;
fs.writeFileSync(path.join(outDir, "chat-helpers.ts"), `${helpersImports}\n${helperLines}\n`);

// types
fs.writeFileSync(
  path.join(outDir, "chat.types.ts"),
  `import type { Request, Response } from "express";
import type { z } from "zod";
import type { chatBodySchema } from "../../validation/schemas.js";
import type { VectorStoreIndex } from "llamaindex";
import type { ChatRequestBody, Audience } from "../../types/index.js";

export type ValidatedChatBody = z.infer<typeof chatBodySchema>;
export type ChatDeps = { index: VectorStoreIndex; vectorStore: unknown };
`,
);

// Phase modules — each receives shared bindings from closure via parameter
const phaseFiles = [];
for (const phase of phaseSplits) {
  const body = unindentPhase(tryBody.slice(phase.start, phase.end));
  const fileName = phase.name.replace(/([A-Z])/g, (m, c, i) => (i ? "-" : "") + c.toLowerCase()) + ".ts";
  // camelCase to kebab: resolveSessionContext -> resolve-session-context
  const kebab = phase.name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase() + ".ts";

  const phaseImports = `${importBlock}
import type { ChatPipelineBindings } from "./chat-pipeline-bindings.js";

export async function ${phase.name}(b: ChatPipelineBindings): Promise<void> {
  if (b.completed) return;
${body}
}
`;
  fs.writeFileSync(path.join(outDir, kebab), phaseImports);
  phaseFiles.push({ fn: phase.name, file: kebab });
}

// Generate bindings interface by collecting top-level const/let in try body
const bindingVars = new Set(["completed"]);
const declRe = /^      (?:const|let) ([A-Za-z_][\w]*) /;
for (const line of tryBody) {
  const m = line.match(declRe);
  if (m) bindingVars.add(m[1]);
}

// chat-pipeline-bindings.ts - use interface with index signature for incremental typing
const bindingFields = [...bindingVars]
  .filter((v) => v !== "completed")
  .map((v) => `  ${v}?: unknown;`)
  .join("\n");

fs.writeFileSync(
  path.join(outDir, "chat-pipeline-bindings.ts"),
  `import type { Request, Response } from "express";
import type { ChatDeps, ValidatedChatBody } from "./chat.types.js";
import type { Audience, Locale } from "../../types/index.js";

/** Shared mutable bindings across chat pipeline phases (closure substitute). */
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
${bindingFields}
}
`,
);

// Build execute-chat-turn with nested functions that alias bindings to locals
// Strategy: use `with` is bad. Use explicit local aliases via destructuring won't work for assignments.

// Instead: execute-chat-turn creates bindings object and passes to phases.
// Phase code must use b.var - we need to transform ONLY top-level decls in phases.

console.log("Phase files written; run transform-bindings.mjs next");
