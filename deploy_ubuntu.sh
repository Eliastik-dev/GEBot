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
log "Pulling latest code (origin/${CURRENT_BRANCH})..."
git pull origin "${CURRENT_BRANCH}"

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

log "Generating internal test interface (frontend/dist/index.html)..."
cat > frontend/dist/index.html <<'EOF'
<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GEBot — Interface de test interne</title>
    <style>
      html, body { margin: 0; min-height: 100vh; font-family: system-ui, sans-serif; background: #f4f6f8; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script src="/gebot-widget.js"></script>
    <script>
      (function () {
        var root = document.getElementById("root");
        if (!root || !window.GEBOT_WIDGET) return;
        window.GEBOT_WIDGET.mount({
          target: root,
          apiBaseUrl: "",
        });
      })();
    </script>
  </body>
</html>
EOF

# ---------------------------------------------------------------------------
# 7. Build backend
# ---------------------------------------------------------------------------
log "Building backend..."
npm run build --prefix backend

if [[ ! -f "backend/dist/server.js" ]]; then
  fail "Backend build failed — backend/dist/server.js was not created."
fi

# ---------------------------------------------------------------------------
# 8. Start or reload PM2 process
# ---------------------------------------------------------------------------
if pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
  log "Reloading PM2 process '${APP_NAME}' (zero-downtime)..."
  pm2 reload ecosystem.config.js
else
  log "Starting PM2 process '${APP_NAME}'..."
  pm2 start ecosystem.config.js
fi

pm2 save
log "PM2 process list saved."

# ---------------------------------------------------------------------------
# 9. Summary
# ---------------------------------------------------------------------------
BACKEND_PORT="$(grep -E '^PORT=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
BACKEND_PORT="${BACKEND_PORT:-8787}"

echo ""
log "Deployment complete."
echo "  - Backend (PM2):  ${APP_NAME} → http://127.0.0.1:${BACKEND_PORT}"
echo "  - Health check:   http://127.0.0.1:${BACKEND_PORT}/health"
echo "  - Widget bundle:  ${SCRIPT_DIR}/frontend/dist/gebot-widget.js"
echo "  - Test page:      configure Nginx to serve ${SCRIPT_DIR}/frontend/dist/"
echo ""
echo "  pm2 status"
echo "  pm2 logs ${APP_NAME}"
echo ""
