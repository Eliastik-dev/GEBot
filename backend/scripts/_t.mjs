import fs from "fs";
const line = '    let retrievalPath: "product_knowledge" | "vector_rag" = "vector_rag";';
function fixNamedArgsInCallPrefix(line) {
  const idx = line.indexOf("{");
  const head = idx >= 0 ? line.slice(0, idx) : line;
  const tail = idx >= 0 ? line.slice(idx) : "";
  return head.replace(/(\b\w+): ctx\.(\1)\b/g, "ctx.$2") + tail;
}
console.log(fixNamedArgsInCallPrefix(line));
console.log(line.replace(/(?<!ctx\.)\bpkResolvedProducts\b/g, "ctx.pkResolvedProducts"));
