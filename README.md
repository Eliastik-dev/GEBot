# GEBot (WP -> Supabase -> Chat Widget)

Monorepo:
- `backend/`: ingestion WordPress -> Supabase (pgvector) + API chat (SSE streaming)
- `frontend/`: widget React injecte dans WordPress (build **un seul fichier JS**)

## Backend

### 1) Variables d’environnement

Copiez/éditez `backend/.env`:
- `MISTRAL_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `WP_URL` (déjà défini)
- `WP_USER`, `WP_APP_PASSWORD` (optionnel si WP public)
- `AMAZON_STORE_URL` (optionnel, défaut `https://www.amazon.fr/stores/GEB`)
- `AMAZON_PRODUCT_URL_MAP` (JSON produit -> URL Amazon)
- `AMAZON_LINKS_DATA_DIR` (optionnel, répertoire contenant `amazon-links.fr.json` et `amazon-links.nl.json`, défaut `backend/data`)
- `WP_RESELLERS_ENDPOINT` (optionnel, endpoint API revendeurs WP)

### 2) Initialiser Supabase

Exécutez le SQL `supabase.sql` dans Supabase (SQL editor). La table utilise **`id uuid`** (requis par LlamaIndex) et la fonction RPC **`match_documents`** (nom fixe du package `@llamaindex/supabase`). Si vous aviez une ancienne table en `bigserial`, faites `DROP TABLE public.documents CASCADE;` puis ré-exécutez `supabase.sql` (voir aussi `supabase-migrate-bigint-to-uuid.sql`).

### 3) Ingestion

```bash
cd C:\Projets\geb-chatbot
npm run ingest
```

Si Mistral renvoie **429 / rate limit**: l’ingestion utilise maintenant **un appel API par lot** (plusieurs textes dans `inputs`) et une pause configurable. Variables optionnelles dans `backend/.env` :

- `MISTRAL_EMBED_BATCH_SIZE` (défaut `32`) — nombre de chunks par requête d’embeddings
- `MISTRAL_EMBED_MIN_INTERVAL_MS` (défaut `1100`) — délai minimum entre deux requêtes (ms), pour rester sous ~60 req/min sur l’offre gratuite

### 4) Lancer l’API

```bash
cd C:\Projets\geb-chatbot
npm run dev:backend
```

Endpoint:
- `POST http://localhost:8787/api/chat` (SSE streaming)

Body JSON:
```json
{
  "message": "Votre question technique",
  "sessionId": "uuid",
  "locale": "fr|en|nl|pl",
  "profile": "professional|particulier",
  "geoConsent": true,
  "geoCountry": "FR"
}
```

Le backend applique:
- onboarding profil (professionnel/particulier)
- synchronisation de langue avec locale du site + geolocalisation IP consentie
- boucle de clarification sur demandes vagues
- **routage catalogue** `product_knowledge` (prioritaire) puis repli RAG vectoriel allégé
- recommandation Amazon en priorite + liste "Find a store" (hors PL)
- lien Amazon place en fin de reponse (avec matching automatique via `backend/data/amazon-links.*.json`)
- handoff CTA vers support Lab/Consommateurs selon profil
- guardrails anti hors-sujet
- journalisation des requetes dans Supabase (`chat_queries`)
- tracking BI par recommandation dans `product_analytics` (produit, type de probleme, statut)
- feedback utilisateur (👍/👎) → `retrieval_feedback_events` pour améliorer le catalogue

### Architecture retrieval (4 phases)

```
Phase 1 — product_knowledge : synthèse batch des FT (~217 produits FR)
Phase 2 — Routage SQL par tags/intent avant le RAG vectoriel
Phase 3 — Feedback + judge + tests de régression (npm run retrieval-regression)
Phase 4 — VECTOR_RAG_LITE=auto : repli vectoriel sans patchs scénario (échappement, etc.)
Phase 4b — Routage catalogue tient compte du **profil** (pro/particulier) : sessions **professionnel** → masquage des fiches DIY (COLLE HAUTE PERFORMANCE, POOL*) et priorité **GEBSOPLAST** pour PVC/ABS ; sessions **particulier** → masquage des lignes **pro** (GEBSOPLAST…) et priorité grand public.
```

Scripts utiles (`cd backend`) :

```bash
npm run scrape                                             # WP produits + gamme product_cat → output/scrape-results.json
npm run realign-catalog-themes                             # réaligner theme/gamme en DB (sans LLM)
npm run audit-catalog-themes -- --locale fr                # rapport thèmes / incohérences
npm run migrate-themes                                     # re-tagger les chunks vectoriels
npm run ingest                                             # réindexer les PDF (après scrape)
npm run synthesize-products -- --locale fr --only-missing    # enrichir le catalogue
npm run retrieval-regression                               # golden cases (CI)
npm run export-feedback                                    # exporter les 👎
npm run apply-catalog-feedback                             # suggestions tags (dry-run)
npm run apply-catalog-feedback -- --apply                  # appliquer les tags suggérés
npm run convert-amazon-links                               # régénérer backend/data/amazon-links.*.json depuis Excel (nécessite xlsx temporaire)
```

Variables optionnelles dans `backend/.env` :
- `PRODUCT_KNOWLEDGE_ENABLED=false` — forcer le RAG vectoriel legacy
- `VECTOR_RAG_LITE=auto|true|false` — mode repli allégé (défaut `auto` si catalogue non vide)
- `PRODUCT_KNOWLEDGE_MAX_PRODUCTS=3` — nombre max de fiches injectées

## Frontend (Widget)

### Dev

```bash
cd C:\Projets\geb-chatbot
npm run dev:frontend
```

### Build (bundle unique)

```bash
cd C:\Projets\geb-chatbot
npm run build:frontend
```

Sortie:
- `frontend/dist/gebot-widget.js` (CSS injecte par JS)

### Intégration WordPress

Inclure le script, puis monter le widget:

```html
<div id="geb-chatbot-root"></div>
<script src="/path/to/gebot-widget.js"></script>
<script>
  window.GEBOT_WIDGET.mount({
    target: document.getElementById("geb-chatbot-root"),
    apiBaseUrl: "https://votre-backend.tld"
  });
</script>
```

