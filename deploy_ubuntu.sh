#!/usr/bin/env bash
#
# GEBot — Ubuntu VM deployment script (initial install + updates).
# Run from the repository root: ./deploy_ubuntu.sh
#
set -euo pipefail

readonly APP_NAME="gebot-backend"
readonly NODE_MAJOR="20"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
  echo -e "${GREEN}[deploy]${NC} $*"
}

warn() {
  echo -e "${YELLOW}[deploy]${NC} $*"
}

fail() {
  echo -e "${RED}[deploy] ERROR:${NC} $*" >&2
  exit 1
}

read_health_commit() {
  local port="$1"
  local json
  json="$(curl -sf --max-time 10 "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
  echo "${json}" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' | head -1
}

port_listener_pid() {
  local port="$1"
  ss -H -tlnp "sport = :${port}" 2>/dev/null \
    | sed -n 's/.*pid=\([0-9]*\).*/\1/p' \
    | head -1
}

pm2_app_for_pid() {
  local pid="$1"
  local name
  for name in $(pm2 jlist 2>/dev/null | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' | sort -u); do
    if [[ "$(pm2 pid "${name}" 2>/dev/null || true)" == "${pid}" ]]; then
      echo "${name}"
      return 0
    fi
  done
  return 1
}

is_gebot_backend_process() {
  local cmd="$1"
  [[ "${cmd}" == *"${SCRIPT_DIR}/backend/dist/server.js"* ]]
}

warn_port_conflict() {
  local port="$1"
  local owner_pid owner_app owner_cmd
  owner_pid="$(port_listener_pid "${port}")"
  [[ -n "${owner_pid}" ]] || return 0
  owner_cmd="$(ps -p "${owner_pid}" -o args= 2>/dev/null | head -c 200 || true)"
  owner_app="$(pm2_app_for_pid "${owner_pid}" 2>/dev/null || true)"
  warn "Port ${port} is already bound (PID ${owner_pid}${owner_app:+ — PM2 app '${owner_app}'})."
  [[ -n "${owner_cmd}" ]] && warn "  Process: ${owner_cmd}"
  if [[ -n "${owner_app}" && "${owner_app}" != "${APP_NAME}" ]]; then
    echo ""
    echo -e "${RED}Port ${port} is owned by PM2 app '${owner_app}', not '${APP_NAME}'.${NC}"
    echo "  '${APP_NAME}' cannot serve /health on that port (likely crash-looping in PM2)."
    echo "  Fix on the server:"
    echo "    pm2 stop ${owner_app}    # only if ${owner_app} is an obsolete duplicate GEBot"
    echo "    # OR set a different PORT= in ${ENV_FILE}"
    echo "    pm2 delete ${APP_NAME}"
    echo "    pm2 start ecosystem.config.js"
    echo "    pm2 save"
    echo ""
    fail "Resolve the port conflict before redeploying."
  fi
}

wait_for_port_free() {
  local port="$1"
  local max_wait="${2:-15}"
  local attempt
  for ((attempt = 1; attempt <= max_wait; attempt++)); do
    [[ -z "$(port_listener_pid "${port}")" ]] && return 0
    sleep 1
  done
  return 1
}

kill_backend_listener_pid() {
  local port="$1"
  local owner_pid="$2"
  local reason="$3"
  warn "Stopping GEBot backend on port ${port} (${reason}, PID ${owner_pid})."
  kill "${owner_pid}" 2>/dev/null || true
  if ! wait_for_port_free "${port}" 10; then
    warn "Process still listening — sending SIGKILL to PID ${owner_pid}."
    kill -9 "${owner_pid}" 2>/dev/null || true
    wait_for_port_free "${port}" 5 || true
  fi
  if [[ -z "$(port_listener_pid "${port}")" ]]; then
    log "Port ${port} released."
  fi
}

release_stale_backend_listener() {
  local port="$1"
  local force="${2:-0}"
  local owner_pid owner_app owner_cmd gebot_pid
  owner_pid="$(port_listener_pid "${port}")"
  [[ -n "${owner_pid}" ]] || return 0

  owner_cmd="$(ps -p "${owner_pid}" -o args= 2>/dev/null || true)"
  owner_app="$(pm2_app_for_pid "${owner_pid}" 2>/dev/null || true)"
  gebot_pid="$(pm2 pid "${APP_NAME}" 2>/dev/null || true)"

  if ! is_gebot_backend_process "${owner_cmd}"; then
    return 0
  fi

  if [[ "${force}" == "1" ]]; then
    kill_backend_listener_pid "${port}" "${owner_pid}" "pre-start cleanup"
    return 0
  fi

  # Orphan node process from an old deploy — not tracked by PM2 gebot-backend.
  if [[ -z "${owner_app}" || "${owner_pid}" != "${gebot_pid}" ]]; then
    kill_backend_listener_pid "${port}" "${owner_pid}" "orphan process"
  fi
}

wait_for_health_commit() {
  local port="$1"
  local max_attempts="${2:-30}"
  local attempt commit
  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    commit="$(read_health_commit "${port}")"
    if [[ -n "${commit}" ]]; then
      echo "${commit}"
      return 0
    fi
    sleep 1
  done
  return 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f "package.json" || ! -d "backend" || ! -d "frontend" ]]; then
  fail "This script must be run from the GEBot repository root."
fi

# ---------------------------------------------------------------------------
# 1. Require .env before doing anything else
# ---------------------------------------------------------------------------
ENV_FILE=""
if [[ -f ".env" ]]; then
  ENV_FILE=".env"
elif [[ -f "backend/.env" ]]; then
  ENV_FILE="backend/.env"
else
  echo ""
  echo -e "${RED}╔══════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║  DEPLOYMENT ABORTED — .env file is missing                       ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "${RED}Create a .env file at the repository root OR in backend/.${NC}"
  echo -e "${RED}It must contain your Supabase and Mistral credentials.${NC}"
  echo ""
  echo "  nano .env"
  echo "  # or"
  echo "  nano backend/.env"
  echo ""
  echo "See DEPLOYMENT_GUIDE.md for the full list of required variables."
  echo ""
  exit 1
fi

log "Using environment file: ${ENV_FILE}"

# ---------------------------------------------------------------------------
# 2. Pull latest code from GitHub
# ---------------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  fail "git is not installed. Run: sudo apt-get update && sudo apt-get install -y git"
fi

if [[ ! -d ".git" ]]; then
  fail "Not a git repository. Clone the project before running this script."
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ -z "${GEBOT_DEPLOY_SYNCED:-}" ]]; then
  DEPLOY_START_HEAD="$(git rev-parse HEAD)"
  log "Syncing code to origin/${CURRENT_BRANCH} (fetch + reset — avoids chmod/local drift)..."
  git fetch origin "${CURRENT_BRANCH}"
  git reset --hard "origin/${CURRENT_BRANCH}"
  DEPLOY_END_HEAD="$(git rev-parse HEAD)"
  if [[ "${DEPLOY_START_HEAD}" != "${DEPLOY_END_HEAD}" ]]; then
    log "Code updated (${DEPLOY_START_HEAD:0:7} → ${DEPLOY_END_HEAD:0:7}) — re-running deploy with latest script..."
    export GEBOT_DEPLOY_SYNCED=1
    exec bash "${SCRIPT_DIR}/deploy_ubuntu.sh" "$@"
  fi
else
  log "Deploying synced commit $(git rev-parse --short HEAD)..."
fi

# ---------------------------------------------------------------------------
# 3. Install Node.js v20 if missing
# ---------------------------------------------------------------------------
install_node() {
  if ! command -v curl >/dev/null 2>&1; then
    log "Installing curl..."
    sudo apt-get update
    sudo apt-get install -y curl ca-certificates gnupg
  fi

  log "Installing Node.js ${NODE_MAJOR}.x via NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
}

if ! command -v node >/dev/null 2>&1; then
  install_node
else
  NODE_VERSION="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [[ "${NODE_VERSION}" -lt "${NODE_MAJOR}" ]]; then
    warn "Node.js v${NODE_VERSION} detected; upgrading to v${NODE_MAJOR}..."
    install_node
  fi
fi

log "Node.js $(node -v) / npm $(npm -v)"

# ---------------------------------------------------------------------------
# 4. Install PM2 globally if missing
# ---------------------------------------------------------------------------
if ! command -v pm2 >/dev/null 2>&1; then
  log "Installing PM2 globally..."
  sudo npm install -g pm2
fi

log "PM2 $(pm2 -v)"

# ---------------------------------------------------------------------------
# 5. Install dependencies
# ---------------------------------------------------------------------------
log "Installing npm dependencies (root, backend, frontend)..."
npm install
npm install --prefix backend
npm install --prefix frontend

# ---------------------------------------------------------------------------
# 6. Build frontend widget + internal test page
# ---------------------------------------------------------------------------
log "Building frontend widget..."
npm run build --prefix frontend

log "Test page (frontend/dist/index.html) is produced by npm run build --prefix frontend"

# ---------------------------------------------------------------------------
# 7. Build backend
# ---------------------------------------------------------------------------
log "Building backend..."
npm run build --prefix backend

DEPLOY_COMMIT="$(git rev-parse --short HEAD)"
DEPLOY_BUILT_AT="$(date -Iseconds)"
cat > backend/dist/build-info.json <<EOF
{"commit":"${DEPLOY_COMMIT}","builtAt":"${DEPLOY_BUILT_AT}"}
EOF
log "Build stamp: commit ${DEPLOY_COMMIT} at ${DEPLOY_BUILT_AT}"

if [[ ! -f "backend/dist/server.js" ]]; then
  fail "Backend build failed — backend/dist/server.js was not created."
fi

# ---------------------------------------------------------------------------
# 8. Start PM2 process (delete + start — restart can keep stale script/port binding)
# ---------------------------------------------------------------------------
BACKEND_PORT="$(grep -E '^PORT=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
BACKEND_PORT="${BACKEND_PORT:-8787}"

RESTART_COUNT="$(pm2 jlist 2>/dev/null | sed -n "s/.*\"name\":\"${APP_NAME}\".*\"restart_time\":\([0-9]*\).*/\1/p" | head -1 || true)"
if [[ -n "${RESTART_COUNT}" && "${RESTART_COUNT}" -gt 50 ]]; then
  warn "PM2 '${APP_NAME}' has ${RESTART_COUNT} restarts — often caused by PORT ${BACKEND_PORT} already in use."
fi

warn_port_conflict "${BACKEND_PORT}"

if pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
  log "Recreating PM2 process '${APP_NAME}' (stop → release port → delete → start)..."
  pm2 stop "${APP_NAME}" || true
  wait_for_port_free "${BACKEND_PORT}" 15 || true
  pm2 delete "${APP_NAME}" || true
  wait_for_port_free "${BACKEND_PORT}" 10 || true
else
  log "Starting PM2 process '${APP_NAME}'..."
fi

release_stale_backend_listener "${BACKEND_PORT}" 1
if [[ -n "$(port_listener_pid "${BACKEND_PORT}")" ]]; then
  warn_port_conflict "${BACKEND_PORT}"
  fail "Port ${BACKEND_PORT} is still in use — cannot start ${APP_NAME}."
fi

pm2 start ecosystem.config.js

pm2 save
log "PM2 process list saved."

log "Waiting for backend /health on port ${BACKEND_PORT} (up to 30s)..."
RUNNING_COMMIT="$(wait_for_health_commit "${BACKEND_PORT}" 30 || true)"
if [[ -z "${RUNNING_COMMIT}" ]]; then
  warn_port_conflict "${BACKEND_PORT}"
  echo ""
  echo "  pm2 status"
  pm2 status "${APP_NAME}" 2>/dev/null || true
  echo ""
  echo "  Recent logs:"
  pm2 logs "${APP_NAME}" --lines 30 --nostream 2>/dev/null || true
  fail "Backend /health unreachable after PM2 start — see logs above."
fi
if [[ "${RUNNING_COMMIT}" != "${DEPLOY_COMMIT}" ]]; then
  warn_port_conflict "${BACKEND_PORT}"
  echo ""
  echo -e "${RED}╔══════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║  DEPLOY FAILED — /health reports a different commit than the build ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "  Expected commit (git/build):  ${DEPLOY_COMMIT}"
  echo "  Running commit (/health):     ${RUNNING_COMMIT:-<missing>}"
  echo ""
  echo "  Diagnose on the server:"
  echo "    ss -tlnp sport = :${BACKEND_PORT}"
  echo "    pm2 logs ${APP_NAME} --lines 50 --nostream"
  echo "    pm2 describe ${APP_NAME}"
  echo ""
  echo "  If an orphan GEBot node process owns port ${BACKEND_PORT} (not in pm2 status):"
  echo "    ss -tlnp sport = :${BACKEND_PORT}"
  echo "    kill <PID>    # then ./deploy_ubuntu.sh again"
  echo ""
  echo "  If another PM2 app owns port ${BACKEND_PORT}:"
  echo "    pm2 stop <app-name>    # only if it is an obsolete duplicate"
  echo "    pm2 delete ${APP_NAME} && pm2 start ecosystem.config.js && pm2 save"
  echo "    curl -s http://127.0.0.1:${BACKEND_PORT}/health"
  echo ""
  fail "Health commit mismatch — bot answers will NOT match the new code until PM2/port conflict is fixed."
fi
log "Health check OK — running commit ${RUNNING_COMMIT} matches build ${DEPLOY_COMMIT}"

# ---------------------------------------------------------------------------
# 9. Generate Nginx configuration (placeholders replaced)
# ---------------------------------------------------------------------------
read_env_var() {
  grep -E "^${1}=" "${ENV_FILE}" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || true
}

BACKEND_PORT="$(read_env_var PORT)"
BACKEND_PORT="${BACKEND_PORT:-8787}"

GEBOT_NGINX_PORT="$(read_env_var GEBOT_NGINX_PORT)"
GEBOT_NGINX_PORT="${GEBOT_NGINX_PORT:-80}"

GEBOT_SERVER_NAME="$(read_env_var GEBOT_SERVER_NAME)"
GEBOT_SERVER_NAME="${GEBOT_SERVER_NAME:-gebot.pn2.geb}"

generate_nginx_config() {
  sed \
    -e "s|__DEPLOY_ROOT__|${SCRIPT_DIR}|g" \
    -e "s|__SERVER_NAME__|${GEBOT_SERVER_NAME}|g" \
    -e "s|__NGINX_PORT__|${GEBOT_NGINX_PORT}|g" \
    -e "s|__BACKEND_PORT__|${BACKEND_PORT}|g" \
    nginx.conf.template
}

log "Generating Nginx configuration (nginx.conf.generated)..."
generate_nginx_config > nginx.conf.generated
log "Wrote ${SCRIPT_DIR}/nginx.conf.generated"

if command -v nginx >/dev/null 2>&1; then
  if sudo -n true 2>/dev/null; then
    log "Installing Nginx site configuration..."
    generate_nginx_config | sudo tee /etc/nginx/sites-available/gebot >/dev/null
    sudo ln -sf /etc/nginx/sites-available/gebot /etc/nginx/sites-enabled/gebot
    NGINX_TEST_OUTPUT="$(sudo nginx -t 2>&1)" || true
    if echo "${NGINX_TEST_OUTPUT}" | grep -q "syntax is ok"; then
      if echo "${NGINX_TEST_OUTPUT}" | grep -q "conflicting server name"; then
        warn "Nginx reports conflicting server_name — another site already uses this name/port."
        echo "${NGINX_TEST_OUTPUT}" | grep "conflicting server name" || true
        warn "Use a unique GEBOT_SERVER_NAME (e.g. gebot.pn2.geb) — do not add the VM IP if another site already uses it."
        warn "Optional fallback: GEBOT_NGINX_PORT=8780 in .env to serve GEBot on a dedicated port."
      fi
      sudo systemctl reload nginx
      log "Nginx reloaded (http://<host>:${GEBOT_NGINX_PORT}/, server_name: ${GEBOT_SERVER_NAME})."
    else
      warn "Nginx config test failed — fix nginx.conf.generated before reloading."
      echo "${NGINX_TEST_OUTPUT}" || true
    fi
  else
    warn "Passwordless sudo unavailable — install Nginx config manually:"
    echo "  sudo cp nginx.conf.generated /etc/nginx/sites-available/gebot"
    echo "  sudo ln -sf /etc/nginx/sites-available/gebot /etc/nginx/sites-enabled/gebot"
    echo "  sudo nginx -t && sudo systemctl reload nginx"
  fi
else
  warn "Nginx not installed — see DEPLOYMENT_GUIDE.md step 5."
fi

NGINX_PUBLIC_URL="http://${GEBOT_SERVER_NAME%% *}"
if [[ "${GEBOT_NGINX_PORT}" != "80" ]]; then
  NGINX_PUBLIC_URL="${NGINX_PUBLIC_URL}:${GEBOT_NGINX_PORT}"
fi

# ---------------------------------------------------------------------------
# 10. Summary
# ---------------------------------------------------------------------------
echo ""
log "Deployment complete."
echo "  - Git commit:     ${DEPLOY_COMMIT}"
echo "  - Backend build:  ${DEPLOY_BUILT_AT}"
echo "  - Verify deploy:  curl -s http://127.0.0.1:${BACKEND_PORT}/health | head -c 400"
echo "    (commit + supabase + productKnowledgeFr must match expectations)"
echo "  - Backend (PM2):  ${APP_NAME} → http://127.0.0.1:${BACKEND_PORT}"
echo "  - Health check:   http://127.0.0.1:${BACKEND_PORT}/health"
echo "  - Widget bundle:  ${SCRIPT_DIR}/frontend/dist/gebot-widget.js"
echo "  - Nginx config:   ${SCRIPT_DIR}/nginx.conf.generated"
echo "  - Test page URL:  ${NGINX_PUBLIC_URL}/"
echo ""
echo "  pm2 status"
echo "  pm2 logs ${APP_NAME}"
echo ""
warn "Do NOT use 'pm2 restart all' for GEBot updates — it skips rebuild and may restart unrelated apps."
warn "Always use: ./deploy_ubuntu.sh  (or: git pull && ./deploy_ubuntu.sh)"
echo ""

if [[ -x "${SCRIPT_DIR}/scripts/verify-deploy.sh" ]]; then
  log "Running post-deploy verification..."
  "${SCRIPT_DIR}/scripts/verify-deploy.sh" || warn "verify-deploy.sh reported issues — see output above"
fi
