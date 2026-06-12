/**
 * PM2 process manager configuration for the GEBot backend.
 *
 * Usage (from repository root):
 *   pm2 start ecosystem.config.js
 *   pm2 reload ecosystem.config.js   # zero-downtime reload after deploy
 *   pm2 save
 */
const fs = require("fs");
const path = require("path");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const env = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

const projectRoot = __dirname;
const rootEnvPath = path.join(projectRoot, ".env");
const backendEnvPath = path.join(projectRoot, "backend", ".env");

let cwd = projectRoot;
let script = path.join(projectRoot, "backend", "dist", "server.js");
let envFile = rootEnvPath;

if (fs.existsSync(backendEnvPath) && !fs.existsSync(rootEnvPath)) {
  cwd = path.join(projectRoot, "backend");
  script = path.join(cwd, "dist", "server.js");
  envFile = backendEnvPath;
} else if (fs.existsSync(rootEnvPath)) {
  cwd = projectRoot;
  script = path.join(projectRoot, "backend", "dist", "server.js");
  envFile = rootEnvPath;
} else {
  console.warn(
    "[ecosystem.config.js] No .env file found at project root or backend/. " +
      "Create one before starting PM2."
  );
}

const envFromFile = parseEnvFile(envFile);

function readBuildInfoStamp() {
  const candidates = [
    path.join(projectRoot, "backend", "dist", "build-info.json"),
    path.join(projectRoot, "backend", "dist", "build-info.json"),
  ];
  if (cwd === path.join(projectRoot, "backend")) {
    candidates.unshift(path.join(cwd, "dist", "build-info.json"));
  }
  for (const infoPath of candidates) {
    try {
      if (fs.existsSync(infoPath)) {
        return JSON.parse(fs.readFileSync(infoPath, "utf8"));
      }
    } catch {
      // try next candidate
    }
  }
  return {};
}

const buildStamp = readBuildInfoStamp();

module.exports = {
  apps: [
    {
      name: "gebot-backend",
      script,
      cwd,
      node_args: "--enable-source-maps",
      env: {
        NODE_ENV: "production",
        DEPLOY_COMMIT: buildStamp.commit ?? "",
        DEPLOY_BUILT_AT: buildStamp.builtAt ?? "",
        ...envFromFile,
      },
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 4000,
      max_memory_restart: "512M",
      kill_timeout: 5000,
      listen_timeout: 10000,
      merge_logs: true,
      time: true,
      // Production deploys rebuild dist/; rely on deploy_ubuntu.sh + pm2 reload.
      watch: false,
    },
  ],
};
