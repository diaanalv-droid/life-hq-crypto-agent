'use strict';
// Life HQ â€” trend_v1: ONE transparent long-only trend strategy for liquid assets.
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
  volumeRequirement: '20-day average daily volume > 0 and current bar volume >= 0.5 Ã— its 20-day average (avoid dead/illiquid bars)',
  stop: { initial: 'max(SMA50 Ã— 0.99, entry Ã— (1 âˆ’ 3 Ã— dailyVol30)) â€” structural, below entry', invalidation: 'daily close below SMA200 forces exit (regime break)' },
  exit: { trailingRule: 'exit on daily close below SMA50', hardInvalidation: 'daily close below SMA200' },
  positionSizing: { riskPerTradePctEquity: 1.0, formula: 'size = (riskPct Ã— equity) / (entry âˆ’ stop)', maxPositionPctEquity: 25 },
  maxConcurrentPositions: 4,
  costs: { feeBpsPerSide: 10, slippageBpsPerSide: 15, note: 'applied on entry and exit; spread proxied inside slippage' },
  reEntry: 'after an exit, require â‰¥1 flat bar and a fresh pullback-reclaim signal before re-entering',
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
  if (!volOk) reasons.push('volume below 0.5Ã— 20-day average');
  if (reasons.length) return { signal: false, reason: reasons.join('; '), uptrend, reclaim, volOk, eligible };
  const dv = vol30(closes, i) || 0.05;
  const stop = Math.max(s50 * 0.99, p * (1 - 3 * dv));
  const stopDistPct = (p - stop) / p;
  const sizeFrac = Math.min(TREND_V1.positionSizing.max[ÜÚ][Û”İ\]Z]HÈL
‘S‘ÕŒKœÜÚ][Û”Ú^š[™Ëœš\ÚÔ\•˜YTİ\]Z]HÈL
HÈİÜ\İİ
NÂˆ™]\›ˆÈÚYÛ˜[ˆYK[Nˆ›İ[™
ŠKİÜˆ›İ[™
İÜŠKİÜ\İİˆ›İ[™
İÜ\İİ
ˆLŠKÚ^™Qœ˜XÑ\]Z]Nˆ›İ[™
Ú^™Qœ˜XË
K^][Nˆ‘S‘ÕŒK™^]˜Z[[™Ô[K[˜[Y][Ûˆ‘S‘ÕŒK™^]š\™[˜[Y][Û‹ÛXLŒˆ›İ[™
ÌŒŠKÛXMLˆ›İ[™
ÍLŠKÛXLŒˆ›İ[™
ÌŒŠHNÂŸB‚‹ËÈXÚÙ]˜YH™]\›œÈHH\‹][Y\İ[\™YÚ[YHX™[
\ÙİÛ‹ÜÚYJH›Üˆœ\™›Ü›X[˜ÙHH™YÚ[YH‹‚™[˜İ[Ûˆ\™›Ü›X[˜ÙPT™YÚ[YJ\\ÜÙ]™YÚ[YP]
HÂˆÛÛœİXÚÙ]ÈHßNÂˆ›Üˆ
ÛÛœİˆÙˆØš™Xİ˜[Y\Ê\\ÜÙ]
JHÂˆYˆ
\ˆ\‹›ÚÊHÛÛ[YNÂˆ›Üˆ
ÛÛœİÙˆ‹˜YS\İ
HÂˆÛÛœİ™YÈH™YÚ[YP]
™[UÊH	İ[šÛ›İÛ‰ÎÂˆ
XÚÙ]ÖÜ™Y×HHXÚÙ]ÖÜ™Y×HÈ˜Y\Îˆİ[T™]İˆÚ[œÎˆJNÂˆXÚÙ]ÖÜ™Y×K˜Y\ÊÊÎÈXÚÙ]ÖÜ™Y×Kœİ[T™]İ
ÏHœ™]İÈYˆ
œ™]İˆ
HXÚÙ]ÖÜ™Y×KÚ[œÊÊÎÂˆBˆBˆ›Üˆ
ÛÛœİÈÙˆØš™XİšÙ^\ÊXÚÙ]ÊJHÈÛÛœİˆHXÚÙ]ÖÚ×NÈ‹˜]™Ô™]İH›İ[™
‹œİ[T™]İÈ‹˜Y\ËŠNÈ‹Ú[”˜]TİH›İ[™
‹Ú[œÈÈ‹˜Y\È
ˆLJNÈ‹œİ[T™]İH›İ[™
‹œİ[T™]İŠNÈBˆ™]\›ˆXÚÙ]ÎÂŸB‚‹ËÈYÙÜ™YØ]H\‹X\ÜÙ]™\İ[È[ÈHÜ›Û[Ë[]™[Û™\İ™\™Xİ‚™[˜İ[ÛˆYÙÜ™YØ]J\\ÜÙ]
HÂˆÛÛœİ\œˆHØš™Xİ˜[Y\Ê\\ÜÙ]
K™š[\ŠˆOˆˆ	‰ˆ‹›ÚÊNÂˆÛÛœİİ[˜Y\ÈH\œ‹œ™YXÙJ
KŠHOˆH
È‹˜Y\Ë
NÂˆÛÛœİ[˜YT™]ÈH\œ‹™›]X\
ˆOˆ‹˜YS\İ›X\
Oˆœ™]İÈL
JNÂˆÛÛœİÚ[œÈH[˜YT™]Ë™š[\ŠˆOˆˆˆ
NÂˆÛÛœİÕÈHÚ[œËœ™YXÙJ
KŠHOˆH
È‹
KÓHX]˜XœÊ[˜YT™]Ë™š[\ŠˆOˆˆH
Kœ™YXÙJ
KŠHOˆH
È‹
JNÂˆÛÛœİZ[ˆH‘S‘ÕŒK˜[Y][Û”ÛXŞK›Z[•˜Y\ÕÑ]˜[X]NÂˆÛÛœİ]˜[XX›HHİ[˜Y\ÈHZ[Âˆ™]\›ˆÂˆ\ÜÙ]Îˆ\œ‹›[™İİ[˜Y\ËZ[•˜Y\ÕÑ]˜[X]NˆZ[‹]˜[XX›KˆYÙÜ™YØ]UÚ[”˜]Tİˆ[˜YT™]Ë›[™İÈ›İ[™
Ú[œË›[™İÈ[˜YT™]Ë›[™İ
ˆLJHˆ[ˆYÙÜ™YØ]T›Ùš]˜XİÜˆÓˆÈ›İ[™
ÕÈÈÓŠHˆ
ÕÈˆÈ[™š[š]Hˆ[
Kˆ˜[Y]Yˆ˜[ÙKˆ˜[Y][Û”İ]\Îˆ]˜[XX›BˆÈ	ÔØ[\HÚ^™HY]8 %™\]Z\™\ÈÛÛ™š\›YYİ][Ù‹\Ø[\HS‘][K\™YÚ[YHÛÛœÚ\İ[˜ŞH™Y›Ü™H˜[Y][Ûˆ
›İY]Ü˜[Y
IÂˆˆ[œİY™šXÚY[Ø[\H
	İİ[˜Y\ßH	ÛZ[ŸH˜Y\ÊH8 %™[™İŒHĞS““Õ™H]˜[X]YÈ“Õ˜[Y]Yˆ™YYÈ][K^YX\ˆ\İÜHXÜ›ÜÜÈ[Ø™X\‹ÜÚY]Ø^\Ë˜ˆ™\™Xİˆ]˜[XX›HÈ	Ñ]˜[XX›H]›İY]˜[Y]Y	Èˆ	ÑRSQ˜[Y][ÛˆØ]Nˆ[œİY™šXÚY[Ø[\IËˆNÂŸB‚›[Ù[K™^ÜÈHÈ‘S‘ÕŒK™[™ŒP˜XÚİ\İÜ]˜XÚİ\İYÙÜ™YØ]K]\İÚYÛ˜[\™›Ü›X[˜ÙPT™YÚ[YHNÂ