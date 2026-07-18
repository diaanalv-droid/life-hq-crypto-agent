'use strict';
// Life HQ — deterministic strategy + validity engine (pure, no network, unit-tested).
// Separates THREE conclusions: (1) project quality, (2) long-term research status,
// (3) current trade setup — and blocks any invalid/contradictory proposal.

const round = (n, p = 2) => (n == null || !isFinite(n)) ? null : +n.toFixed(p);
const px = (n) => round(n, n != null && n >= 100 ? 2 : 6);

const STABLES = new Set(['USDT','USDC','USD1','USDD','DAI','FDUSD','TUSD','USDE','PYUSD','USDS','USDG','USDP','GUSD','BUSD','FRAX','LUSD','USDY','USYC','BUIDL','USDF','BFUSD','EUTBL','JTRSY','USTB','RLUSD']);
function isStable(c) {
  if (STABLES.has(c.sym)) return true;
  if (c.price != null && Math.abs(c.price - 1) < 0.02 && (c.chg30d == null || Math.abs(c.chg30d) < 1.5)) return true;
  return false;
}

// ---------- (A) explicit asset classification (age/maturity + mcap + liquidity) ----------
// samples = number of daily candles available (>=330 ~ >=~11 months listed history)
// CORRECTION: turnover ratio (vol/mcap) NO LONGER makes an asset high-risk. Liquidity
// exclusion now comes ONLY from the multi-factor liquidity engine (liq.excluded) — a
// low turnover on a large, deeply-traded asset (BNB/XRP/TRX) is NOT illiquidity.
function classify(c, liq) {
  if (isStable(c)) return { group: 'stablecoin', why: 'pegged stablecoin (~$1) — excluded from opportunities' };
  if (c.mcap != null && c.mcap < 5e7) return { group: 'high-risk', why: 'micro_cap (<$50M) — size floor, independent of turnover' };
  if (liq && liq.excluded) return { group: 'high-risk', why: `liquidity: ${liq.category}${liq.abs24hVolUsd != null ? ' (24h vol $' + round(liq.abs24hVolUsd / 1e6, 1) + 'M)' : ''}` };
  if (['BTC', 'ETH'].includes(c.sym)) return { group: 'core', why: 'BTC/ETH — core reserve assets' };
  const mature = c.samples != null && c.samples >= 330; // >=~1y of daily history
  if (mature && c.mcap >= 3e9) return { group: 'established', why: `mature (${c.samples} daily candles ≥1y) + mcap $${round(c.mcap / 1e9, 1)}B ≥ $3B` };
  if (c.mcap >= 3e8 && (c.mcap < 3e9 || !mature)) return { group: 'emerging', why: `mcap $${round(c.mcap / 1e9, 2)}B ${!mature ? '(< ~1y history: ' + c.samples + ' candles)' : 'in $0.3–3B band'}` };
  return { group: 'other', why: 'does not meet established/emerging thresholds' };
}

// ---------- (B) trade-setup builder (long only for now) ----------
// Returns {valid:false, reason} OR a fully-specified proposal with ordered levels + R:R.
function buildLongSetup(c, ind, cfg = {}) {
  const minRR = cfg.minRR ?? 1.5, maxEntryDistPct = cfg.maxEntryDistPct ?? 15, targetRR = cfg.targetRR ?? 2;
  if (!ind || ind.sma20 == null || ind.sma50 == null || ind.sma200 == null) return { valid: false, reason: 'insufficient indicators (need SMA20/50/200)' };
  const price = c.price, { sma20, sma50, sma200 } = ind;
  // A long requires a genuine uptrend structure: price > SMA50 > SMA200
  if (!(price > sma50 && sma50 > sma200)) return { valid: false, reason: `not an uptrend — require price>SMA50>SMA200 (price ${px(price)}, SMA50 ${px(sma50)}, SMA200 ${px(sma200)})` };
  // entry = nearest average BELOW price (a pullback buy)
  const entry = sma20 < price ? sma20 : sma50;
  if (!(entry < price)) return { valid: false, reason: 'no pullback entry below current price' };
  // stop = next structural level strictly below entry
  const stopBasis = (entry === sma20 && sma50 < entry) ? sma50 : sma200;
  const stop = stopBasis * 0.99;
  if (!(stop < entry)) return { valid: false, reason: `stop (${px(stop)}) not below entry (${px(entry)})` };
  const risk = entry - stop;
  const target = entry + risk * targetRR;
  const rr = (target - entry) / (entry - stop);
  const entryDistPct = (price - entry) / price * 100;
  return { valid: true, side: 'long', currentPrice: px(price), entry: px(entry), stop: px(stop), target: px(target), rr: round(rr, 2), entryDistPct: round(entryDistPct, 1), minRR, maxEntryDistPct };
}

// ---------- (C) deterministic QC / proposal-validity layer ----------
function validateProposal(s) {
  const f = [];
  if (!s || !s.valid) return { pass: false, failures: [s ? s.reason : 'no setup produced'] };
  const nums = [s.entry, s.stop, s.target, s.rr, s.currentPrice];
  if (nums.some(v => v == null || !isFinite(v))) f.push('non-finite price/level');
  if (s.side === 'long') {
    if (!(s.stop < s.entry)) f.push('long: stop must be BELOW entry');
    if (!(s.entry < s.target)) f.push('long: entry must be below target');
    if (!(s.stop < s.currentPrice)) f.push('long: stop must be below current price');
  } else if (s.side === 'short') {
    if (!(s.stop > s.entry)) f.push('short: stop must be ABOVE entry');
    if (!(s.entry > s.target)) f.push('short: entry must be above target');
  }
  if (!(s.rr >= s.minRR)) f.push(`reward:risk ${s.rr} < minimum ${s.minRR}`);
  if (s.entryDistPct != null && s.entryDistPct > s.maxEntryDistPct) f.push(`entry ${s.entryDistPct}% from price — not realistically reachable`);
  return { pass: f.length === 0, failures: f };
}

// ---------- (D) three separated conclusions ----------
function projectQuality(/* c, fundamentals */) {
  // Free data has no on-chain usage/revenue/unlock/holder-concentration inputs yet.
  return { label: 'Not assessed', basis: 'fundamental inputs not yet connected', missing: ['network usage & trend', 'fees/revenue', 'active addresses', 'dev activity', 'token utility', 'supply inflation', 'insider/team allocation', 'upcoming unlocks', 'holder/validator concentration', 'downtime/security history', 'competitive position', 'regulatory exposure', 'FDV vs demand'] };
}
function longTermVerdict(c, ind, group, fundamentals) {
  if (group === 'high-risk' || group === 'stablecoin') return { label: 'Avoid', basis: group === 'stablecoin' ? 'stablecoin — not an appreciation asset' : 'fails liquidity/quality filter' };
  if (!ind || ind.samples < 200) return { label: 'Insufficient evidence', basis: 'not enough price history for any long-term read' };
  if (!fundamentals || !Object.keys(fundamentals).length)
    return { label: 'Quant watch candidate — fundamental research incomplete', basis: 'established/liquid with ≥1y history, but durability inputs (usage, revenue, unlocks, concentration, competition) NOT assessed — this is a QUANT signal only, not an accumulation call' };
  return { label: 'Long-term research candidate', basis: 'fundamentals assessed' };
}
function setupVerdict(c, ind) {
  const s = buildLongSetup(c, ind);
  const qc = validateProposal(s);
  if (!qc.pass) return { label: 'No valid setup', proposal: null, qc, reason: qc.failures.join('; ') };
  // A structurally valid setup still is NOT backtest-validated, so it is only "potential".
  return { label: 'Potential quantitative setup — not validated', proposal: s, qc, reason: 'ordered levels + R:R pass QC; strategy not yet backtested' };
}

// ---------- data-driven scenarios + evidence (honest; no fundamentals yet) ----------
function scenarios(c, ind) {
  const ev = { for: [], against: [] };
  const above50 = ind && ind.sma50 != null && c.price > ind.sma50;
  const above200 = ind && ind.sma200 != null && c.price > ind.sma200;
  if (above200) ev.for.push('Above 200-day average (long uptrend)'); else if (ind && ind.sma200 != null) ev.against.push('Below 200-day average (long downtrend)');
  if (above50) ev.for.push('Above 50-day average'); else if (ind && ind.sma50 != null) ev.against.push('Below 50-day average');
  if (ind && ind.rs30VsBtc != null) (ind.rs30VsBtc > 0 ? ev.for : ev.against).push(`Relative strength vs BTC (30d) ${round(ind.rs30VsBtc, 1)}%`);
  if (c.liqRatio != null) (c.liqRatio > 0.02 ? ev.for : ev.against).push(`Liquidity vol/mcap ${round(c.liqRatio * 100, 2)}%`);
  if (c.supplyInflationPct != null && c.supplyInflationPct > 25) ev.against.push(`Future dilution ~${round(c.supplyInflationPct, 0)}% of max not yet circulating`);
  const dd = ind ? ind.drawdownPct : null;
  return {
    bull: `${c.sym} ${above200 ? 'holds its long uptrend' : 'reclaims the 200-day average'}${dd != null && dd < -40 ? ' and recovers part of its ' + round(-dd, 0) + '% drawdown' : ''}.`,
    base: `${c.sym} ranges with the broad market; no directional edge.`,
    bear: `${c.sym} loses key averages${c.supplyInflationPct > 25 ? ', dilution adds sell pressure,' : ''} and drawdown deepens.`,
    evidenceFor: ev.for, evidenceAgainst: ev.against,
  };
}

// ---------- (E) simple, honest backtest of the pullback strategy ----------
// closes: chronological daily closes. Strategy: in uptrend (SMA50>SMA200), buy when
// price dips to/below SMA20 then closes back above it; exit on close below SMA50.
function sma(a, i, n) { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; }
function backtest(closes) {
  if (!closes || closes.length < 210) return { ok: false, reason: 'need >=210 candles' };
  let inPos = false, entry = 0, trades = [], eqBuyHold = closes[closes.length - 1] / closes[0] - 1;
  for (let i = 200; i < closes.length; i++) {
    const p = closes[i], s20 = sma(closes, i, 20), s50 = sma(closes, i, 50), s200 = sma(closes, i, 200);
    const s20p = sma(closes, i - 1, 20);
    if (!inPos) {
      if (s50 > s200 && closes[i - 1] <= s20p && p > s20) { inPos = true; entry = p; }
    } else {
      if (p < s50) { trades.push(p / entry - 1); inPos = false; }
    }
  }
  if (inPos) trades.push(closes[closes.length - 1] / entry - 1);
  const wins = trades.filter(t => t > 0).length;
  const total = trades.reduce((a, b) => a + (b), 0);
  const MIN_TRADES = 20;
  const evaluable = trades.length >= MIN_TRADES;
  return {
    ok: true, trades: trades.length, minTradesRequired: MIN_TRADES, evaluable, validated: false,
    status: evaluable ? 'Sample size met — still requires an out-of-sample test before any validation' : 'Insufficient sample — strategy cannot be evaluated',
    winRatePct: trades.length ? round(wins / trades.length * 100, 1) : null,
    avgReturnPct: trades.length ? round(total / trades.length * 100, 2) : null,
    sumReturnPct: round(total * 100, 2), buyHoldPct: round(eqBuyHold * 100, 2),
    note: `close-only, no fees/slippage; NOT validated for real money; do NOT compare vs buy-hold with <${MIN_TRADES} trades`,
  };
}

module.exports = { round, px, isStable, classify, buildLongSetup, validateProposal, projectQuality, longTermVerdict, setupVerdict, scenarios, backtest };
