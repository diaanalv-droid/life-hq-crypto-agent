// Life HQ — Crypto Strategist pipeline (runs on GitHub Actions, Node 20).
// Scans a broad universe (CoinGecko free API), pulls 1y history for a shortlist,
// computes transparent indicators, and produces multi-horizon, evidence-based
// verdicts via a rule-based multi-lens engine. Read-only. No trading. No LLM calls.

const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data');
const HIST = path.join(DATA, 'history');
fs.mkdirSync(HIST, { recursive: true });

const CG = 'https://api.coingecko.com/api/v3';
const nowIso = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };
const write = (f, o) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(o));
const round = (n, p = 2) => (n == null || !isFinite(n)) ? null : +n.toFixed(p);

async function cg(pathq, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(CG + pathq, { headers: { 'User-Agent': 'life-hq-crypto-agent' } });
      if (r.status === 429) { await sleep(6000); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(3000); }
  }
}
async function cryptocomPrice(inst) {
  const r = await fetch(`https://api.crypto.com/v2/public/get-ticker?instrument_name=${inst}`);
  const d = (await r.json()).result.data; const row = Array.isArray(d) ? d[0] : d;
  return Number(row.a ?? row.last);
}

function sma(arr, n) { if (arr.length < n) return null; return arr.slice(-n).reduce((a, b) => a + b, 0) / n; }
function stdevReturns(closes) {
  const r = []; for (let i = 1; i < closes.length; i++) r.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  if (!r.length) return null; const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
}
function pctChange(closes, days) { if (closes.length <= days) return null; const a = closes[closes.length - 1 - days], b = closes[closes.length - 1]; return (b - a) / a * 100; }

function amsterdam() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function analyze(c, ind, btcInd) {
  const ev = { for: [], against: [], risks: [] };
  const liq = c.liqRatio;
  const dd = ind ? ind.drawdownPct : null;
  const distAth = ind ? ind.distAthPct : null;
  const vol30 = ind ? ind.vol30 : null;
  const above50 = ind && ind.sma50 != null && c.price > ind.sma50;
  const above200 = ind && ind.sma200 != null && c.price > ind.sma200;
  const rs30 = ind ? ind.rs30VsBtc : null;
  const mom30 = c.chg30d;
  const established = c.rank && c.rank <= 25;
  const enoughHistory = ind && ind.samples >= 200;
  let veto = null;
  if (liq != null && liq < 0.002) veto = 'liquidity';
  if (c.flags.includes('very_low_liquidity')) veto = 'liquidity';
  if (c.flags.includes('insufficient_history') && !established) ev.risks.push('short trading history — long-term view unsupported');
  if (established) ev.for.push(`Established large-cap (rank #${c.rank})`);
  if (liq != null) (liq > 0.03 ? ev.for : ev.against).push(`Liquidity vol/mcap ${round(liq * 100, 2)}%`);
  if (above200) ev.for.push('Price above 200-day average (long uptrend)'); else if (ind && ind.sma200 != null) ev.against.push('Price below 200-day average (long downtrend)');
  if (above50) ev.for.push('Price above 50-day average (medium uptrend)'); else if (ind && ind.sma50 != null) ev.against.push('Price below 50-day average');
  if (rs30 != null) (rs30 > 0 ? ev.for : ev.against).push(`Relative strength vs BTC (30d) ${round(rs30, 1)}%`);
  if (dd != null) ev.risks.push(`Drawdown from ATH ${round(dd, 1)}%`);
  if (distAth != null && distAth > -8) ev.risks.push('Near all-time high — worse short-term entry');
  if (vol30 != null && vol30 > 0.06) ev.risks.push(`High volatility (${round(vol30 * 100, 1)}% daily)`);
  const infl = c.supplyInflationPct;
  if (infl != null && infl > 25) ev.against.push(`Meaningful future dilution (~${round(infl, 0)}% supply not yet circulating)`);
  let long;
  if (veto) long = 'Avoid';
  else if (!enoughHistory && !established) long = 'Insufficient evidence';
  else if (established && dd != null && dd < -50 && liq > 0.02) long = 'Accumulate candidate';
  else if (established && above200) long = 'Hold';
  else if (established) long = 'Watch';
  else if (liq > 0.02 && above200) long = 'Watch';
  else long = 'Insufficient evidence';
  let med;
  if (veto) med = 'Avoid';
  else if (ind == null) med = 'Insufficient evidence';
  else if (above50 && above200 && (mom30 == null || mom30 > 0) && rs30 > 0) med = 'Hold';
  else if (above50 && (rs30 == null || rs30 > -5)) med = 'Watch';
  else if (!above50 && above200) med = 'Wait for confirmation';
  else med = 'Reduce exposure';
  let short;
  const above20 = ind && ind.sma20 != null && c.price > ind.sma20;
  if (veto) short = 'Avoid';
  else if (ind == null) short = 'Insufficient evidence';
  else if (distAth != null && distAth > -5) short = 'Reduce exposure';
  else if (above20 && (c.chg7d == null || c.chg7d > 0)) short = 'Buy-zone candidate';
  else if (!above20 && above50) short = 'Wait for confirmation';
  else short = 'Watch';
  let conf = 'Low';
  if (enoughHistory && liq != null && liq > 0.01) conf = established ? 'High' : 'Medium';
  else if (ind) conf = 'Medium';
  const entryZone = ind && ind.sma50 ? `Watch pullback toward 50-day avg ~$${round(ind.sma50, ind.sma50 > 100 ? 0 : 4)}` : 'Pending more history';
  const invalidation = ind && ind.sma200 ? `Sustained close below 200-day avg ~$${round(ind.sma200, ind.sma200 > 100 ? 0 : 4)} invalidates the uptrend thesis` : 'Define once 200-day avg is available';
  return {
    name: c.name, symbol: c.sym, price: c.price, ts: nowIso(),
    horizons: {
      long: { label: long, focus: 'utility, adoption, tokenomics, survival (1–5y)' },
      medium: { label: med, focus: 'cycle, catalysts, trend, RS (1–12m)' },
      short: { label: short, focus: 'trend, momentum, volume, S/R (days–weeks)' },
    },
    bull: `${c.sym} holds ${above200 ? 'its long uptrend' : 'and reclaims the 200-day average'}, liquidity stays healthy, and ${dd != null && dd < -40 ? 'recovers a portion of its ' + round(-dd, 0) + '% drawdown' : 'momentum continues'}.`,
    base: `${c.sym} ranges with the broader market; ${established ? 'established position persists' : 'needs to prove durability'}.`,
    bear: `${c.sym} loses key averages, ${infl != null && infl > 25 ? 'dilution adds sell pressure, ' : ''}and drawdown deepens.`,
    evidenceFor: ev.for, evidenceAgainst: ev.against, risks: ev.risks,
    confidence: conf,
    missing: ['On-chain activity', 'Verified tokenomics unlock schedule', 'Audit/security history', 'Dated catalysts'],
    strategy: veto ? 'None — fails liquidity/quality filter' : (long === 'Accumulate candidate' ? 'Long-term staged accumulation (DCA) into weakness' : (short === 'Buy-zone candidate' ? 'Short-term trend continuation with tight invalidation' : 'Monitor; no action')),
    entryZone: veto ? '—' : entryZone,
    invalidation: veto ? '—' : invalidation,
    maxRisk: veto ? 'Excluded' : (c.rank <= 25 ? 'Medium' : 'High'),
    houseFit: 'Crypto is a satellite/high-risk sleeve — NOT house-deposit money (that stays in low-risk liquid savings).',
    sources: ['CoinGecko /coins/markets + /market_chart', 'Crypto.com public ticker'],
    dataFreshness: nowIso(),
  };
}

(async () => {
  const runTs = nowIso(); const ams = amsterdam();
  const activity = read('activity.json', []); const health = read('health.json', { sources: {} });
  const meta = read('meta.json', { refreshes: [] }); const paper = read('paper.json', { positions: [] });
  const watchlist = read('watchlist.json', { symbols: ['BTC', 'ETH'] });
  let global = {};
  try { const g = await cg('/global'); const d = g.data; global = { ts: runTs, totalMcapUsd: d.total_market_cap.usd, mcapChange24hPct: d.market_cap_change_percentage_24h_usd, btcDominance: d.market_cap_percentage.btc, ethDominance: d.market_cap_percentage.eth }; health.sources.coingecko = { status: 'ok', lastOk: runTs }; }
  catch (e) { health.sources.coingecko = { status: 'error', lastError: String(e.message), at: runTs }; activity.unshift({ ts: runTs, type: 'data_failure', source: 'coingecko(global)', detail: String(e.message) }); }
  await sleep(2500);
  let coins = [];
  try {
    const m = await cg('/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=1h,24h,7d,30d,1y&sparkline=false');
    coins = m.map(x => {
      const liqRatio = x.market_cap ? x.total_volume / x.market_cap : null;
      const circ = x.circulating_supply, max = x.max_supply || x.total_supply;
      const supplyInflationPct = (max && circ) ? Math.max(0, (max - circ) / max * 100) : null;
      const flags = [];
      if (liqRatio != null && liqRatio < 0.005) flags.push('very_low_liquidity');
      if (x.market_cap && x.market_cap < 5e7) flags.push('micro_cap');
      if (x.ath_change_percentage != null && x.ath_change_percentage > -3) flags.push('near_ath');
      return {
        id: x.id, sym: (x.symbol || '').toUpperCase(), name: x.name, rank: x.market_cap_rank,
        price: x.current_price, mcap: x.market_cap, fdv: x.fully_diluted_valuation, vol: x.total_volume,
        liqRatio: round(liqRatio, 5), ath: x.ath, athChangePct: round(x.ath_change_percentage, 1),
        chg1h: round(x.price_change_percentage_1h_in_currency, 2), chg24h: round(x.price_change_percentage_24h_in_currency, 2),
        chg7d: round(x.price_change_percentage_7d_in_currency, 2), chg30d: round(x.price_change_percentage_30d_in_currency, 2),
        chg1y: round(x.price_change_percentage_1y_in_currency, 1),
        circ, total: x.total_supply, max, supplyInflationPct: round(supplyInflationPct, 1), flags,
      };
    });
    health.sources['coingecko-markets'] = { status: 'ok', lastOk: runTs, count: coins.length };
  } catch (e) { health.sources['coingecko-markets'] = { status: 'error', lastError: String(e.message), at: runTs }; activity.unshift({ ts: runTs, type: 'data_failure', source: 'coingecko(markets)', detail: String(e.message) }); }
  await sleep(2500);
  for (const c of coins) {
    if (['BTC', 'ETH'].includes(c.sym)) c.group = 'core';
    else if (c.rank && c.rank <= 20) c.group = 'large-cap';
    else if (c.flags.includes('very_low_liquidity') || c.flags.includes('micro_cap')) c.group = 'high-risk';
    else c.group = 'emerging';
    const mom = (c.chg7d || 0) * 0.5 + (c.chg30d || 0) * 0.5;
    const liqScore = (c.liqRatio || 0) * 1000;
    c.score = round(mom + liqScore + (c.athChangePct != null ? c.athChangePct / 10 : 0), 1);
  }
  const bySym = Object.fromEntries(coins.map(c => [c.sym, c]));
  const wl = (watchlist.symbols || []).filter(s => bySym[s]);
  const ranked = coins.filter(c => c.group !== 'high-risk' && !(c.flags || []).includes('very_low_liquidity')).sort((a, b) => (b.score || 0) - (a.score || 0));
  const shortSyms = [...new Set(['BTC', 'ETH', ...wl, ...ranked.slice(0, 12).map(c => c.sym)])].slice(0, 16);
  const order = ['BTC', ...shortSyms.filter(s => s !== 'BTC')];
  const closesBySym = {}; const indBySym = {};
  for (const sym of order) {
    const c = bySym[sym]; if (!c) continue;
    try {
      const mc = await cg(`/coins/${c.id}/market_chart?vs_currency=usd&days=365&interval=daily`);
      const daily = (mc.prices || []).map((p, i) => [Math.round(p[0] / 1000), round(p[1], p[1] > 100 ? 2 : 6), round((mc.total_volumes[i] || [0, 0])[1], 0)]);
      const closes = daily.map(d => d[1]); closesBySym[sym] = closes;
      const athFromHist = Math.max(...closes);
      const ind = {
        samples: closes.length,
        sma20: round(sma(closes, 20), closes.at(-1) > 100 ? 2 : 6),
        sma50: round(sma(closes, 50), closes.at(-1) > 100 ? 2 : 6),
        sma200: round(sma(closes, 200), closes.at(-1) > 100 ? 2 : 6),
        vol30: round(stdevReturns(closes.slice(-30)), 4),
        drawdownPct: round((closes.at(-1) - athFromHist) / athFromHist * 100, 1),
        distAthPct: c.athChangePct,
        mom30: round(pctChange(closes, 30), 2),
      };
      if (closesBySym.BTC && closesBySym.BTC.length > 31 && closes.length > 31) {
        const cg30 = pctChange(closes, 30), b30 = pctChange(closesBySym.BTC, 30);
        ind.rs30VsBtc = round((cg30 || 0) - (b30 || 0), 2);
      }
      ind.trend = (ind.sma50 && ind.sma200) ? (c.price > ind.sma50 && ind.sma50 > ind.sma200 ? 'up' : (c.price < ind.sma50 && ind.sma50 < ind.sma200 ? 'down' : 'mixed')) : 'n/a';
      indBySym[sym] = ind;
      write(`history/${sym}.json`, { sym, name: c.name, source: 'coingecko', ts: runTs, indicators: ind, daily });
    } catch (e) { activity.unshift({ ts: runTs, type: 'data_failure', source: `coingecko(history:${sym})`, detail: String(e.message) }); }
    await sleep(2500);
  }
  const latest = {};
  for (const sym of ['BTC', 'ETH']) {
    const c = bySym[sym]; if (!c) continue;
    let validated = null, cdc = null, dev = null;
    try { cdc = await cryptocomPrice(sym + '_USDT'); dev = round(Math.abs(cdc - c.price) / c.price * 100, 3); validated = dev <= 2; health.sources['crypto.com'] = { status: 'ok', lastOk: runTs }; }
    catch (e) { health.sources['crypto.com'] = { status: 'error', lastError: String(e.message), at: runTs }; }
    latest[sym] = { ts: runTs, symbol: sym, price: c.price, source: 'coingecko', crossCheck: cdc, crossCheckSource: 'crypto.com', deviationPct: dev, validated };
  }
  const verdicts = { ts: runTs, coins: {} };
  for (const sym of shortSyms) { const c = bySym[sym]; if (c) verdicts.coins[sym] = analyze(c, indBySym[sym], indBySym.BTC); }
  const cat = { ts: runTs };
  cat.longTerm = shortSyms.filter(s => ['Accumulate candidate', 'Hold'].includes(verdicts.coins[s] && verdicts.coins[s].horizons.long.label)).map(s => ({ sym: s, why: verdicts.coins[s].horizons.long.label }));
  cat.shortSetups = shortSyms.filter(s => ['Buy-zone candidate', 'Wait for confirmation'].includes(verdicts.coins[s] && verdicts.coins[s].horizons.short.label)).map(s => ({ sym: s, why: verdicts.coins[s].horizons.short.label }));
  cat.emerging = coins.filter(c => c.group === 'emerging').sort((a, b) => b.score - a.score).slice(0, 8).map(c => ({ sym: c.sym, why: `emerging rank #${c.rank}, score ${c.score}` }));
  cat.bigDrawdowns = coins.filter(c => c.athChangePct != null && c.athChangePct < -70 && c.rank <= 60).slice(0, 8).map(c => ({ sym: c.sym, why: `${c.athChangePct}% from ATH (value vs broken?)` }));
  cat.unusualVolume = coins.filter(c => c.liqRatio != null && c.liqRatio > 0.25).slice(0, 8).map(c => ({ sym: c.sym, why: `vol/mcap ${round(c.liqRatio * 100, 0)}% (high turnover)` }));
  cat.avoid = coins.filter(c => c.group === 'high-risk').slice(0, 10).map(c => ({ sym: c.sym, why: (c.flags || []).join(', ') || 'high-risk' }));
  const anyActionable = cat.longTerm.length || cat.shortSetups.length;
  cat.noAction = anyActionable ? null : 'No asset currently passes the quality + confirmation filters. Explicit no-action.';
  let regime = { label: 'Insufficient data' };
  if (closesBySym.BTC && closesBySym.BTC.length > 50) {
    const v = stdevReturns(closesBySym.BTC.slice(-30)); const drift = pctChange(closesBySym.BTC, 30);
    regime = { label: v > 0.045 ? 'Volatile' : drift > 8 ? 'Risk-on / uptrend' : drift < -8 ? 'Risk-off / downtrend' : 'Ranging', method: '30d BTC daily-return stdev + 30d drift', volatilityPct: round(v * 100, 2), driftPct: round(drift, 1), btcDominance: global.btcDominance ? round(global.btcDominance, 1) : null };
  }
  for (const p of paper.positions || []) { const c = bySym[p.symbol]; if (c) { p.markPrice = c.price; p.markTs = runTs; const g = (c.price - p.entryPrice) * p.qty * (p.side === 'short' ? -1 : 1); p.unrealizedPnl = round(g - (p.feesPaid || 0), 2); p.pnlPct = round(p.entryPrice ? g / (p.entryPrice * p.qty) * 100 : 0, 2); } }
  const briefing = {
    date: ams.date, timezone: 'Europe/Amsterdam', generatedAt: runTs,
    regime: regime.label, btcDominance: regime.btcDominance,
    conclusions: [
      cat.longTerm.length ? `Long-term interest: ${cat.longTerm.map(x => x.sym + ' (' + x.why + ')').join(', ')}` : 'No long-term Accumulate/Hold candidates today.',
      cat.shortSetups.length ? `Short-term setups: ${cat.shortSetups.map(x => x.sym + ' (' + x.why + ')').join(', ')}` : 'No confirmed short-term setups.',
      cat.bigDrawdowns.length ? `Deep drawdowns to investigate: ${cat.bigDrawdowns.slice(0, 4).map(x => x.sym).join(', ')}` : null,
      cat.avoid.length ? `Avoid/high-risk flagged: ${cat.avoid.length} assets` : null,
    ].filter(Boolean),
    risks: [regime.label === 'Volatile' ? 'Market volatile — wider stops, smaller size' : 'Regime ' + regime.label, 'Crypto is satellite risk, never house-deposit money'],
    researchPriorities: shortSyms.filter(s => verdicts.coins[s] && verdicts.coins[s].confidence === 'Low').slice(0, 4).map(s => s + ': gather history/fundamentals'),
  };
  meta.refreshes = [runTs, ...(meta.refreshes || [])].slice(0, 20);
  meta.lastRefresh = runTs; meta.lastRefreshAmsterdam = `${ams.date} ${ams.time} Europe/Amsterdam`;
  meta.latest = latest; meta.regime = regime; meta.shortlist = shortSyms; meta.universeCount = coins.length;
  meta.intervalPolicy = 'GitHub Actions cron */15 (best-effort) + manual dispatch; broad scan each run';
  meta.portfolio = { status: 'not_connected', note: 'Personal Crypto.com balances need a read-only API key you create.' };
  activity.unshift({ ts: runTs, type: 'scan', detail: `scanned ${coins.length} coins · shortlist ${shortSyms.length} · regime ${regime.label} · long ${cat.longTerm.length}/short ${cat.shortSetups.length} candidates` });
  while (activity.length > 300) activity.pop();
  write('global.json', global);
  write('market_scan.json', { ts: runTs, count: coins.length, coins });
  write('verdicts.json', verdicts);
  write('categories.json', cat);
  write('meta.json', meta);
  write('paper.json', paper);
  write('activity.json', activity);
  write('health.json', health);
  write('briefing.json', briefing);
  console.log('scan done', runTs, 'coins', coins.length, 'shortlist', shortSyms.join(','));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
