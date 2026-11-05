# Paper Trader

Mobile-first paper trading simulator. A $500 account, live Yahoo quotes, a Schwab-style order ticket, and 7:00 / 8:00 AM America/Chicago alerts. State lives in Postgres so it survives Render's ephemeral disk and free-tier sleep.

## Render free tier

Blueprint: [`render.yaml`](render.yaml) (free web service + free Postgres, region `oregon`).

After this repo is on `main`:

1. Open [the Blueprint create page](https://dashboard.render.com/blueprint/new?repo=https://github.com/katelininnocenti-dot/Paper-Trading-SIM).
2. Apply the Blueprint. Render creates the web service and the free Postgres database and injects `DATABASE_URL`.
3. Add the optional secrets below in the service Environment tab, then redeploy if you add them after the first boot.
4. In the GitHub repo, add Actions secret `APP_URL` set to the service origin (`https://<service>.onrender.com`, no path). [`.github/workflows/wake.yml`](.github/workflows/wake.yml) curls `$APP_URL/tick`.

Free web services sleep after about 15 minutes without a request. Free Postgres expires after 30 days and is limited to 1 GB. The wake workflow and `/tick` catch-up exist so the morning alerts and the closing snapshot still run once.

`GET /healthz` is the liveness check. `GET /tick` or `POST /tick` runs any due catch-up jobs, checks resting orders, and returns 200. Both are public. Job rows in `job_markers` make each live job run once per session date.

### Environment variables

Set these on the Render web service. Do not commit values.

| Name | Who sets it | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Blueprint (`fromDatabase`) | Postgres connection string. Required. |
| `PORT` | Render | HTTP port. The process listens on `0.0.0.0:$PORT`. |
| `TZ` | Blueprint | `America/Chicago`. Market hours are also hardcoded to that zone. |
| `NODE_ENV` | Blueprint | `production`. |
| `SESSION_SECRET` | Blueprint `generateValue` | HMAC key for the PIN cookie. Required when `PT_PIN` is set. |
| `VAPID_SUBJECT` | Blueprint | `mailto:` contact for web push. |
| `PT_PIN` | You, optional | When set, every `/api` route except login and health requires this PIN. When unset, the PIN screen stays hidden. |
| `VAPID_PUBLIC_KEY` | You, optional | Web push public key. Push stays off until both keys are set. |
| `VAPID_PRIVATE_KEY` | You, optional | Web push private key. |
| `POLYGON_API_KEY` | You, optional | Use Polygon quotes when set. Otherwise quotes come from Yahoo Finance. |

Generate a VAPID key pair on your own machine and paste the two keys into Render:

```bash
npx web-push generate-vapid-keys
```

Leave `PT_PIN` unset to keep the app open. To turn the gate on, add `PT_PIN` in the Render dashboard and redeploy. The server never prints the PIN.

### Wake schedule

GitHub Actions cron is UTC. Weekdays are `1-5`. America/Chicago is UTC-6 in CST and UTC-5 in CDT, so each alert has a ping in the hour before it in both seasons. Runs are every 10 minutes so a free service that sleeps after 15 idle minutes is still up when the clock hits 7:00 and 8:00. A late run still works: `/tick` performs each job once as soon as the Chicago clock is past its time.

| Cron (UTC) | Intent |
| --- | --- |
| `*/10 11 * * 1-5` | Hour before 7:00 AM CT during CDT |
| `*/10 12 * * 1-5` | Hour before 7:00 AM CT during CST, and hour before 8:00 AM CT during CDT |
| `*/10 13 * * 1-5` | Hour before 8:00 AM CT during CST. During CDT this hour is 8:00–8:59 AM, which catch-up uses if the earlier ping was late |
| `*/10 14-20 * * 1-5` | Regular session in both CST and CDT (8:30 AM–3:00 PM CT), including 12:00 PM early closes, so resting orders and the closing snapshot advance while the service would otherwise be asleep |
| `5,15 21 * * 1-5` | Just after 3:00 PM CT during CST |

`workflow_dispatch` is enabled for a manual wake. Scheduled workflows can be delayed; the job marker makes a late `/tick` run the missed work once.

## Local run

Node 20+. Point `DATABASE_URL` at a Postgres you control. Internal Render URLs do not use TLS. External URLs need `sslmode=require` (the app accepts Render's certificate).

```bash
npm ci
npm start
```

`npm run check` parses the sources. `npm run smoke` checks the schedule, the starter-share math, and that the server module loads. Neither command needs a database.

`./start.sh` runs the server in the foreground. `./supervise.sh` restarts it locally. Render does not use those scripts.

## What it does

- Order ticket: symbol + Quote, Buy/Sell, Market/Limit/Stop, shares or dollars (dollars are fractional and market-only), Day/GTC, review screen with estimated cost, a $0.00 commission line, SEC/TAF on sells, a required checkbox, then Place order. Orders go pending, then filled, with 1–3¢ adverse slippage. Larger orders (5+ shares or $250+) sometimes fill in pieces. Limit and stop orders rest until triggered. Day orders expire at the close.
- Market hours: 8:30 AM–3:00 PM CT on NYSE trading days (weekends, the 2026–2027 holidays in `lib-market.js`, and 12:00 PM CT early closes). Market orders are refused when the market is closed. Limit and stop orders queue for the next open.
- Positions (green/red), Schwab-style summary (cash, market value, total, day P&L, total P&L), trade log with running cash, and fake confirmation emails in the Inbox. No real email is sent.
- Alerts: 7:00 AM CT daily check (positions plus one HOLD/TRIM/ADD action), 8:00 AM CT game plan (limit prices and GO/NO-GO), close summary, and fill notices. In-app chime plus banner, and Web Push when VAPID keys and a device subscription exist. "Run 7:00 check now" and "Run 8:00 game plan now" run on demand and do not consume the scheduled job marker.
- Rules: TRIM when a position is at least +8% or at most −6% versus cost. ADD when cash is over 40% and a watchlist name has positive 5-day momentum and is within 2% of its 20-day average. Otherwise HOLD. Limit = last − 0.5 × typical daily move. Size = 1/3 of buying power. Copy is simulated practice guidance.
- 2-Week Sim: a separate $500 account and 10 generated trading days (per-ticker daily vol, a shared market factor, quiet/normal/eventful days, overnight gaps). Speeds 1x/10x/60x/300x, pause, and skip to the next event. Sim alerts follow the simulated clock and are stored with the sim engine.

On an empty database the live account is granted $500. Starter whole-share positions in MRK, CVX, and MDLZ are bought at the first Yahoo quote. Each name is sized near one third of the grant. When one share costs more than that and the remaining cash still covers it, the account buys that one share. Leftover cash stays in the account. The same three symbols are the watchlist. If Yahoo is unreachable, the account stays $500 cash and the position seed retries on the next boot. Reset (Inbox, type RESET) clears only the mode you are in and does not buy the starter shares again.

## Phone notifications

- iPhone (iOS 16.4+): Safari → Share → Add to Home Screen → open Paper Trader from the icon → PIN if one is set → Alerts → Enable notifications → Allow. Push works from the home-screen app. Allow the app through Focus if it should buzz during the day.
- Android (Chrome): open the site → PIN if one is set → Alerts → Enable notifications → Allow.
- Send test checks the registration.

HTTPS is required for the service worker and web push. Render terminates TLS at the edge.

## Data

Postgres tables: `accounts` (cash and balance), `positions`, `orders` (pending, queued, working, partially filled, filled, and the other terminal states), `fills` (trade log), `snapshots` (daily P&L), `messages`, `emails`, `push_subscriptions`, `job_markers`, and `app_config` (watchlist, quote seed, sim engine, bootstrap status). Secrets are not written to the database or the repo.
