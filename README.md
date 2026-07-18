# Life HQ — Crypto Intelligence Agent (Milestone 1)

A **genuinely working**, read-only crypto monitoring + paper-trading agent. No trading or
withdrawal permissions. No real money. No fabricated data.

## Architecture (real, free, no extra accounts)
- **GitHub repo = home + database.** Persistent state lives as JSON in [`/data`](./data).
- **GitHub Actions = scheduler + pipeline.** [`.github/workflows/pipeline.yml`](./.github/workflows/pipeline.yml) runs [`scripts/pipeline.js`](./scripts/pipeline.js) on `cron */15` (and manual dispatch). GitHub runners have network, so the pipeline fetches **real** prices.
- **Static dashboard** ([`index.html`](./index.html)) reads the committed `/data/*.json`. It never hardcodes prices.

## Each run
1. Fetch BTC & ETH from **Crypto.com public API** (primary).
2. **Cross-validate** vs **CoinGecko** (flag if >2% deviation).
3. Append to `price_history.json`.
4. Update paper positions' mark & P&L.
5. Compute a **transparent market regime**.
6. Log refresh timestamps, activity, per-source **health**.
7. Daily **briefing** in **Europe/Amsterdam**.

## Safety
- Read-only market data only. **No exchange keys with trade/withdraw scope.**
- Portfolio = **Not connected** until you create a Crypto.com **read-only** key.
- Paper trading labelled **PAPER — NO REAL MONEY**.
