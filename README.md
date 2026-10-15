# Bike Auction Platform

Live used-motorcycle auctions: many simultaneous auctions, real-time bids over WebSocket, admin-managed lifecycle, structured logs and metrics.

## Setup
```bash
npm install
npm test
JWT_SECRET=change-me npm start      # http://localhost:3000
```
Env: `PORT`, `JWT_SECRET` (required in production), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SEED=0` to skip demo data.
Demo logins (seeded): admin `admin@bikes.test` / `Admin#12345`, buyer `buyer@bikes.test` / `Buyer#12345`. Override the admin password via env in any real deployment.

## Deployment
Docker: `docker build -t bike-auction . && docker run -p 3000:3000 -e JWT_SECRET=$(openssl rand -hex 32) -e ADMIN_PASSWORD=... bike-auction`.
Any container host with WebSocket support works (Render, Fly.io, Railway, Cloud Run with session affinity). Use `/healthz` for health checks and scrape `/metrics`. Terminate TLS at the platform; the client switches to `wss://` automatically. Run **one instance** until state moves to a database (see trade-offs).

## Architecture
- `src/auction.js` - domain service: all rules (start price, min increment, no self-outbid, scheduled/live/ended status, anti-sniping +60s for bids in the last minute, exactly-once close with winner). No HTTP knowledge, fully unit-tested, emits events.
- `src/app.js` - Express API: Zod validation, JWT auth (1h), role check (user/admin), bcrypt hashing, helmet + CSP, body limit, rate limits (global + stricter on auth), request IDs, JSON access logs, central error mapping, `/healthz`, `/metrics` (Prometheus text).
- `src/server.js` - wires HTTP + WebSocket (`/ws`, server push only, heartbeat to drop dead sockets), 1s sweeper that closes expired auctions, graceful SIGTERM shutdown.
- `public/index.html` - responsive, dark-mode aware UI; live price updates, countdowns, toasts, admin create form; output is HTML-escaped.

Bids go through REST (authenticated, validated, idempotent in effect because rules reject stale amounts); WebSocket only fans out results. Time is always server-side. Bidder names are masked in public views.

### API
`POST /api/auth/register|login` · `GET /api/auctions[/:id]` · `POST /api/auctions` (admin) · `DELETE /api/auctions/:id` (admin, cancel) · `POST /api/auctions/:id/bids` `{amount}` (auth). Errors: `{error: CODE, message}` with 400/401/403/404/409.

## Assumptions
Currency is whole rupees; one bike per auction; the first bid must be at least the start price; auctions are created live-from-now by the UI (API supports scheduled times); winner payment/shipping is out of scope.

## Trade-offs and what's next
- **State is in memory** (restart loses data; single instance). This kept the focus on the bidding rules. Production path: Postgres (`auctions`, `bids`, `users` with a unique `(auction_id, amount)` constraint; place bids in a transaction with `SELECT ... FOR UPDATE`) plus Redis pub/sub so WebSocket fan-out works across instances.
- Users are also in memory; production needs persistence, email verification, password reset, refresh tokens/httpOnly cookies (the demo keeps the JWT in sessionStorage).
- Metrics are a few hand-rolled counters; next steps are prom-client histograms, OpenTelemetry tracing, and alerting on bid-reject rate and WS connections.
- No end-to-end/browser tests or load tests yet; WebSocket delivery is untested.
- Bid idempotency keys, image uploads, and watchlists/notifications are not implemented.
