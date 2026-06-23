import fs from "node:fs";
const p = "c:/Projets/geb-chatbot/backend/scripts/split-chat-nested.mjs";
let s = fs.readFileSync(p, "utf8");
s = s.replace(/return ' \+ '\{' \+ e \+ '\}';/, "    return '$' + '{' + e + '}';");
s = s.replace(/return `\$\{\$\{e\}\}`;/, "    return '$' + '{' + e + '}';");
const lines = s.split("\n");
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("return") && lines[i-1]?.includes("ctx.ctx")) {
    lines[i] = "    return '$' + '{' + e + '}';";
  }
}
fs.writeFileSync(p, lines.join("\n"));
console.log("fixed");
