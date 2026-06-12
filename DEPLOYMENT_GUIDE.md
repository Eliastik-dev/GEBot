# GEBot — Ubuntu VM Deployment Guide

This guide walks through deploying the GEBot monorepo (Express backend + React/Vite widget) on a fresh **Ubuntu 22.04/24.04** virtual machine for internal testing. The application connects to your **existing external Supabase** project; no local database is required.

Repository: [https://github.com/Eliastik-dev/GEBot.git](https://github.com/Eliastik-dev/GEBot.git)

---

## Architecture overview

| Component | Role |
|-----------|------|
| **PM2** | Runs `backend/dist/server.js`, auto-restarts on failure |
| **Nginx** | Serves `frontend/dist/` (widget + test page), proxies `/api/` to the backend |
| **Supabase** | External hosted database (vectors, chat sessions, feedback) |
| **Mistral API** | LLM + embeddings (keys in `.env`) |

Default backend port: **8787** (override with `PORT` in `.env`).

---

## Prerequisites on the VM

- Ubuntu 22.04 or 24.04 with SSH access
- Outbound internet (GitHub, npm, Supabase, Mistral API)
- A Supabase project URL + service role key
- A Mistral API key

---

## Step 1 — Generate an SSH key and add it to GitHub

On the **Ubuntu VM**, log in as the user that will run the app (e.g. `deploy`):

```bash
# Generate a dedicated deploy key (no passphrase for unattended pulls)
ssh-keygen -t ed25519 -C "gebot-vm-deploy" -f ~/.ssh/id_ed25519_gebot -N ""

# Show the public key — copy the entire output
cat ~/.ssh/id_ed25519_gebot.pub
```

Add the public key to GitHub:

1. Open [GitHub → Settings → SSH and GPG keys](https://github.com/settings/keys)
2. Click **New SSH key**
3. Title: `GEBot Ubuntu VM`
4. Paste the public key and save

If the repository is private, also add the key as a **deploy key** on the repo:

1. Open [https://github.com/Eliastik-dev/GEBot/settings/keys](https://github.com/Eliastik-dev/GEBot/settings/keys)
2. **Add deploy key** → paste the same public key → enable **Allow read access**

Configure SSH to use this key for GitHub:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_gebot
  IdentitiesOnly yes
EOF

chmod 600 ~/.ssh/config

# Verify passwordless access
ssh -T git@github.com
```

You should see: `Hi <username>! You've successfully authenticated...`

---

## Step 2 — Clone the repository

```bash
# Install git if needed
sudo apt-get update
sudo apt-get install -y git

# Clone via SSH (recommended)
cd ~
git clone git@github.com:Eliastik-dev/GEBot.git
cd GEBot
```

---

## Step 3 — Create the `.env` file

The deploy script **refuses to run** without a `.env` file at the repository root **or** in `backend/`.

Create it at the project root (recommended):

```bash
nano .env
```

### Required variables

```env
# Mistral
MISTRAL_API_KEY=your_mistral_api_key

# Supabase (external hosted project)
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# WordPress source (product pages / resellers)
WP_URL=https://www.geb.fr
```

### Commonly used optional variables

```env
PORT=8787
SUPABASE_TABLE=documents
MISTRAL_CHAT_MODEL=mistral-small-latest
TOP_K=10
PRODUCT_KNOWLEDGE_ENABLED=true
VECTOR_RAG_LITE=auto

# WordPress Basic Auth (only if scraping protected endpoints)
WP_USER=
WP_APP_PASSWORD=

# Amazon / reseller links
AMAZON_STORE_URL=https://www.amazon.fr/s?k=GEB
WP_RESELLERS_ENDPOINT=/wp-json/wp/v2/resellers
```

Secure the file:

```bash
chmod 600 .env
```

> **Security:** Never commit `.env` to Git. It is already listed in `.gitignore`.

---

## Step 4 — Run the deployment script

```bash
chmod +x deploy_ubuntu.sh
./deploy_ubuntu.sh
```

The script will:

1. Verify `.env` exists
2. `git pull origin <current-branch>`
3. Install Node.js 20 and PM2 (if missing)
4. Run `npm install` in `backend/`, `frontend/`, and the repo root
5. Build the frontend widget and backend
6. Start or zero-downtime reload the PM2 process
7. Save the PM2 process list

### Verify the backend

```bash
pm2 status
pm2 logs gebot-backend

# Direct health check (bypasses Nginx)
curl http://127.0.0.1:8787/health
# Expected: {"ok":true}
```

---

## Step 5 — Configure Nginx (reverse proxy + static files)

Install Nginx:

```bash
sudo apt-get install -y nginx
```

Prepare the site configuration from the template:

```bash
cd ~/GEBot

# Replace placeholders — adjust paths and hostname to your VM
export DEPLOY_ROOT="$HOME/GEBot"
export SERVER_NAME="192.168.1.50"    # VM IP or internal DNS name
export BACKEND_PORT="8787"           # must match PORT in .env

sed \
  -e "s|__DEPLOY_ROOT__|${DEPLOY_ROOT}|g" \
  -e "s|__SERVER_NAME__|${SERVER_NAME}|g" \
  -e "s|__BACKEND_PORT__|${BACKEND_PORT}|g" \
  nginx.conf.template | sudo tee /etc/nginx/sites-available/gebot > /dev/null

sudo ln -sf /etc/nginx/sites-available/gebot /etc/nginx/sites-enabled/gebot

# Disable default site if it conflicts on port 80
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t
sudo systemctl enable nginx
sudo systemctl reload nginx
```

Open in a browser (from your internal network):

```
http://<SERVER_NAME>/
```

The test page loads the widget bundle and calls `/api/*` through Nginx on the same origin.

---

## Step 6 — PM2 startup on boot (recommended)

```bash
# Generate the systemd startup command (copy/paste the output it prints)
pm2 startup systemd -u "$USER" --hp "$HOME"

# Persist the current process list
pm2 save
```

---

## Updating the application

After pushing changes to GitHub:

```bash
cd ~/GEBot
./deploy_ubuntu.sh
```

`deploy_ubuntu.sh` runs `pm2 reload ecosystem.config.js` when the process is already running, enabling zero-downtime restarts.

> **Important — `git pull` alone is not enough.**  
> The server runs the **compiled** backend (`backend/dist/server.js`), not the TypeScript sources.  
> If you only run `git pull` without rebuilding, PM2 keeps serving the **previous build** — fixes in `src/` will not apply.  
> Local dev uses `tsx watch` (live sources); production always needs `npm run build --prefix backend` + `pm2 reload`.

### Verify the running version

```bash
curl -s http://127.0.0.1:8787/health
```

Example healthy response:

```json
{
  "ok": true,
  "commit": "60e5058",
  "builtAt": "2026-06-08T16:35:21+02:00",
  "port": 8787,
  "supabase": true,
  "productKnowledgeFr": 217,
  "productKnowledgeEnabled": true,
  "catalogReady": true,
  "retrieval": {
    "version": "2026-06-08-direct-sheet-citation",
    "g110InCatalog": true,
    "g110SheetLookup": "g110-inhibiteur-universel"
  }
}
```

Or run the automated checker after deploy:

```bash
chmod +x scripts/verify-deploy.sh
./scripts/verify-deploy.sh
```

| Field | Meaning |
|-------|---------|
| `commit` | Git revision actually deployed (must match `git log -1 --oneline` on the VM) |
| `supabase` | `false` → wrong URL/key or network issue; chat may work but sessions/feedback fail |
| `productKnowledgeFr` | `0` or `null` → catalog empty; responses are slower and less accurate (vector-only fallback) |
| `catalogReady` | `false` → direct G110 / fiche technique shortcuts are disabled |
| `retrieval.g110SheetLookup` | Must be `g110-inhibiteur-universel` when catalog is populated |

Rebuild the **frontend widget** too when UI changes (thumbs up/down live in `gebot-widget.js`):

```bash
npm run build --prefix frontend
sudo systemctl reload nginx   # if Nginx serves the widget
```

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `403 Forbidden` on `/` but `/gebot-widget.js` works | `frontend/dist/index.html` missing — run `npm run build --prefix frontend` (build now copies the test page automatically), then reload Nginx |
| `500` on `/favicon.ico` | Harmless before deploy; fixed in `nginx.conf.template` (`return 204`). Reload Nginx after updating the config |
| Deploy aborts immediately | `.env` missing — create it at root or `backend/.env` |
| `Missing required env var` in PM2 logs | Required keys absent from `.env` (`MISTRAL_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WP_URL`) |
| `502 Bad Gateway` from Nginx | `pm2 status` — is `gebot-backend` online? Does `PORT` in `.env` match `__BACKEND_PORT__` in Nginx? |
| Widget loads but chat fails (`403 Origin not allowed`) | CORS: add the page origin to `CORS_ALLOWED_ORIGINS` in `.env` (comma-separated). Test page on `http://gebot.pn2.geb` is allowed automatically when widget and API share the same Nginx host; WordPress embeds need `WP_URL` or explicit origins |
| Widget loads but chat fails (other) | Browser devtools → Network → `/api/chat` response; check `pm2 logs gebot-backend` |
| Fixes on GitHub but not on server | You likely ran `git pull` only — run `./deploy_ubuntu.sh` and check `curl /health` commit hash |
| Deploy fails: `/health` unreachable but PM2 logs show `Backend listening` | Production `/health` returns only `{"ok":true}` unless `HEALTH_DETAIL_TOKEN` is set in `.env`. The bot may still be fine — check `pm2 logs gebot-backend` for `[startup] commit`. Optional: add `HEALTH_DETAIL_TOKEN=<random>` to `.env` for full deploy verification |
| Deploy fails: expected commit ≠ `/health` commit | Another process owns `PORT`. Common case: **orphan** `node …/GEBot/backend/dist/server.js` (PID visible in `ss` but absent from `pm2 status`). Run `kill <PID>` then `./deploy_ubuntu.sh`. Or another PM2 app — stop it or change `PORT` in `.env` |
| `gebot-backend` thousands of PM2 restarts | Crash loop — usually `EADDRINUSE` because port 8787 is taken. See row above |
| `pm2 restart all` used before deploy | Restarts old compiled code without rebuild; use `./deploy_ubuntu.sh` only |
| Direct `/health` OK but site still wrong | Nginx not reloaded or proxies to another port/app — compare `curl 127.0.0.1:8787/health` vs `curl http://gebot.pn2.geb/health` |
| `productKnowledgeFr: 0` | Catalog empty on this Supabase project — run `npm run synthesize-products --prefix backend` on the VM |
| No thumbs up/down on answers | Rebuild frontend widget; backend must send `messageId` in SSE `done` event; Supabase must accept inserts |
| Slow responses | Check `/health` → `productKnowledgeFr` (should be ~200+); empty catalog forces heavy vector RAG + LLM |
| `git pull` authentication error | Re-run `ssh -T git@github.com`; verify deploy key on GitHub |

Useful commands:

```bash
pm2 status
pm2 logs gebot-backend --lines 100
sudo tail -f /var/log/nginx/gebot-error.log
curl -v http://127.0.0.1:8787/health
```

---

## File reference

| File | Purpose |
|------|---------|
| `ecosystem.config.js` | PM2 process definition; loads `.env` and runs `backend/dist/server.js` |
| `deploy_ubuntu.sh` | Idempotent install/update script for the VM |
| `nginx.conf.template` | Nginx server block — `/api/` → backend, `/` → widget test UI |
| `DEPLOYMENT_GUIDE.md` | This document |
