# Life HQ — Crypto Strategist (under validation)

A **genuinely working**, read-only crypto research engine. No trading or withdrawal
permissions. No real money. No fabricated data. Every verdict is honest about what it
does and does not know.

## Architecture (real, free, no extra accounts)
- **GitHub repo = home + database.** Persistent state lives as JSON in [`/data`](./data).
- **GitHub Actions = scheduler + pipeline.** [`.github/workflows/pipeline.yml`](./.github/workflows/pipeline.yml)
  runs a **test gate** then [`scripts/scan.js`](./scripts/scan.js) on `cron */15`. Runners have
  network, so the pipeline fetches **real** CoinGecko + Crypto.com data.
- **Static dashboard** ([`index.html`](./index.html)) reads the committed `/data/*.json`. TradingView
  Lightweight Charts render real OHLCV candles. Nothing is hardcoded.

## Analytical layers (all pure + unit-tested; CI-gated)
- **Liquidity** ([`scripts/liquidity.js`](./scripts/liquidity.js)) — multi-factor. Turnover
  (vol/mcap) is a **screening signal only**, never a sole high-risk trigger. Categories:
  High execution liquidity · Likely adequate for small orders · Needs exchange-level
  verification · Low liquidity · Unreliable/suspicious volume · Insufficient data. Missing
  spread/depth ⇒ *execution not fully assessed*, not a confident high-risk verdict.
- **Fundamentals** ([`scripts/fundamentals.js`](./scripts/fundamentals.js)) — sourced dossier;
  every fact carries `{value, source, retrievedAt, confidence}`. A description alone can **never**
  yield a positive project-quality verdict. Missing durability inputs stay missing.
- **Dilution/unlock** ([`scripts/dilution.js`](./scripts/dilution.js)) — supply math + FDV gap;
  **never** reports "no risk" from missing data (absent schedule ⇒ *unknown*, not zero).
- **Strategy** ([`scripts/trend.js`](./scripts/trend.js)) — `trend_v1`: one transparent long-only
  trend strategy. Realistic fees+slippage backtest, in/out-of-sample, by-regime, by-asset. A
  strategy is only "validated" after a sufficient trade sample **and** confirmed out-of-sample
  **and** multi-regime consistency. Machine-readable rules → [`data/trend_v1.json`](./data/trend_v1.json).
- **Setup QC** ([`scripts/strategy.js`](./scripts/strategy.js)) — three separated conclusions
  (project quality / long-term research / trade setup) with hard proposal-validity checks.

## Automated agent (each run)
scan universe → detect candidates → update dossier → liquidity/dilution/security/fundamental
checks → adversarial review → apply `trend_v1` → reject invalid → create a **PAPER** trade only
when all deterministic gates pass (else **"No qualifying setup"**) → monitor/exit → benchmark.
Every paper trade links strategy version, input data, signal time, dossier version, risk checks,
rationale, exit rule and outcome ([`data/paper.json`](./data/paper.json)).

## TradingView bridge
- **Stage A** — candlestick charts in each dossier (real OHLCV + SMA20/50/200 + backtest markers).
- **Stage B** — [`pine/trend_v1.pine`](./pine/trend_v1.pine): same rules, no repaint/look-ahead,
  fees+slippage, alerts, version 1.0.0.
- **Stage C** — webhook receiver **design only** ([`docs/tradingview-webhook.md`](./docs/tradingview-webhook.md));
  an alert may create only a research/watch/paper candidate. No real trading.

## Tests (CI gate)
`node tests/strategy.test.js` (19) and `node tests/engine.test.js` (48). The whole run aborts if
any validity test fails. Offline integration: `node tests/mockrun.js`.

## Safety
- Read-only market data only. **No exchange keys with trade/withdraw scope.**
- Portfolio shows **Not connected** until you create a Crypto.com **read-only** API key.
- Paper trading is clearly labelled **PAPER — NO REAL MONEY**; the active strategy is **not validated**.

## Known limits / next steps
- Free CoinGecko daily history is ~365d — too short to validate a trend strategy across full
  bull/bear/sideways cycles. Multi-year history is the next data upgrade before validation.
- In-UI watchlist/paper edits need a small write-backend or commit; reads are fully live.
