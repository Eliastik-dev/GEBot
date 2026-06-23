import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../src/modules/chat");
const phaseFiles = [
  "resolve-session-context.ts",
  "run-retrieval-pipeline.ts",
  "generate-and-stream-reply.ts",
  "post-process-reply.ts",
];

function fixCtxObjectShorthands(text) {
  for (let i = 0; i < 20; i++) {
    const next = text
      .replace(/\{ ctx\.(\w+)\s*,/g, "{ $1: ctx.$1,")
      .replace(/, ctx\.(\w+)\s*,/g, ", $1: ctx.$1,")
      .replace(/, ctx\.(\w+)\s*\}/g, ", $1: ctx.$1 }")
      .replace(/\(\{\s*ctx\.(\w+)\s*,/g, "({ $1: ctx.$1,");
    if (next === text) break;
    text = next;
  }
  return text;
}

function fixSpacing(text) {
  return text
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

for (const file of phaseFiles) {
  const fp = path.join(dir, file);
  let text = fs.readFileSync(fp, "utf8");
  text = fixCtxObjectShorthands(text);
  text = fixSpacing(text);
  fs.writeFileSync(fp, text);
}
console.log("fixed phase files");
