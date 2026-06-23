import fs from "node:fs";
import path from "node:path";

const chatDir = path.resolve(import.meta.dirname, "../src/modules/chat");
const bindingsPath = path.join(chatDir, "chat-pipeline-bindings.ts");

fs.writeFileSync(
  bindingsPath,
  `import type { Request, Response } from "express";
import type { ChatDeps, ValidatedChatBody } from "./chat.types.js";
import type { Audience, Locale } from "../../types/index.js";

/** Shared mutable state for one chat turn (postChat try-block). */
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
  [key: string]: any;
}
`,
);

const LOCAL = new Set([
  "req", "res", "deps", "startedAt", "body", "message", "locale",
  "profileFromMetadata", "sessionId", "geoConsentFromBody", "geoCountryFromBody",
  "completed", "ctx", "env", "i", "k", "v", "m", "p", "e", "err", "line", "lines",
  "resolvedNodes", "pkRouteTags", "pkProductSlugs", "retrievalPath", "judgeInput",
]);

const phaseFiles = [
  "resolve-session-context.ts",
  "run-retrieval-pipeline.ts",
  "generate-and-stream-reply.ts",
  "post-process-reply.ts",
];

function fixTemplateExprs(text) {
  return text.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    let e = expr;
    for (const v of [...LOCAL]) {
      // skip
    }
    const vars = e.match(/[A-Za-z_][\w]*/g) ?? [];
    for (const v of vars) {
      if (LOCAL.has(v) || v.startsWith("ctx")) continue;
      e = e.replace(new RegExp(`(?<!ctx\\.)(?<![.\\w])${v}\\b(?!\s*:)`, "g"), `ctx.${v}`);
    }
    e = e.replace(/ctx\.ctx\./g, "ctx.");
    return "${" + e + "}";
  });
}

for (const f of phaseFiles) {
  const fp = path.join(chatDir, f);
  let text = fs.readFileSync(fp, "utf8");
  text = fixTemplateExprs(text);
  fs.writeFileSync(fp, text);
}
console.log("bindings + templates fixed");
