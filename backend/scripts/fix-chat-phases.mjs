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

function revertNamedCallArg(line) {
  return line.replace(/^(\s+)(\w+): ctx\.(\w+)\s*,?\s*$/, (m, s, k, v) => (k === v ? `${s}ctx.${v},` : m));
}

function fixInlineObjectBraces(line) {
  return line.replace(/\{([^{}]*)\}/g, (_, inner) => {
    let fixed = inner;
    for (let i = 0; i < 5; i++) {
      const n = fixed
        .replace(/, ctx\.(\w+)\s*,/g, ", $1: ctx.$1,")
        .replace(/, ctx\.(\w+)\s*\}/g, ", $1: ctx.$1 }");
      if (n === fixed) break;
      fixed = n;
    }
    return `{${fixed}}`;
  });
}

function fixFile(text) {
  text = text.replace(
    /ctx\.upsell = \s*\n\s*productFollowUp: ctx\.productFollowUp,\s*\n\s*\? null/g,
    "ctx.upsell = \n      ctx.productFollowUp\n        ? null",
  );

  const lines = text.split("\n");
  let brace = 0;
  let paren = 0;
  const out = [];

  for (let line of lines) {
    if (/\{/.test(line) && /\}/.test(line)) line = fixInlineObjectBraces(line);

    const inObject = brace > paren;
    const inCallArgs = paren > 0 && !inObject;

    if (inObject) {
      for (let i = 0; i < 5; i++) {
        const n = line
          .replace(/^\s+ctx\.(\w+)\s*,\s*$/, (m, k) => m.replace(`ctx.${k}`, `${k}: ctx.${k}`))
          .replace(/, ctx\.(\w+)\s*,/g, ", $1: ctx.$1,")
          .replace(/, ctx\.(\w+)\s*\}/g, ", $1: ctx.$1 }");
        if (n === line) break;
        line = n;
      }
    }

    if (inCallArgs) line = revertNamedCallArg(line);
    if (inCallArgs) {
      line = line.replace(/, (\w+): ctx\.(\1)\b/g, (_, k) => `, ctx.${k}`);
      line = line.replace(/\((\w+): ctx\.(\1)\b/g, (_, k) => `(ctx.${k}`);
    }

    out.push(line);
    ({ brace, paren } = updateDepth(line, brace, paren));
  }

  return out
    .join("\n")
    .replace(/=await /g, "= await ")
    .replace(/=enrich/g, "= enrich")
    .replace(/=build/g, "= build")
    .replace(/=is([A-Z])/g, "= is$1")
    .replace(/=get/g, "= get")
    .replace(/=filter/g, "= filter")
    .replace(/=resolve/g, "= resolve")
    .replace(/=detect/g, "= detect")
    .replace(/=count/g, "= count")
    .replace(/=has/g, "= has");
}

for (const f of files) {
  fs.writeFileSync(path.join(dir, f), fixFile(fs.readFileSync(path.join(dir, f), "utf8")));
}
console.log("phase fix ok");
