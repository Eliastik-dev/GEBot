import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../src/modules/chat");
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
  let text = fs.readFileSync(path.join(dir, file), "utf8");
  // Revert mistaken positional-arg rewrites: (foo, bar: b.bar, baz) -> (foo, b.bar, baz)
  text = text.replace(/([(,[])\s*(\w+): b\.\2\b/g, "$1b.$2");
  // Fix remaining object-literal shorthands
  for (let i = 0; i < 5; i++) {
    const next = text
      .replace(/\{ b\.(\w+)\s*,/g, "{ $1: b.$1,")
      .replace(/, b\.(\w+)\s*,(?!\s*\{)/g, ", $1: b.$1,")
      .replace(/, b\.(\w+)\s*\}/g, ", $1: b.$1 }");
    if (next === text) break;
    text = next;
  }
  text = text.replace(/=await /g, "= await ");
  text = text.replace(/=enrich/g, "= enrich");
  text = text.replace(/=build/g, "= build");
  text = text.replace(/=is/g, "= is");
  text = text.replace(/=get/g, "= get");
  text = text.replace(/=filter/g, "= filter");
  text = text.replace(/=resolve/g, "= resolve");
  text = text.replace(/=detect/g, "= detect");
  text = text.replace(/=count/g, "= count");
  text = text.replace(/=has/g, "= has");
  text = text.replace(/=await/g, "= await");
  fs.writeFileSync(path.join(dir, file), text);
}
console.log("Post-fixed chat modules (v2)");
