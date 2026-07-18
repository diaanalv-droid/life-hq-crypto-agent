'use strict';
// Life HQ — trend_v1: ONE transparent long-only trend strategy for liquid assets.
// Pure + unit-tested. No look-ahead (every decision uses data up to and INCLUDING the
// signal bar, and fills at that bar's close), no repainting, realistic costs.
//
// The SAME rule object drives the backend backtest AND the Pine Script, so they agree.

const round = (n, p = 2) => (n == null || !isFinite(n)) ? null : +n.toFixed(p);

const TREND_V1 = {
  id: 'trend_v1',
  version: '1.0.0',
  side: 'long-only',
  thesis: 'Participate in established uptrends; buy shallow pullbacks that reclaim the fast average; exit when the medium trend breaks. Never fight a downtrend.',
  universe: 'non-stable assets classified core/established/emerging with liquidity tradeEligible (High execution liquidity OR Likely adequate for small orders)',
  requiredHistoryDays: 250,
  regimeFilter: { rule: 'asset in uptrend structure: SMA50 > SMA200 AND close > SMA200', optionalMarketFilter: 'skip new entries when BTC close < BTC SMA200 (broad risk-off)' },
  entry: { rule: 'pullback reclaim: prior bar close <= SMA20(prior) AND current close > SMA20, while SMA50 > SMA200 AND close > SMA200', fill: 'current bar close' },
  confirmation: 'SMA50 > SMA200 AND close > SMA200 on the signal bar (trend + no regime break)',
  volumeRequirement: '20-day average daily volume > 0 and current bar volume >= 0.5 × its 20-day average (avoid dead/illiquid bars)',
  stop: { initial: 'max(SMA50 × 0.99, entry × (1 − 3 × dailyVol30)) — structural, below entry', invalidation: 'daily close below SMA200 forces exit (regime break)' },
  exit: { trailingRule: 'exit on daily close below SMA50', hardInvalidation: 'daily close below SMA200' },
  positionSizing: { riskPerTradePctEquity: 1.0, formula: 'size = (riskPct × equity) / (entry − stop)', maxPositionPctEquity: 25 },
  maxConcurrentPositions: 4,
  costs: { feeBpsPerSide: 10, slippageBpsPerSide: 15, note: 'applied on entry and exit; spread proxied inside slippage' },
  reEntry: 'after an exit, require ≥1 flat bar and a fresh pullback-reclaim signal before re-entering',
  prohibited: ['history < requiredHistoryDays', 'liquidity not tradeEligible', 'asset close < SMA200', 'SMA50 <= SMA200 (no uptrend)', 'broad risk-off when market filter enabled'],
  validationPolicy: { minTradesToEvaluate: 20, requiresOutOfSample: true, requiresMultiRegime: true },
};

function sma(a, i, n) { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; }
function vol30(closes, i) { if (i < 30) return null; const r = []; for (let k = i - 29; k <= i; k++) r.push((closes[k] - closes[k - 1]) / closes[k - 1]); const m = r.reduce((a, b) => a + b, 0) / r.length; return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length); }

// daily: chronological array of [tsSec, close, volumeUsd]. opts overrides costs/sizing.
// marketBelow200[i] (optional): boolean array, true when broad market (BTC) is below its SMA200 at bar i.
function trendV1Backtest(daily, opts = {}) {
  const cfg = { ...TREND_V1.costs, riskPct: TREND_V1.positionSizing.riskPerTradePctEquity, maxPosPct: TREND_V1.positionSizing.maxPositionPctEquity, useMarketFilter: false, ...opts };
  if (!Array.isArray(daily) || daily.length < TREND_V1.requiredHistoryDays) return { ok: false, reason: `need >=${TREND_V1.requiredHistoryDays} candles, got ${daily ? daily.length : 0}` };
  const closes = daily.map(d => d[1]), vols = daily.map(d => d[2] || 0), ts = daily.map(d => d[0]);
  const costPerSide = (cfg.feeBpsPerSide + cfg.slippageBpsPerSide) / 1e4;
  let equity = 1, peak = 1, maxDD = 0, inPos = false, entryPx = 0, stopPx = 0, sizeFrac = 0, entryIdx = -1, barsInMkt = 0, cooldown = 0;
  const trades = [], dailyRet = [];
  for (let i = 200; i < closes.length; i++) {
    const p = closes[i], s20 = sma(closes, i, 20), s50 = sma(closes, i, 50), s200 = sma(closes, i, 200), s20p = sma(closes, i - 1, 20);
    const v = vols[i], vAvg20 = (() => { let s = 0, k = 0; for (let j = i - 19; j <= i; j++) { if (vols[j] != null) { s += vols[j]; k++; } } return k ? s / k : 0; })();
    const prevEq = equity;
    if (inPos) {
      barsInMkt++;
      // exit rules (evaluated on this bar's close; fill at close)
      const breakStop = p <= stopPx, belowS50 = s50 != null && p < s50, belowS200 = s200 != null && p < s200;
      if (breakStop || belowS50 || belowS200) {
        const gross = (p / entryPx - 1) * sizeFrac;
        const net = gross - 2 * costPerSide * sizeFrac;         // entry+exit cost on the position fraction
        equity = equity * (1 + net);
        trades.push({ entryTs: ts[entryIdx], exitTs: ts[i], bars: i - entryIdx, entry: round(entryPx, 6), exit: round(p, 6), stop: round(stopPx, 6), retPct: round(net * 100, 2), reason: breakStop ? 'stop' : belowS200 ? 'regime-break(<SMA200)' : 'trend-exit(<SMA50)' });
        inPos = false; cooldown = 1;
      }
    } else if (cooldown > 0) { cooldown--; }
    else {
      // entry: pullback reclaim in a confirmed uptrend
      const uptrend = s50 != null && s200 != null && s50 > s200 && p > s200;
      const reclaim = s20 != null && s20p != null && closes[i - 1] <= s20p && p > s20;
      const volOk = vAvg20 > 0 && v >= 0.5 * vAvg20;
      const marketOk = !cfg.useMarketFilter || !(opts.marketBelow200 && opts.marketBelow200[i]);
      if (uptrend && reclaim && volOk && marketOk) {
        const dv = vol30(closes, i) || 0.05;
        const stopStruct = Math.max(s50 * 0.99, p * (1 - 3 * dv));
        if (stopStruct < p) {
          const stopDistPct = (p - stopStruct) / p;
          sizeFrac = Math.min(cfg.maxPosPct / 100, (cfg.riskPct / 100) / stopDistPct);
          entryPx = p; stopPx = stopStruct; inPos = true; entryIdx = i;
        }
      }
    }
    dailyRet.push(equity / prevEq - 1);
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak; if (dd < maxDD) maxDD = dd;
  }
  if (inPos) { const p = closes[closes.length - 1]; const gross = (p / entryPx - 1) * sizeFrac; const net = gross - 2 * costPerSide * sizeFrac; equity *= (1 + net); trades.push({ entryTs: ts[entryIdx], exitTs: ts[closes.length - 1], bars: closes.length - 1 - entryIdx, entry: round(entryPx, 6), exit: round(p, 6), stop: round(stopPx, 6), retPct: round(net * 100, 2), reason: 'open-at-end' }); }

  const rets = trades.map(t => t.retPct / 100);
  const wins = rets.filter(r => r > 0), losses = rets.filter(r => r <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0), grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const mean = dailyRet.length ? dailyRet.reduce((a, b) => a + b, 0) / dailyRet.length : 0;
  const sd = dailyRet.length ? Math.sqrt(dailyRet.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyRet.length) : 0;
  const downside = dailyRet.filter(r => r < 0); const dsd = downside.length ? Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length) : 0;
  const buyHold = closes[200] ? (closes[closes.length - 1] / closes[200] - 1) : null;
  return {
    ok: true, strategy: TREND_V1.id, version: TREND_V1.version,
    barsTested: closes.length - 200, trades: trades.length,
    returnPct: round((equity - 1) * 100, 2), maxDrawdownPct: round(maxDD * 100, 2),
    winRatePct: trades.length ? round(wins.length / trades.length * 100, 1) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : (grossWin > 0 ? Infinity : null),
    avgWinPct: wins.length ? round(grossWin / wins.length * 100, 2) : null,
    avgLossPct: losses.length ? round(-grossLoss / losses.length * 100, 2) : null,
    timeInMarketPct: round(barsInMkt / (closes.length - 200) * 100, 1),
    sharpeAnnual: sd > 0 ? round(mean / sd * Math.sqrt(365), 2) : null,
    sortinoAnnual: dsd > 0 ? round(mean / dsd * Math.sqrt(365), 2) : null,
    buyHoldPct: round(buyHold * 100, 2), cashPct: 0,
    costs: { feeBpsPerSide: cfg.feeBpsPerSide, slippageBpsPerSide: cfg.slippageBpsPerSide },
    tradeList: trades,
    limitations: 'daily close-only fills; slippage/fees modelled as flat bps (no live order book); Sharpe/Sortino use 0 risk-free and daily data; single-asset equity path.',
  };
}

// In-sample / out-of-sample split by time (default 70/30), same rules on both halves.
function splitBacktest(daily, splitPct = 0.7, opts = {}) {
  if (!Array.isArray(daily) || daily.length < TREND_V1.requiredHistoryDays + 40) return { ok: false, reason: 'not enough data to split' };
  const cut = Math.floor(daily.length * splitPct);
  // out-of-sample needs its own 200-bar warmup, so give it the tail with warmup context
  const inSample = daily.slice(0, cut);
  const outSample = daily.slice(Math.max(0, cut - 200));   // include warmup lead-in; bars<cut are warmup only
  return { ok: true, splitPct, inSample: trendV1Backtest(inSample, opts), outOfSample: trendV1Backtest(outSample, opts) };
}

// Does the MOST RECENT bar fire a trend_v1 entry? (same rules as the backtest, no look-ahead)
// daily: chronological [ts, close, vol]. liq: liquidity assessment (must be tradeEligible).
function latestSignal(daily, liq) {
  if (!Array.isArray(daily) || daily.length < TREND_V1.requiredHistoryDays) return { signal: false, reason: `history ${daily ? daily.length : 0} < ${TREND_V1.requiredHistoryDays} required` };
  const closes = daily.map(d => d[1]), vols = daily.map(d => d[2] || 0), i = closes.length - 1;
  const p = closes[i], s20 = sma(closes, i, 20), s50 = sma(closes, i, 50), s200 = sma(closes, i, 200), s20p = sma(closes, i - 1, 20);
  const uptrend = s50 != null && s200 != null && s50 > s200 && p > s200;
  const reclaim = s20 != null && s20p != null && closes[i - 1] <= s20p && p > s20;
  let vAvg = 0, k = 0; for (let j = i - 19; j <= i; j++) { if (vols[j] != null) { vAvg += vols[j]; k++; } } vAvg = k ? vAvg / k : 0;
  const volOk = vAvg > 0 && vols[i] >= 0.5 * vAvg;
  const eligible = !!(liq && liq.tradeEligible);
  const reasons = [];
  if (!eligible) reasons.push(`liquidity not tradeEligible (${liq ? liq.category : 'n/a'})`);
  if (!uptrend) reasons.push(`no uptrend (need SMA50>SMA200 & close>SMA200; close ${round(p, 4)}, SMA50 ${round(s50, 4)}, SMA200 ${round(s200, 4)})`);
  if (!reclaim) reasons.push('no fresh pullback reclaim of SMA20 on latest bar');
  if (!volOk) reasons.push('volume below 0.5× 20-day average');
  if (reasons.length) return { signal: false, reason: reasons.join('; '), uptrend, reclaim, volOk, eligible };
  const dv = vol30(closes, i) || 0.05;
  const stop = Math.max(s50 * 0.99, p * (1 - 3 * dv));
  const stopDistPct = (p - stop) / p;
  const sizeFrac = Math.min(TREND_V1.positionSizing.maxPositionPctEquity / 100, (TREND_V1.positionSizing.riskPerTradePctEquity / 100) / stopDistPct);
  return { signal: true, entry: round(p, 6), stop: round(stop, 6), stopDistPct: round(stopDistPct * 100, 2), sizeFracEquity: round(sizeFrac, 4), exitRule: TREND_V1.exit.trailingRule, invalidation: TREND_V1.exit.hardInvalidation, sma20: round(s20, 6), sma50: round(s50, 6), sma200: round(s200, 6) };
}

// Bucket trade returns by a per-timestamp regime label (up/down/side) for "performance by regime".
function performanceByRegime(perAsset, regimeAt) {
  const buckets = {};
  for (const r of Object.values(perAsset)) {
    if (!r || !r.ok) continue;
    for (const t of r.tradeList) {
      const reg = regimeAt(t.entryTs) || 'unknown';
      (buckets[reg] = buckets[reg] || { trades: 0, sumRetPct: 0, wins: 0 });
      buckets[reg].trades++; buckets[reg].sumRetPct += t.retPct; if (t.retPct > 0) buckets[reg].wins++;
    }
  }
  for (const k of Object.keys(buckets)) { const b = buckets[k]; b.avgRetPct = round(b.sumRetPct / b.trades, 2); b.winRatePct = round(b.wins / b.trades * 100, 1); b.sumRetPct = round(b.sumRetPct, 2); }
  return buckets;
}

// Aggregate per-asset results into a portfolio-level honest verdict.
function aggregate(perAsset) {
  const arr = Object.values(perAsset).filter(r => r && r.ok);
  const totalTrades = arr.reduce((a, r) => a + r.trades, 0);
  const allTradeRets = arr.flatMap(r => r.tradeList.map(t => t.retPct / 100));
  const wins = allTradeRets.filter(r => r > 0);
  const gW = wins.reduce((a, b) => a + b, 0), gL = Math.abs(allTradeRets.filter(r => r <= 0).reduce((a, b) => a + b, 0));
  const min = TREND_V1.validationPolicy.minTradesToEvaluate;
  const evaluable = totalTrades >= min;
  return {
    assets: arr.length, totalTrades, minTradesToEvaluate: min, evaluable,
    aggregateWinRatePct: allTradeRets.length ? round(wins.length / allTradeRets.length * 100, 1) : null,
    aggregateProfitFactor: gL > 0 ? round(gW / gL, 2) : (gW > 0 ? Infinity : null),
    validated: false,
    validationStatus: evaluable
      ? 'Sample size met — requires confirmed out-of-sample AND multi-regime consistency before validation (not yet granted)'
      : `Insufficient sample (${totalTrades} < ${min} trades) — trend_v1 CANNOT be evaluated; NOT validated. Needs multi-year history across bull/bear/sideways.`,
    verdict: evaluable ? 'Evaluable but not yet validated' : 'FAILED validation gate: insufficient sample',
  };
}

module.exports = { TREND_V1, trendV1Backtest, splitBacktest, aggregate, latestSignal, performanceByRegime };
