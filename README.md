# Sniper India Agent

Zerodha **GTT order** desk, built as a deployable **React + Node** project.

- **Open access** — no app login. Gate the deployment at the platform level
  (e.g. Vercel Deployment Protection) if you need one.
- **Two-leg OCO GTT** — the ticket places a linked stop-loss + target pair
  (default ±0.8% around your limit price, editable). Whichever hits first fires;
  the other is cancelled. It's a protective exit — you enter the position
  separately.
- **One shared Zerodha access token** — stored server-side in `backend/data/token.json`.
  Every request uses that token.
- **Manual token, once a day** — Zerodha kills every access token overnight
  (~07:30 IST). Paste a fresh one from the connect bar each morning. The app
  accepts either a raw `access_token` or the full Kite login redirect URL
  (it exchanges the `request_token` for you using your API key + secret).

```
sniper-india-agent/
├── backend/            Node + Express API
│   ├── src/
│   │   ├── server.js            app entry
│   │   ├── config.js            env config
│   │   ├── routes/              market (/ltp), orders (/order, GTT), token
│   │   └── services/
│   │       ├── kiteAuth.js      login URL + request_token → access_token exchange
│   │       ├── tokenStore.js    persists token.json, derives daily expiry
│   │       └── kiteClient.js    KiteConnect bound to the shared token
│   ├── data/           token.json lives here (git-ignored)
│   └── .env.example
├── frontend/           React (Vite)
│   ├── src/
│   │   ├── pages/Dashboard.jsx
│   │   ├── components/  ConnectBar, BrokerPill, SymbolSearch, TargetCard, OrderTicket, GttList
│   │   ├── context/     BrokerContext, GttContext
│   │   └── api/client.js
│   └── .env.example
├── render.yaml         Render Blueprint for the backend
└── package.json        convenience scripts
```

## 1. Prerequisites

- Node.js 18+ (tested on 20 / 24)
- A **Zerodha Kite Connect** app (https://developers.kite.trade/apps) — note its
  **API key** and **API secret**, and set its **Redirect URL** to anything you
  control (e.g. `http://127.0.0.1/`; the app only reads `request_token` off the
  redirect, the URL never has to be reachable).

## 2. Configure

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Edit `backend/.env`:

| var | meaning |
|---|---|
| `KITE_API_KEY` / `KITE_API_SECRET` | from the Kite developer console |
| `CORS_ORIGIN` | allowed frontend origin (exact, no trailing slash) |
| `NODE_ENV` / `PORT` | server basics |
| `TOKEN_FILE` | where the pasted token is persisted (default `./data/token.json`) |

## 3. Run locally

```bash
npm run install:all          # installs backend + frontend deps

npm run dev:backend          # http://localhost:5000
npm run dev:frontend         # http://localhost:5173  (proxies /api → :5000)
```

Open http://localhost:5173. In the connect bar, click **get a token ↗**, log in
to Kite (password + mobile OTP), then paste the resulting redirect URL (or the
access token) back into the bar and hit **Connect**.

## 4. API

No auth — every `/api/*` route is open.

| method | path | purpose |
|---|---|---|
| GET  | `/api/ltp?symbol=RELIANCE` | last traded price |
| POST | `/api/order` | create a two-leg OCO GTT — `{ symbol, action, quantity, limit_price, sl_price, target_price, product }`. `action` is the position being protected (BUY = long, SELL = short); the exit legs are the opposite side. |
| GET  | `/api/orders/gtt` | list existing GTTs |
| PUT  | `/api/orders/gtt/:id` | modify a GTT (same body as POST) |
| DELETE | `/api/orders/gtt/:id` | cancel a GTT |
| GET  | `/api/token/status` | token freshness + expiry (metadata only) |
| GET  | `/api/token/login-url` | Kite login URL |
| POST | `/api/token/manual` | exchange a pasted `request_token` for an access token |
| POST | `/api/token/set` | store a pasted `access_token` (verified against Kite first) |
| GET  | `/health` | health check |

Errors carry a machine-readable `code` alongside `error`:

`no_token` · `token_expired` · `invalid_symbol` · `invalid_input` · `connection` ·
`forbidden` · `api_error`

### Token lifecycle

Zerodha invalidates every access token at ~07:30 IST daily, so freshness is
derived from that boundary, not a fixed age — a token minted at 06:30 IST is
correctly treated as expiring an hour later. When it expires the connect bar
turns amber; paste a fresh token to reconnect. The `access_token` itself never
leaves the backend — `/api/token/status` returns metadata only.

## 5. Deployment

The frontend deploys to **Vercel** (static Vite build) and the backend to
**Render** (`render.yaml` blueprint) — see that file for the service config.

- Set `VITE_API_BASE_URL` on Vercel to the deployed backend origin + `/api`.
- Set `KITE_API_KEY`, `KITE_API_SECRET`, and `CORS_ORIGIN` on Render.
- Persist `backend/data/` (a Render disk) so the token survives restarts;
  otherwise you re-paste it after every redeploy or free-tier spin-down.
- Serve over HTTPS.
