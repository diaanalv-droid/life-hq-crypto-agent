# TradingView → Life HQ webhook receiver (Stage C — DESIGN ONLY, no real trading)

**Status: not activated. This document specifies a safe receiver. No live order routing exists or is planned in this milestone.**

A TradingView alert fired by `pine/trend_v1.pine` may create **only** one of three non-executing artifacts:

1. **Research candidate** — queued for the next scheduled dossier refresh.
2. **Watch alert** — added to the watchlist so the scanner deep-analyses it.
3. **Paper-trade candidate** — eligible for a *simulated* trend_v1 entry, subject to the
   same backend deterministic gates (liquidity trade-eligible, QC pass, review pass).

It may **never** place, size, cancel, or withdraw a real order. There is no exchange
key with trade/withdraw scope anywhere in this system.

## Alert payload (from Pine `alert_message`)
```json
{
  "strategy": "trend_v1",
  "version": "1.0.0",
  "event": "LONG_ENTRY | EXIT",
  "ticker": "{{ticker}}",
  "price": "{{close}}",
  "time": "{{timenow}}",
  "sig": "<hmac-sha256 of the raw body using a shared secret>"
}
```

## Receiver requirements (when/if built)
- **Transport:** HTTPS only. A small serverless function (e.g. Cloudflare Worker / Vercel
  function). TradingView cannot send custom headers, so the shared secret travels **inside**
  the signed body (`sig`), computed as `HMAC_SHA256(secret, body_without_sig)`.
- **Authenticate every request:** reject if `sig` is missing or does not match. Constant-time compare.
- **Allowlist source IPs** to TradingView's published webhook ranges as defence in depth.
- **Idempotency:** de-duplicate on `(strategy, ticker, event, minute-bucketed time)` so a
  retried alert cannot create duplicate candidates.
- **Rate limit** per ticker (e.g. ≤1 accepted event / 5 min) to blunt spoofed floods.
- **Schema-validate** the JSON; drop anything unexpected. Never `eval`/interpolate fields into code or shell.
- **Version pin:** ignore alerts whose `version` ≠ the backend's active strategy version.
- **Backend re-check, not blind trust:** on receipt, re-run the backend `trend_v1` gate on our
  own sourced data. The alert is a *trigger to evaluate*, never an instruction to act. If the
  backend gate disagrees, the alert is logged and discarded.
- **Output:** append a record to `data/inbound_alerts.json` (research/watch/paper candidate) with
  full provenance: raw payload, verification result, backend re-check result, decision, timestamp.
- **No secrets in the public repo.** The HMAC secret lives only in the serverless platform's
  secret store. Proprietary TradingView library `.pine` files are **not** committed here.

## Why it stays off in this milestone
trend_v1 is **not validated** (insufficient trade sample; no confirmed out-of-sample/multi-regime
pass). Until validation genuinely passes, even paper candidates are forward-tests only, and there
is no case for wiring live execution.
