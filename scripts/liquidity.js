'use strict';
// Life HQ — multi-factor liquidity assessment (pure, unit-tested).
//
// CORRECTION vs earlier method: `24h volume / market cap` is NOT true liquidity.
// It is a *daily turnover ratio* — an approximate screening signal only. It may
// NOT, on its own, classify an established, large-cap asset as high-risk/illiquid.
// Large caps (BNB, XRP, TRX) with sub-1% turnover but hundreds of millions in
// real daily volume are liquid; the old rule wrongly excluded them.
//
// This engine combines, where available: absolute legitimate 24h volume, turnover
// ratio, number & quality of exchange listings, presence on reputable venues,
// bid–ask spread, market-pair concentration, suspicious/inflated-volume flags,
// a slippage estimate for an intended order size, and multi-day volume consistency.
// When spread/order-book depth are unavailable it labels execution liquidity as
// NOT fully assessed rather than inventing a confident high-risk verdict.

const round = (n, p = 2) => (n == null || !isFinite(n)) ? null : +n.toFixed(p);

// Venues we treat as reputable / regulated-or-major for retail EU access.
const REPUTABLE = new Set(['Binance', 'Coinbase Exchange', 'Coinbase', 'Kraken', 'Bitstamp',
  'Crypto.com Exchange', 'Crypto.com', 'OKX', 'Bybit', 'KuCoin', 'Gemini', 'Bitfinex',
  'Binance US', 'Kraken Pro', 'Bitvavo', 'Gate.io', 'Upbit']);

const CATEGORIES = ['High execution liquidity', 'Likely adequate for small orders',
  'Needs exchange-level verification', 'Low liquidity', 'Unreliable/suspicious volume', 'Insufficient data'];

// ---- pure summariser: raw CoinGecko /coins/{id}/tickers -> compact, testable shape ----
// rawTickers: array of {market:{name}, trust_score, bid_ask_spread_percentage, converted_volume:{usd}, is_anomaly, is_stale, base, target}
function summariseTickers(rawTickers) {
  if (!Array.isArray(rawTickers) || !rawTickers.length) return null;
  let totalVol = 0, anomalyVol = 0, greenVol = 0;
  const spreads = [], venues = new Set(), reputableVenues = new Set(), pairVol = {};
  let greenCount = 0;
  for (const t of rawTickers) {
    const v = (t.converted_volume && (t.converted_volume.usd || t.converted_volume.USD)) || 0;
    totalVol += v;
    if (t.is_anomaly || t.is_stale) anomalyVol += v;
    const name = t.market && t.market.name;
    if (name) venues.add(name);
    if (t.trust_score === 'green') { greenCount++; greenVol += v; if (name && REPUTABLE.has(name)) reputableVenues.add(name); }
    if (typeof t.bid_ask_spread_percentage === 'number' && t.trust_score === 'green') spreads.push(t.bid_ask_spread_percentage);
    const pair = `${t.base}/${t.target}@${name}`; pairVol[pair] = (pairVol[pair] || 0) + v;
  }
  spreads.sort((a, b) => a - b);
  const medianSpreadPct = spreads.length ? spreads[Math.floor(spreads.length / 2)] : null;
  const topPair = Object.entries(pairVol).sort((a, b) => b[1] - a[1])[0];
  const topPairConcentrationPct = totalVol > 0 && topPair ? round(topPair[1] / totalVol * 100, 1) : null;
  return {
    tickerCount: rawTickers.length, venueCount: venues.size, greenCount,
    reputableVenues: [...reputableVenues], reputableCount: reputableVenues.size,
    reportedVolUsd: round(totalVol, 0), greenVolUsd: round(greenVol, 0),
    anomalyVolSharePct: totalVol > 0 ? round(anomalyVol / totalVol * 100, 1) : 0,
    medianGreenSpreadPct: medianSpreadPct == null ? null : round(medianSpreadPct, 4),
    topPairConcentrationPct,
  };
}

// ---- multi-day volume consistency (coefficient of variation of daily USD volume) ----
function volConsistency(volSeriesUsd) {
  if (!Array.isArray(volSeriesUsd)) return null;
  const s = volSeriesUsd.filter(v => v != null && isFinite(v) && v > 0).slice(-30);
  if (s.length < 7) return null;
  const m = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / s.length);
  const cvPct = m > 0 ? round(sd / m * 100, 0) : null;
  return { days: s.length, meanUsd: round(m, 0), cvPct, label: cvPct == null ? 'unknown' : cvPct < 40 ? 'steady' : cvPct < 90 ? 'variable' : 'erratic' };
}

// ---- slippage estimate for an intended order size (rough, low-confidence) ----
// Without an order book we approximate: cost ≈ half-spread + impact, where impact
// grows with order size relative to per-venue green liquidity. Explicitly labelled low-confidence.
function slippageEstimate(orderUsd, greenVolUsd, medianSpreadPct) {
  if (!greenVolUsd || greenVolUsd <= 0) return null;
  const halfSpreadBps = medianSpreadPct != null ? medianSpreadPct * 100 / 2 : null;
  // assume a single order can absorb ~ liquidity proportional to daily green volume;
  // impact ~ 10bps per 1% of *daily* green volume taken in one order (crude).
  const shareOfDaily = orderUsd / greenVolUsd;
  const impactBps = round(shareOfDaily * 100 * 10, 1);
  const estBps = round((halfSpreadBps || 0) + impactBps, 1);
  return { orderUsd, estBps, components: { halfSpreadBps: halfSpreadBps == null ? null : round(halfSpreadBps, 1), impactBps }, confidence: medianSpreadPct != null ? 'low' : 'very-low', method: 'half-spread + crude size/volume impact; NOT order-book verified' };
}

// ---- main assessment ----
// c: {sym, vol (24h usd), mcap, samples}
// lens: { tickers: <summariseTickers output|null>, volSeriesUsd: [..], orderUsd } | null
function assessLiquidity(c, lens = {}) {
  const abs = c.vol != null ? c.vol : null;                 // absolute reported 24h volume (USD)
  const turnoverPct = (c.mcap && abs != null) ? round(abs / c.mcap * 100, 3) : null;
  const t = lens.tickers || null;
  const vc = volConsistency(lens.volSeriesUsd);
  const evidence = [], caveats = [];
  if (turnoverPct != null) evidence.push(`Daily turnover ratio ${turnoverPct}% (screening signal only — not execution liquidity)`);
  if (abs != null) evidence.push(`Absolute 24h volume $${round(abs / 1e6, 1)}M`);

  // --- execution-quality inputs (only when tickers retrieved) ---
  let spread = null, slip = null, executionAssessed = false;
  if (t) {
    if (t.reputableCount) evidence.push(`On ${t.reputableCount} reputable venue(s): ${t.reputableVenues.slice(0, 5).join(', ')}`);
    evidence.push(`${t.greenCount}/${t.tickerCount} green-trust markets across ${t.venueCount} venues`);
    if (t.medianGreenSpreadPct != null) { spread = { medianGreenPct: t.medianGreenSpreadPct, source: 'CoinGecko tickers (green-trust)' }; evidence.push(`Median green bid–ask spread ${t.medianGreenSpreadPct}%`); executionAssessed = true; }
    if (t.topPairConcentrationPct != null) { evidence.push(`Top market-pair concentration ${t.topPairConcentrationPct}%`); if (t.topPairConcentrationPct > 70) caveats.push('Volume concentrated in a single pair — execution risk if that venue degrades'); }
    if (t.anomalyVolSharePct > 0) evidence.push(`Flagged (anomaly/stale) volume share ${t.anomalyVolSharePct}%`);
    if (lens.orderUsd) slip = slippageEstimate(lens.orderUsd, t.greenVolUsd, t.medianGreenSpreadPct);
  }
  if (vc) evidence.push(`Volume consistency over ${vc.days}d: ${vc.label} (CV ${vc.cvPct}%)`);
  if (!executionAssessed) caveats.push('Execution liquidity not fully assessed — order-book depth and live spread not retrieved for this asset');

  // --- deterministic category decision ---
  let category, excluded = false;
  if (abs == null && !t) category = 'Insufficient data';
  else if (t && t.anomalyVolSharePct >= 40) { category = 'Unreliable/suspicious volume'; excluded = true; }
  else if (t && t.reputableCount >= 3 && t.medianGreenSpreadPct != null && t.medianGreenSpreadPct < 0.1 && (t.greenVolUsd || 0) >= 50e6) category = 'High execution liquidity';
  else if (t && t.reputableCount >= 1 && (t.medianGreenSpreadPct == null || t.medianGreenSpreadPct < 0.6) && (t.greenVolUsd || abs || 0) >= 20e6) category = 'Likely adequate for small orders';
  else if (t && t.venueCount > 0) category = 'Needs exchange-level verification';
  // --- screening-only path (no tickers retrieved): use absolute volume, never turnover alone ---
  else if (abs != null && abs >= 100e6) { category = 'Likely adequate for small orders'; caveats.push('Category from absolute volume screen only — venue quality/spread not retrieved'); }
  else if (abs != null && abs >= 10e6) category = 'Needs exchange-level verification';
  else if (abs != null && abs >= 1e6) category = 'Low liquidity';
  else if (abs != null) { category = 'Low liquidity'; }
  else category = 'Insufficient data';

  // suspicious volume from screening (very high turnover + no venue confirmation)
  if (!t && turnoverPct != null && turnoverPct > 150) { category = 'Needs exchange-level verification'; caveats.push('Very high turnover with no venue-quality confirmation — possible inflated volume; verify before trusting'); }

  // Low-liquidity / suspicious are the only categories that *exclude* from opportunities.
  if (category === 'Low liquidity' || category === 'Unreliable/suspicious volume') excluded = true;

  // trade-eligibility (for trend_v1): needs real execution confidence
  const tradeEligible = category === 'High execution liquidity' || category === 'Likely adequate for small orders';

  return {
    turnoverRatioPct: turnoverPct,
    turnoverNote: 'daily turnover ratio — approximate screening signal (NOT execution liquidity)',
    abs24hVolUsd: abs, exchange: t, spread, volConsistency: vc, slippageEstimate: slip,
    executionAssessed, category, excluded, tradeEligible, evidence, caveats,
  };
}

module.exports = { REPUTABLE, CATEGORIES, summariseTickers, volConsistency, slippageEstimate, assessLiquidity };
