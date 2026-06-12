import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BuildInfo = {
  commit: string | null;
  builtAt: string | null;
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const distInfoPath = path.resolve(moduleDir, "../../dist/build-info.json");

export function getBuildInfo(): BuildInfo {
  if (process.env.DEPLOY_COMMIT) {
    return {
      commit: process.env.DEPLOY_COMMIT,
      builtAt: process.env.DEPLOY_BUILT_AT ?? null,
    };
  }

  try {
    if (fs.existsSync(distInfoPath)) {
      const raw = JSON.parse(fs.readFileSync(distInfoPath, "utf8")) as BuildInfo;
      return {
        commit: raw.commit ?? null,
        builtAt: raw.builtAt ?? null,
      };
    }
  } catch {
    // ignore malformed build-info.json
  }

  return { commit: null, builtAt: null };
}
