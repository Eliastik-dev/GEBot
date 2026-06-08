import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BuildInfo = {
  commit: string | null;
  builtAt: string | null;
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const distInfoPath = path.resolve(moduleDir, "../../dist/build-info.json");

let cached: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cached) return cached;

  if (process.env.DEPLOY_COMMIT) {
    cached = {
      commit: process.env.DEPLOY_COMMIT,
      builtAt: process.env.DEPLOY_BUILT_AT ?? null,
    };
    return cached;
  }

  try {
    if (fs.existsSync(distInfoPath)) {
      const raw = JSON.parse(fs.readFileSync(distInfoPath, "utf8")) as BuildInfo;
      cached = {
        commit: raw.commit ?? null,
        builtAt: raw.builtAt ?? null,
      };
      return cached;
    }
  } catch {
    // ignore malformed build-info.json
  }

  cached = { commit: null, builtAt: null };
  return cached;
}
