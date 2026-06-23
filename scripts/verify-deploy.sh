#!/usr/bin/env bash
#
# GEBot — post-deploy verification (run on the Ubuntu VM from repo root).
# Usage: ./scripts/verify-deploy.sh
#
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok() { echo -e "${GREEN}[verify] OK${NC} $*"; }
warn() { echo -e "${YELLOW}[verify] WARN${NC} $*"; }
fail() { echo -e "${RED}[verify] FAIL${NC} $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE=""
if [[ -f ".env" ]]; then
  ENV_FILE=".env"
elif [[ -f "backend/.env" ]]; then
  ENV_FILE="backend/.env"
else
  fail ".env missing at repo root or backend/.env"
fi

read_env_var() {
  grep -E "^${1}=" "${ENV_FILE}" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || true
}

BACKEND_PORT="$(read_env_var PORT)"
BACKEND_PORT="${BACKEND_PORT:-8787}"
GEBOT_SERVER_NAME="$(read_env_var GEBOT_SERVER_NAME)"
GEBOT_SERVER_NAME="${GEBOT_SERVER_NAME:-gebot.pn2.geb}"
GEBOT_NGINX_PORT="$(read_env_var GEBOT_NGINX_PORT)"
GEBOT_NGINX_PORT="${GEBOT_NGINX_PORT:-80}"

HEALTH_DETAIL_TOKEN="$(read_env_var HEALTH_DETAIL_TOKEN)"
LOCAL_HEALTH="http://127.0.0.1:${BACKEND_PORT}/health"
LOCAL_HEALTH_DETAIL="http://127.0.0.1:${BACKEND_PORT}/health/detail"
if [[ -n "${HEALTH_DETAIL_TOKEN}" ]]; then
  LOCAL_HEALTH_DETAIL="${LOCAL_HEALTH_DETAIL}?token=${HEALTH_DETAIL_TOKEN}"
fi
if [[ "${GEBOT_NGINX_PORT}" == "80" ]]; then
  PUBLIC_HEALTH="http://${GEBOT_SERVER_NAME%% *}/health"
  PUBLIC_HEALTH_DETAIL="http://${GEBOT_SERVER_NAME%% *}/health/detail"
else
  PUBLIC_HEALTH="http://${GEBOT_SERVER_NAME%% *}:${GEBOT_NGINX_PORT}/health"
  PUBLIC_HEALTH_DETAIL="http://${GEBOT_SERVER_NAME%% *}:${GEBOT_NGINX_PORT}/health/detail"
fi
if [[ -n "${HEALTH_DETAIL_TOKEN}" ]]; then
  PUBLIC_HEALTH_DETAIL="${PUBLIC_HEALTH_DETAIL}?token=${HEALTH_DETAIL_TOKEN}"
fi

GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo "?")"

echo ""
echo "=== GEBot deploy verification ==="
echo "  Git HEAD:        ${GIT_COMMIT}"
echo "  Backend direct:  ${LOCAL_HEALTH}"
echo "  Health detail:   ${LOCAL_HEALTH_DETAIL}"
echo "  Via Nginx:       ${PUBLIC_HEALTH}"
echo ""

if ! command -v curl >/dev/null 2>&1; then
  fail "curl is not installed"
fi

fetch_health() {
  curl -sf --max-time 10 "$1" 2>/dev/null || echo ""
}

LOCAL_JSON="$(fetch_health "${LOCAL_HEALTH}")"
DETAIL_JSON="$(fetch_health "${LOCAL_HEALTH_DETAIL}")"
if [[ -z "${LOCAL_JSON}" ]]; then
  fail "Cannot reach backend at ${LOCAL_HEALTH} — is gebot-backend online? (pm2 status)"
fi

echo "Direct backend /health:"
echo "${LOCAL_JSON}"
echo ""

if [[ -n "${DETAIL_JSON}" ]]; then
  echo "Direct backend /health/detail:"
  echo "${DETAIL_JSON}"
  echo ""
fi

parse_field() {
  local json="$1"
  local field="$2"
  if command -v jq >/dev/null 2>&1; then
    echo "${json}" | jq -r "${field} // empty"
  elif command -v python3 >/dev/null 2>&1; then
    echo "${json}" | python3 -c "import json,sys; d=json.load(sys.stdin); k='${field}'.lstrip('.').split('.'); v=d
for p in k: v=v.get(p) if isinstance(v,dict) else None
print(v if v is not None else '')"
  else
    echo ""
  fi
}

HEALTH_COMMIT="$(parse_field "${DETAIL_JSON}" ".commit")"
PK_FR="$(parse_field "${DETAIL_JSON}" ".productKnowledgeFr")"
CATALOG_READY="$(parse_field "${DETAIL_JSON}" ".catalogReady")"
RETRIEVAL_VER="$(parse_field "${DETAIL_JSON}" ".retrieval.version")"
G110_LOOKUP="$(parse_field "${DETAIL_JSON}" ".retrieval.g110SheetLookup")"
CREME_LUSTRANTE="$(parse_field "${DETAIL_JSON}" ".retrieval.cremeLustranteInCatalog")"
POELE_SLUG="$(parse_field "${DETAIL_JSON}" ".retrieval.poeleOpenRecommendationSlug")"

if [[ -z "${HEALTH_COMMIT}" ]]; then
  if echo "${LOCAL_JSON}" | grep -qE '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    HEALTH_COMMIT="$(pm2 logs gebot-backend --lines 50 --nostream 2>/dev/null \
      | sed -n "s/.*commit: '\([^']*\)'.*/\1/p" | tail -1)"
    if [[ -n "${HEALTH_COMMIT}" ]]; then
      warn "Minimal /health — commit read from PM2 startup logs"
    else
      warn "Minimal /health only — set HEALTH_DETAIL_TOKEN in ${ENV_FILE} for /health/detail verification"
      HEALTH_COMMIT="${GIT_COMMIT}"
    fi
  else
    fail "Cannot parse /health response"
  fi
fi

if [[ "${HEALTH_COMMIT}" != "${GIT_COMMIT}" ]]; then
  fail "Health commit (${HEALTH_COMMIT}) != git HEAD (${GIT_COMMIT}) — PM2 still runs old dist/. Fix: pm2 delete gebot-backend && pm2 start ecosystem.config.js && pm2 save"
else
  ok "Commit matches git HEAD (${GIT_COMMIT})"
fi

if [[ -n "${DETAIL_JSON}" ]]; then
  if [[ "${PK_FR}" == "0" || -z "${PK_FR}" || "${PK_FR}" == "null" ]]; then
    fail "productKnowledgeFr=${PK_FR:-null} — catalog empty, bot uses vector-only (wrong G110 answers). Fix: cd backend && npm run synthesize-products"
  else
    ok "productKnowledgeFr=${PK_FR}"
  fi

  if [[ "${CATALOG_READY}" != "true" ]]; then
    warn "catalogReady is not true — check PRODUCT_KNOWLEDGE_ENABLED in ${ENV_FILE}"
  fi

  EXPECTED_RETRIEVAL_VER="2026-06-12-cross-catalog-poele-accent"
  if [[ -n "${RETRIEVAL_VER}" && "${RETRIEVAL_VER}" != "${EXPECTED_RETRIEVAL_VER}" ]]; then
    fail "retrieval.version=${RETRIEVAL_VER} — expected ${EXPECTED_RETRIEVAL_VER} (PM2 still on old build)"
  else
    ok "retrieval.version=${RETRIEVAL_VER}"
  fi

  if [[ "${CREME_LUSTRANTE}" == "true" ]]; then
    ok "cremeLustranteInCatalog=true"
  else
    fail "cremeLustranteInCatalog=${CREME_LUSTRANTE:-missing} — run: npm run synthesize-products --prefix backend"
  fi

  if [[ "${POELE_SLUG}" == "creme-lustrante" ]]; then
    ok "poeleOpenRecommendationSlug=creme-lustrante"
  else
    fail "poeleOpenRecommendationSlug=${POELE_SLUG:-missing} — poêle routing broken on this build"
  fi

  if [[ "${G110_LOOKUP}" == "g110-inhibiteur-universel" ]]; then
    ok "G110 fiche lookup resolves to g110-inhibiteur-universel"
  else
    warn "G110 sheet lookup slug=${G110_LOOKUP:-missing} — expected g110-inhibiteur-universel"
  fi
else
  warn "Skipping catalog probes — configure HEALTH_DETAIL_TOKEN and retry /health/detail"
fi

PUBLIC_JSON="$(fetch_health "${PUBLIC_HEALTH}")"
PUBLIC_DETAIL_JSON="$(fetch_health "${PUBLIC_HEALTH_DETAIL}")"
if [[ -z "${PUBLIC_JSON}" ]]; then
  warn "Cannot reach ${PUBLIC_HEALTH} — Nginx may not be configured or reloaded"
  echo "  sudo cp nginx.conf.generated /etc/nginx/sites-available/gebot"
  echo "  sudo ln -sf /etc/nginx/sites-available/gebot /etc/nginx/sites-enabled/gebot"
  echo "  sudo nginx -t && sudo systemctl reload nginx"
else
  echo "Nginx /health:"
  echo "${PUBLIC_JSON}"
  echo ""
  if [[ -n "${PUBLIC_DETAIL_JSON}" && -n "${DETAIL_JSON}" ]]; then
    PUBLIC_COMMIT="$(parse_field "${PUBLIC_DETAIL_JSON}" ".commit")"
    DIRECT_COMMIT="$(parse_field "${DETAIL_JSON}" ".commit")"
    if [[ -n "${PUBLIC_COMMIT}" && -n "${DIRECT_COMMIT}" && "${PUBLIC_COMMIT}" != "${DIRECT_COMMIT}" ]]; then
      fail "Nginx proxies to a DIFFERENT backend (nginx commit=${PUBLIC_COMMIT}, direct=${DIRECT_COMMIT}). Check proxy_pass port in /etc/nginx/sites-enabled/"
    else
      ok "Nginx and direct backend report the same commit (via /health/detail)"
    fi
  else
    LOCAL_VERSION="$(parse_field "${LOCAL_JSON}" ".version")"
    PUBLIC_VERSION="$(parse_field "${PUBLIC_JSON}" ".version")"
    if [[ -n "${LOCAL_VERSION}" && "${PUBLIC_VERSION}" != "${LOCAL_VERSION}" ]]; then
      fail "Nginx /health version (${PUBLIC_VERSION}) != direct (${LOCAL_VERSION})"
    else
      ok "Nginx /health version matches direct backend"
    fi
  fi
fi

if pm2 describe gebot-backend >/dev/null 2>&1; then
  PM2_SCRIPT="$(pm2 describe gebot-backend 2>/dev/null | grep 'script path' | sed 's/.*│ //;s/ │.*//' | xargs || true)"
  ok "PM2 gebot-backend script: ${PM2_SCRIPT:-unknown}"
else
  warn "PM2 process gebot-backend not found"
fi

echo ""
echo "Optional: run retrieval regression on the VM:"
echo "  npm run retrieval-regression --prefix backend"
echo ""
ok "Verification finished"
