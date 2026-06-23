import fs from "node:fs";
const fp = "c:/Projets/geb-chatbot/backend/scripts/split-chat-nested.mjs";
let s = fs.readFileSync(fp, "utf8");

if (!s.includes("topDeclTyped")) {
  s = s.replace(
    "for (const line of tryBody) {\n  const m = line.match(topDecl);\n  if (m && !SKIP.has(m[2])) scopeVars.add(m[2]);\n}",
    `for (const line of tryBody) {
  const m = line.match(topDecl);
  if (m && !SKIP.has(m[2])) scopeVars.add(m[2]);
  const mt = line.match(/^      (const|let) ([A-Za-z_][\\w]*):/);
  if (mt && !SKIP.has(mt[2])) scopeVars.add(mt[2]);
}`,
  );
}

if (!s.includes("replaceTemplateExpressions")) {
  s = s.replace(
    "function restoreLiterals(text, saved) {",
    `function replaceTemplateExpressions(line) {
  return line.replace(/\\$\\{([^}]+)\\}/g, (_, expr) => {
    let e = expr;
    for (const v of [...scopeVars].sort((a, b) => b.length - a.length)) {
      e = e.replace(new RegExp(\`(?<!ctx\\\\.)(?<![.\\\\w])\${v}\\\\b(?!\\\\s*:)\`, "g"), \`ctx.\${v}\`);
    }
    e = e.replace(/ctx\\.ctx\\./g, "ctx.");
    return \`\${\${e}}\`;
  });
}

function restoreLiterals(text, saved) {`,
  );

  s = s.replace(
    `  let inTemplate = false;
  const out = [];
  for (const line of lines) {
    const ticks = (line.match(/(?<!\\\\)\`/g) ?? []).length;
    let t = line;
    if (!inTemplate) {
      const { out: p, saved } = protectLiterals(t);
      t = p;
      for (const v of [...scopeVars].sort((a, b) => b.length - a.length)) {
        t = t.replace(new RegExp(\`(?<!ctx\\\\.)(?<![.\\\\w])\${v}\\\\b(?!\\\\s*:)\`, "g"), \`ctx.\${v}\`);
      }
      t = t.replace(/ctx\\.ctx\\./g, "ctx.");
      t = restoreLiterals(t, saved);
    }
    out.push(t);
    if (ticks % 2 === 1) inTemplate = !inTemplate;
  }`,
    `  const out = [];
  for (const line of lines) {
    let t = line;
    const { out: p, saved } = protectLiterals(t);
    t = p;
    for (const v of [...scopeVars].sort((a, b) => b.length - a.length)) {
      t = t.replace(new RegExp(\`(?<!ctx\\\\.)(?<![.\\\\w])\${v}\\\\b(?!\\\\s*:)\`, "g"), \`ctx.\${v}\`);
    }
    t = t.replace(/ctx\\.ctx\\./g, "ctx.");
    t = restoreLiterals(t, saved);
    t = replaceTemplateExpressions(t);
    out.push(t);
  }`,
  );
}

s = s.replace(/\?: unknown;/g, "?: any;");

fs.writeFileSync(fp, s);
console.log("patched split script");
