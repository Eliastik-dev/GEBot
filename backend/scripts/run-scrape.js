/** @deprecated Use `npm run scrape` (tsx src/scripts/scrape-products.ts). */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(dir, "..");
const result = spawnSync("npx", ["tsx", "src/scripts/scrape-products.ts"], {
  cwd: backendRoot,
  stdio: "inherit",
  shell: true,
});
process.exit(result.status ?? 1);

