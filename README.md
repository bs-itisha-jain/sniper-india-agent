# Sniper India Agent

Zerodha **GTT order** app, rebuilt as a deployable **React + Node** project.

- **Single shared login** — one username/password (in `backend/.env`) for every user.
- **One shared Zerodha access token** — stored server-side in `backend/data/token.json`.
  Every logged-in user's requests use that same token.
- **Automated daily refresh** — a cron job runs every day at **08:00 Asia/Kolkata**,
  does a headless Zerodha login (password + TOTP 2FA), generates a fresh
  `access_token`, and saves it. Also refreshes on startup if the stored token is
  missing or stale.

```
sniper-india-agent/
├── backend/            Node + Express API
│   ├── src/
│   │   ├── server.js            app entry
│   │   ├── config.js            env config
│   │   ├── middleware/auth.js   JWT (shared login)
│   │   ├── routes/              auth, market (/ltp), orders (/order, GTT), token
│   │   └── services/
│   │       ├── zerodhaAutoLogin.js  headless TOTP login → request_token → access_token
│   │       ├── scheduler.js         node-cron 08:00 IST + startup refresh
│   │       ├── tokenStore.js        persists token.json
│   │       └── kiteClient.js        KiteConnect bound to the shared token
│   ├── data/           token.json lives here (git-ignored)
│   └── .env.example
├── frontend/           React (Vite)
│   ├── src/
│   │   ├── pages/       Login, Dashboard
│   │   ├── components/  GttForm, GttPreview, History, TokenStatus
│   │   ├── context/AuthContext.jsx
│   │   └── api/client.js
│   └── .env.example
└── package.json        convenience scripts
```

## 1. Prerequisites

- Node.js 18+ (tested on 20 / 24)
- A **Zerodha Kite Connect** app (https://developers.kite.trade/apps) — note its
  **API key**, **API secret**, and set its **Redirect URL** to anything you control
  (e.g. `http://127.0.0.1/`; the backend only needs to read `request_token` off the
  redirect, it never has to be reachable).
- An **external TOTP authenticator** enabled on the Zerodha account. When you set it
  up, save the **base32 secret** (not just the 6-digit code) — that goes in
  `ZERODHA_TOTP_SECRET`.

## 2. Configure

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Edit `backend/.env`:

| var | meaning |
|---|---|
| `APP_USERNAME` / `APP_PASSWORD` | the shared login for the web UI |
| `JWT_SECRET` | long random string |
| `KITE_API_KEY` / `KITE_API_SECRET` | from the Kite developer console |
| `ZERODHA_USER_ID` / `ZERODHA_PASSWORD` | the Zerodha account login |
| `ZERODHA_TOTP_SECRET` | base32 secret for the authenticator |
| `TOKEN_REFRESH_CRON` | default `0 8 * * *` (08:00 daily) |
| `TZ` | default `Asia/Kolkata` |

> The old `app.py` had live API keys committed to git. **Rotate them** in the Kite
> console before using them here.

## 3. Run locally

```bash
npm run install:all          # installs backend + frontend deps

npm run dev:backend          # http://localhost:5000
npm run dev:frontend         # http://localhost:5173  (proxies /api → :5000)
```

Open http://localhost:5173, sign in with `APP_USERNAME` / `APP_PASSWORD`.

Generate the first token without waiting for 8 AM:

```bash
npm --prefix backend run refresh-token
# or, once logged in, click "Refresh token now" in the UI
# or: curl -X POST http://localhost:5000/api/token/refresh  (needs auth cookie)
```

## 4. API

All `/api/*` routes except `/api/auth/*` require the login cookie / `Authorization: Bearer <jwt>`.

| method | path | purpose |
|---|---|---|
| POST | `/api/auth/login` | `{ username, password }` → sets cookie + returns JWT |
| POST | `/api/auth/logout` | clears cookie |
| GET  | `/api/auth/me` | current user |
| GET  | `/api/ltp?symbol=RELIANCE` | last traded price |
| GET  | `/api/instruments/search?q=reliance` | resolve a company name / ticker to tradable symbols |
| POST | `/api/order` | create single-leg GTT — `{ symbol, action, quantity, trigger_price, price, product }` |
| GET  | `/api/orders/gtt` | list existing GTTs |
| GET  | `/api/token/status` | token freshness, expiry, scheduler + retry state |
| POST | `/api/token/refresh` | force an automatic refresh now |
| GET  | `/api/token/login-url` | Kite login URL for the manual fallback |
| POST | `/api/token/manual` | exchange a pasted `request_token` for an access token |
| GET  | `/health` | unauthenticated health check |

Errors carry a machine-readable `code` alongside `error`, so the UI can show the
right state instead of a generic message:

`no_token` · `token_expired` · `invalid_symbol` · `invalid_input` · `connection` ·
`forbidden` · `api_error`

### Token lifecycle

Zerodha invalidates every access token at ~07:30 IST daily, so freshness is
derived from that boundary rather than a fixed age — a token minted at 06:30 IST
is correctly treated as expiring an hour later, not 20 hours later.

- **Scheduled** — cron at 08:00 IST (`TOKEN_REFRESH_CRON`).
- **On boot** — refreshes if the stored token is missing or past its boundary, so
  a restart or reboot at any hour recovers on its own.
- **On rejection** — if Kite rejects the token mid-session, the call transparently
  re-logs-in once and replays itself; the user sees no error.
- **On failure** — automatic retries at 1m, 5m, 15m and 30m before giving up until
  the next scheduled run.
- **Manual fallback** — if the headless login genuinely can't complete (Zerodha asks
  for extra confirmation), the UI reveals the old two-step flow: open the Kite login
  URL, paste the `request_token` back. This is the only path that needs a human.

The `access_token` itself never leaves the backend — `/api/token/status` returns
metadata only.

## 5. Deployment notes (to finalise later)

- Build the frontend (`npm run build:frontend`) and serve `frontend/dist/` as static
  files; run the backend with `npm --prefix backend start`.
- Set `NODE_ENV=production`, a real `CORS_ORIGIN`, and serve over HTTPS
  (cookies are `Secure` + `SameSite=None` in production).
- Persist `backend/data/` (disk) so the token survives redeploys.
- Ensure the host timezone or `TZ` is `Asia/Kolkata` so the 08:00 cron fires at the
  right time.
- If the platform sleeps idle processes, the in-process cron won't fire — use the
  platform's own scheduler to hit `POST /api/token/refresh` or run
  `npm run refresh-token` instead.
