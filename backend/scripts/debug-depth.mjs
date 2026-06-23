import fs from "fs";
const lines = fs.readFileSync("c:/Projets/geb-chatbot/backend/src/modules/chat/run-retrieval-pipeline.ts","utf8").split("\n");
function stripStrings(line) {
  return line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, "``");
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
let brace=0, paren=0;
for (let i=0;i<lines.length;i++) {
  const inCallArgs = paren > 0 && paren > brace;
  if (i>=620 && i<=632) console.log(i+1, {brace, paren, inCallArgs, line: lines[i].trim().slice(0,60)});
  ({brace, paren} = updateDepth(lines[i], brace, paren));
}
