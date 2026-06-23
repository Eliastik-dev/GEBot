import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../src/modules/chat");
const files = [
  "resolve-session-context.ts",
  "run-retrieval-pipeline.ts",
  "generate-and-stream-reply.ts",
  "post-process-reply.ts",
];

function stripStrings(line) {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function updateDepth(line, brace, paren) {
  const s = stripStrings(line);
  for (const ch of s) {
    if (ch === "{") brace++;
    else if (ch === "}") brace--;
    else if (ch === "(") paren++;
    else if (ch === ")") paren--;
  }
  return { brace, paren };
}

function inObjectLiteral(brace, paren) {
  return brace > paren || (brace >= 2 && paren >= 2 && brace === paren);
}

function revertNamedCallArgLine(line) {
  return line.replace(/^(\s+)(\w+): ctx\.(\w+)\s*,?\s*$/, (m, s, k, v) => (k === v ? `${s}ctx.${v},` : m));
}

function fixNamedArgsInCallPrefix(line) {
  const idx = line.indexOf("{");
  const head = idx >= 0 ? line.slice(0, idx) : line;
  const tail = idx >= 0 ? line.slice(idx) : "";
  return head.replace(/(\b\w+): ctx\.(\1)\b/g, "ctx.$2") + tail;
}

function fixTypedLetToCtx(text) {
  return text.replace(
    /^(\s*)let (retrievalPath|pkResolvedProducts): ([^=]+)= ([^;]+);/gm,
    (_, indent, name, type, value) => `${indent}ctx.${name} = ${value.trim()} as ${type.trim()};`,
  );
}

function fixKnownNamedCallBlocks(text) {
  text = text.replace(
    /\n(\s+)queryForRetrieval: ctx\.queryForRetrieval,\n\1effectiveTheme: ctx\.effectiveTheme,/g,
    "\n$1ctx.queryForRetrieval,\n$1ctx.effectiveTheme,",
  );
  text = text.replace(
    /\n(\s+)pkResolvedProducts: ctx\.pkResolvedProducts,\n\1feedbackHardBoosts: ctx\.feedbackHardBoosts,\n\1pkLocale: ctx\.pkLocale,/g,
    "\n$1ctx.pkResolvedProducts,\n$1ctx.feedbackHardBoosts,\n$1ctx.pkLocale,",
  );
  text = text.replace(
    /resolvedNodes = dynamicRerank\(\n(\s+)resolvedNodes,\n\1queryForRetrieval: ctx\.queryForRetrieval,\n\1searchQuery: ctx\.searchQuery,\n\1extractedMeta: ctx\.extractedMeta,\n\1effectiveTheme: ctx\.effectiveTheme,/g,
    "resolvedNodes = dynamicRerank(\n$1resolvedNodes,\n$1ctx.queryForRetrieval,\n$1ctx.searchQuery,\n$1ctx.extractedMeta,\n$1ctx.effectiveTheme,",
  );
  text = text.replace(
    /filterRetrievalNodesByFeedbackPenalties\(\n(\s+)resolvedNodes,\n\1ctx\.feedbackCtx\.penalizeSlugs,\n\1feedbackHardPenalties: ctx\.feedbackHardPenalties,/g,
    "filterRetrievalNodesByFeedbackPenalties(\n$1resolvedNodes,\n$1ctx.feedbackCtx.penalizeSlugs,\n$1ctx.feedbackHardPenalties,",
  );
  return text;
}

for (const f of files) {
  let text = fs.readFileSync(path.join(dir, f), "utf8");
  text = fixTypedLetToCtx(text);
  text = text.replace(/(?<![\w.])(retrievalPath)\s*=\s*"/g, "ctx.$1 = \"");
  let lines = text.split("\n");
  lines = lines.map((line) => fixNamedArgsInCallPrefix(line));
  lines = lines.map((line) => line.replace(/(?<!ctx\.)\bpkResolvedProducts\b/g, "ctx.pkResolvedProducts"));
  lines = lines.map((line) => line.replace(/(?<!ctx\.)\bcatalogCitation\b/g, "ctx.catalogCitation"));

  let brace = 0;
  let paren = 0;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const inObject = inObjectLiteral(brace, paren);
    const inCallArgs = paren > 0 && !inObject;
    if (inCallArgs) line = revertNamedCallArgLine(line);
    if (inObject && /^\s+ctx\.(\w+)\s*,\s*$/.test(line)) {
      line = line.replace(/^\s+ctx\.(\w+)\s*,\s*$/, (m, k) => m.replace(`ctx.${k}`, `${k}: ctx.${k}`));
    }
    lines[i] = line;
    ({ brace, paren } = updateDepth(line, brace, paren));
  }
  text = fixKnownNamedCallBlocks(lines.join("\n"));
  fs.writeFileSync(path.join(dir, f), text);
}
console.log("extra fix ok");
