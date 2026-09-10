# Tradone (web)

Local-first portfolio dashboard. Your data — accounts, expenses, wallet
addresses — lives encrypted in your browser's IndexedDB, unlocked with a
passphrase that never leaves your device. This repo has two independently
deployable pieces:

- **The page itself** (`index.html`, `app.js`, `storage.js`, `styles.css`,
  `manifest.json`, `service-worker.js`) — a static PWA. Holds no secrets,
  needs no server of its own to serve it beyond static file hosting.
- **The relay** (`server.js`) — a small stateless Express API that proxies
  Avanza, PayPal, crypto-chain, and news lookups. Holds no database and no
  per-user state; every visitor's own session/data lives in their vault, not
  here.

## Deploying the page — GitHub Pages

1. Push this repo to GitHub (see below).
2. Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch:
   `main`, folder `/ (root)` → Save.
3. GitHub gives you a URL like `https://<username>.github.io/<repo>/` within
   a minute or two.

## Deploying the relay — Render

1. [render.com](https://render.com) → **New → Web Service** → connect this
   same GitHub repo.
2. Render should auto-detect `render.yaml` (Root Directory: leave blank if
   this repo *is* the `web/` folder). If it doesn't, set manually:
   Build Command `npm install`, Start Command `node server.js`.
3. Under **Environment**, add the two required variables (get free keys at
   the URLs below — do **not** commit real values into this repo):
   - `COINGECKO_API_KEY` — https://www.coingecko.com/en/api/pricing (Demo plan)
   - `ETHERSCAN_API_KEY` — https://etherscan.io/apis
4. Deploy. Render assigns a URL like `https://tradone-relay.onrender.com`
   (based on the service name you pick — matching it exactly saves a step).
5. **Update `app.js`**'s `API_BASE` production line to that exact URL, then
   push again — the deployed page needs to know where its relay lives.

Free-tier note: Render's free plan sleeps after ~15 minutes idle — the first
request after that has a 10-30s cold-start delay while it wakes back up.

## Local development

Two terminals:

```powershell
# Terminal 1 — the relay
$env:COINGECKO_API_KEY = "..."
$env:ETHERSCAN_API_KEY = "..."
node server.js

# Terminal 2 — the static page
node dev-server.js
```

Then open http://localhost:8080.

## Importing from the original (local-only) Tradone app

The first-run screen offers "Import from your existing Tradone" — point it
at your original app's server (`node server.js` from the project root,
default `http://localhost:3001`) and your existing username/password. It
pulls your accounts/expenses/wallets into this build's encrypted vault. Your
trade journal is not imported — this build has no Trading tab.
