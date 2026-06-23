import fs from "node:fs";
const p = "c:/Projets/geb-chatbot/backend/scripts/split-chat-nested.mjs";
let lines = fs.readFileSync(p, "utf8").split("\n");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("return `${${e}}`") || lines[i].includes("return '${")) {
    lines[i] = "    return '$' + '{' + e + '}';";
  }
}
let s = lines.join("\n");
// fix broken scope loop
s = s.replace(
  /for \(const line of tryBody\) \{[\s\S]*?\n\}/,
  `for (const line of tryBody) {
  const m = line.match(topDecl);
  if (m && !SKIP.has(m[2])) scopeVars.add(m[2]);
  const mt = line.match(/^      (const|let) ([A-Za-z_][\\w]*):/);
  if (mt && !SKIP.has(mt[2])) scopeVars.add(mt[2]);
}`,
);
s = s.replace(
  /let lines = fs\.readFileSync\(controllerPath[\s\S]*?\n\}/,
  `const origPath = path.join(root, "scripts/_orig-chat.controller.ts");
let lines = fs.readFileSync(origPath, "utf8").split(/\\r?\\n/);`,
);
s = s.replace("const tryBody = lines.slice(155, 1786);", "const tryBody = lines.slice(155, 1786);");
s = s.replace(/\?: unknown;/g, "?: any;");
s = s.replace(
  /function finalize\(text\) \{[\s\S]*?\n\}\n\nfs\.mkdirSync/,
  `function finalize(text) {
  return text
    .split("\\n")
    .map((line) => line.replace(/^(\\s+)const ctx\\./, "$1ctx.").replace(/^(\\s+)let ctx\\./, "$1ctx."))
    .join("\\n");
}

fs.mkdirSync`,
);
fs.writeFileSync(p, s);
console.log("split script repaired");
