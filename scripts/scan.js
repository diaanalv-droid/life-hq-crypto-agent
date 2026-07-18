// Life HQ — Crypto Strategist pipeline v3 (GitHub Actions, Node 20).
// Efficient + honest: curated shortlist, history caching, structured logging,
// exponential backoff + Retry-After, preserve-last-good, hard post-run validation.
// Read-only. No trading. No LLM calls.

const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data');
const HIST = path.join(DATA, 'history');
fs.mkdirSync(HIST, { recursive: true });

const CG = 'https://api.coingecko.com/api/v3';
const CG_KEY = process.env.COINGECKO_KEY || ''; // optional free demo key; header only, never logged
const nowIso = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };
const write = (f, o) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(o));
const round = (n, p = 2) => (n == null || !isFinite(n)) ? null : +n.toFixed(p);
const log = (...a) => console.log('[scan]', ...a);
const HIST_MAX_AGE_H = 20;

const STABLES = new Set(['USDT','USDC','USD1','USDD','DAI','FDUSD','TUSD','USDE','PYUSD','USDS','USDP','GUSD','BUSD','FRAX','LUSD','USDY','USYC','BUIDL','USDF','BFUSD','EUTBL','JTRSY','USTB','RLUSD']);
function isStable(c) {
  if (STABLES.has(c.sym)) return true;
  if (c.price != null && Math.abs(c.price - 1) < 0.02 && (c.chg30d == null || Math.abs(c.chg30d) < 1.5)) return true;
  return false;
}

async function cgFetch(pathq, label) {
  const url = CG + pathq + (CG_KEY ? (pathq.includes('?') ? '&' : '?') + 'x_cg_demo_api_key=' + CG_KEY : '');
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'life-hq-crypto-agent', ...(CG_KEY ? { 'x-cg-demo-api-key': CG_KEY } : {}) } });
      const ra = r.headers.get('retry-after');
      const remain = r.headers.get('x-ratelimit-remaining');
      if (r.status === 429) {
        const waitS = ra ? parseInt(ra) : Math.min(60, 2 ** attempt * 3);
        log(`[cg] ${label} -> 429 attempt${attempt} retry-after=${ra || 'n/a'} remaining=${remain || 'n/a'} waiting ${waitS}s`);
        await sleep(waitS * 1000); continue;
      }
      if (!r.ok) { log(`[cg] ${label} -> HTTP ${r.status} attempt${attempt}`); if (attempt === 4) throw new Error('HTTP ' + r.status); await sleep(2 ** attempt * 1500); continue; }
      const body = await r.json();
      const n = Array.isArray(body) ? body.length : (body.prices ? body.prices.length : 1);
      log(`[cg] ${label} -> 200 (${n} records) remaining=${remain || 'n/a'}`);
      return body;
    } catch (e) { log(`[cg] ${label} -> ERR ${e.message} attempt${attempt}`); if (attempt === 4) throw e; await sleep(2 ** attempt * 1500); }
  }
}
async function cryptocomPrice(inst) {
  const r = await fetch(`https://api.crypto.com/v2/public/get-ticker?instrument_name=${inst}`);
  const d = (await r.json()).result.data; const row = Array.isArray(d) ? d[0] : d;
  return Number(row.a ?? row.last);
}

function sma(a, n) { if (a.length < n) return null; return a.slice(-n).reduce((x, y) => x + y, 0) / n; }
function stdevReturns(c) { const r = []; for (let i = 1; i < c.length; i++) r.push((c[i] - c[i - 1]) / c[i - 1]); if (!r.length) return null; const m = r.reduce((x, y) => x + y, 0) / r.length; return Math.sqrt(r.reduce((x, y) => x + (y - m) ** 2, 0) / r.length); }
function pctChange(c, d) { if (c.length <= d) return null; const a = c[c.length - 1 - d], b = c[c.length - 1]; return (b - a) / a * 100; }
function amsterdam() { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; }

function analyze(c, ind) {
  const ev = { for: [], against: [], risks: [] };
  const liq = c.liqRatio, dd = ind ? ind.drawdownPct : null, distAth = c.athChangePct, vol30 = ind ? ind.vol30 : null;
  const above20 = ind && ind.sma20 != null && c.price > ind.sma20;
  const above50 = ind && ind.sma50 != null && c.price > ind.sma50;
  const above200 = ind && ind.sma200 != null && c.price > ind.sma200;
  const rs30 = ind ? ind.rs30VsBtc : null, mom30 = c.chg30d;
  const established = c.rank && c.rank <= 25, enoughHistory = ind && ind.samples >= 200;
  let veto = null;
  if (liq != null && liq < 0.002) veto = 'liquidity';
  if ((c.flags || []).includes('very_low_liquidity')) veto = 'liquidity';
  if (established) ev.for.push(`Established large-cap (rank #${c.rank})`);
  if (liq != null) (liq > 0.03 ? ev.for : ev.against).push(`Liquidity vol/mcap ${round(liq * 100, 2)}%`);
  if (above200) ev.for.push('Above 200-day average (long uptrend)'); else if (ind && ind.sma200 != null) ev.against.push('Below 200-day average (long downtrend)');
  if (above50) ev.for.push('Above 50-day average (medium uptrend)'); else if (ind && ind.sma50 != null) ev.against.push('Below 50-day average');
  if (rs30 != null) (rs30 > 0 ? ev.for : ev.against).push(`Relative strength vs BTC (30d) ${round(rs30, 1)}%`);
  if (dd != null) ev.risks.push(`Drawdown from ATH ${round(dd, 1)}%`);
  if (distAth != null && distAth > -8) ev.risks.push('Near all-time high — worse short-term entry');
  if (vol30 != null && vol30 > 0.06) ev.risks.push(`High volatility (${round(vol30 * 100, 1)}% daily)`);
  if (c.supplyInflationPct != null && c.supplyInflationPct > 25) ev.against.push(`Future dilution ~${round(c.supplyInflationPct, 0)}% of max not yet circulating`);
  let long = veto ? 'Avoid' : (!enoughHistory && !established) ? 'Insufficient evidence' : (established && dd != null && dd < -50 && liq > 0.02) ? 'Accumulate candidate' : (established && above200) ? 'Hold' : (established || (liq > 0.02 && above200)) ? 'Watch' : 'Insufficient evidence';
  let med = veto ? 'Avoid' : ind == null ? 'Insufficient evidence' : (above50 && above200 && (mom30 == null || mom30 > 0) && rs30 > 0) ? 'Hold' : (above50 && (rs30 == null || rs30 > -5)) ? 'Watch' : (!above50 && above200) ? 'Wait for confirmation' : 'Reduce exposure';
  let short = veto ? 'Avoid' : ind == null ? 'Insufficient evidence' : (distAth != null && distAth > -5) ? 'Reduce exposure' : (above20 && (c.chg7d == null || c.chg7d > 0)) ? 'Buy-zone candidate' : (!above20 && above50) ? 'Wait for confirmation' : 'Watch';
  let conf = enoughHistory && liq != null && liq > 0.01 ? (established ? 'High' : 'Medium') : ind ? 'Medium' : 'Low';
  return {
    name: c.name, symbol: c.sym, price: c.price, ts: nowIso(),
    horizons: { long: { label: long, focus: 'utility, adoption, tokenomics, survival (1–5y)' }, medium: { label: med, focus: 'cycle, catalysts, trend, RS (1–12m)' }, short: { label: short, focus: 'trend, momentum, volume, S/R (days–weeks)' } },
    bull: `${c.sym} ${above200 ? 'holds its long uptrend' : 'reclaims the 200-day average'} and ${dd != null && dd < -40 ? 'recovers part of its ' + round(-dd, 0) + '% drawdown' : 'momentum continues'}.`,
    base: `${c.sym} ranges with the market; ${established ? 'established position persists' : 'must prove durability'}.`,
    bear: `${c.sym} loses key averages${c.supplyInflationPct > 25 ? ', dilution adds sell pressure' : ''} and drawdown deepens.`,
    evidenceFor: ev.for, evidenceAgainst: ev.against, risks: ev.risks, confidence: conf,
    missing: ['On-chain activity', 'Verified unlock schedule', 'Audit/security history', 'Dated catalysts'],
    strategy: veto ? 'None — fails liquidity/quality filter' : long === 'Accumulate candidate' ? 'Long-term staged accumulation (DCA) into weakness' : short === 'Buy-zone candidate' ? 'Short-term trend continuation with tight invalidation' : 'Monitor; no action',
    entryZone: veto ? '—' : ind && ind.sma50 ? `Watch pullback toward 50-day avg ~$${round(ind.sma50, ind.sma50 > 100 ? 0 : 4)}` : 'Pending more history',
    invalidation: veto ? '—' : ind && ind.sma200 ? `Sustained close below 200-day avg ~$${round(ind.sma200, ind.sma200 > 100 ? 0 : 4)}` : 'Define once 200-day avg available',
    maxRisk: veto ? 'Excluded' : established ? 'Medium' : 'High',
    houseFit: 'Crypto is a satellite/high-risk sleeve — NOT house-deposit money.',
    sources: ['CoinGecko /coins/markets + /market_chart', 'Crypto.com public ticker'], dataFreshness: nowIso(),
  };
}

(async () => {
  const runTs = nowIso(), ams = amsterdam();
  const activity = read('activity.json', []), health = read('health.json', { sources: {} });
  const meta = read('meta.json', { refreshes: [] }), paper = read('paper.json', { positions: [] });
  const watchlist = read('watchlist.json', { symbols: ['BTC', 'ETH'] });
  const prevScan = read('market_scan.json', { coins: [] });
  const failed = [], skippedStable = [];

  let global = read('global.json', {});
  try { const d = (await cgFetch('/global', 'global')).data; global = { ts: runTs, totalMcapUsd: d.total_market_cap.usd, mcapChange24hPct: d.market_cap_change_percentage_24h_usd, btcDominance: d.market_cap_percentage.btc, ethDominance: d.market_cap_percentage.eth }; health.sources.coingecko = { status: 'ok', lastOk: runTs }; }
  catch (e) { health.sources.coingecko = { status: 'error', lastError: e.message, at: runTs }; log('global FAILED, preserving last-good'); }

  let coins = [];
  try {
    const m = await cgFetch('/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&price_change_percentage=1h,24h,7d,30d,1y&sparkline=false', 'markets(50)');
    coins = m.map(x => {
      const liqRatio = x.market_cap ? x.total_volume / x.market_cap : null, circ = x.circulating_supply, max = x.max_supply || x.total_supply;
      const flags = [];
      if (liqRatio != null && liqRatio < 0.005) flags.push('very_low_liquidity');
      if (x.market_cap && x.market_cap < 5e7) flags.push('micro_cap');
      return { id: x.id, sym: (x.symbol || '').toUpperCase(), name: x.name, rank: x.market_cap_rank, price: x.current_price, mcap: x.market_cap, fdv: x.fully_diluted_valuation, vol: x.total_volume, liqRatio: round(liqRatio, 5), ath: x.ath, athChangePct: round(x.ath_change_percentage, 1), chg1h: round(x.price_change_percentage_1h_in_currency, 2), chg24h: round(x.price_change_percentage_24h_in_currency, 2), chg7d: round(x.price_change_percentage_7d_in_currency, 2), chg30d: round(x.price_change_percentage_30d_in_currency, 2), chg1y: round(x.price_change_percentage_1y_in_currency, 1), circ, total: x.total_supply, max, supplyInflationPct: (max && circ) ? round(Math.max(0, (max - circ) / max * 100), 1) : null, flags };
    });
    health.sources['coingecko-markets'] = { status: 'ok', lastOk: runTs, count: coins.length };
  } catch (e) { health.sources['coingecko-markets'] = { status: 'error', lastError: e.message, at: runTs }; log('markets FAILED, preserving last-good scan'); coins = prevScan.coins || []; meta.stale = true; }

  for (const c of coins) {
    if (isStable(c)) { c.group = 'stablecoin'; if (!['BTC', 'ETH'].includes(c.sym)) skippedStable.push(c.sym); }
    else if (['BTC', 'ETH'].includes(c.sym)) c.group = 'core';
    else if ((c.flags || []).includes('very_low_liquidity') || (c.flags || []).includes('micro_cap')) c.group = 'high-risk';
    else if (c.rank && c.rank <= 20) c.group = 'large-cap';
    else c.group = 'emerging';
    c.score = round((c.chg7d || 0) * 0.5 + (c.chg30d || 0) * 0.5 + (c.liqRatio || 0) * 1000 + (c.athChangePct != null ? c.athChangePct / 10 : 0), 1);
  }
  const bySym = Object.fromEntries(coins.map(c => [c.sym, c]));

  const eligible = g => coins.filter(c => c.group === g && !(c.flags || []).includes('very_low_liquidity') && (c.liqRatio || 0) > 0.01).sort((a, b) => b.score - a.score);
  const established5 = [...eligible('large-cap'), ...eligible('core').filter(c => !['BTC', 'ETH'].includes(c.sym))].slice(0, 5).map(c => c.sym);
  const emerging5 = eligible('emerging').slice(0, 5).map(c => c.sym);
  const wl = (watchlist.symbols || []).filter(s => bySym[s] && bySym[s].group !== 'stablecoin');
  const shortSyms = [...new Set(['BTC', 'ETH', ...established5, ...emerging5, ...wl])].filter(s => bySym[s]).slice(0, 14);
  log(`shortlist established=[${established5}] emerging=[${emerging5}] final=[${shortSyms}]`);
  log(`skipped stablecoins from opportunities: [${skippedStable}]`);

  const order = ['BTC', ...shortSyms.filter(s => s !== 'BTC')];
  const closesBySym = {}, indBySym = {};
  let fetched = 0, cached = 0;
  for (const sym of order) {
    const c = bySym[sym]; if (!c) { failed.push({ sym, reason: 'not in universe' }); continue; }
    const existing = read(`history/${sym}.json`, null);
    const ageH = existing && existing.ts ? (Date.now() - new Date(existing.ts)) / 3.6e6 : Infinity;
    if (existing && existing.daily && existing.daily.length > 100 && ageH < HIST_MAX_AGE_H && sym !== 'BTC') {
      log(`[history] ${sym} CACHE hit (${round(ageH, 1)}h old, ${existing.daily.length} pts) — skip download`);
      closesBySym[sym] = existing.daily.map(d => d[1]); indBySym[sym] = existing.indicators; cached++; continue;
    }
    try {
      const mc = await cgFetch(`/coins/${c.id}/market_chart?vs_currency=usd&days=365&interval=daily`, `history:${sym}`);
      const daily = (mc.prices || []).map((p, i) => [Math.round(p[0] / 1000), round(p[1], p[1] > 100 ? 2 : 6), round((mc.total_volumes[i] || [0, 0])[1], 0)]);
      if (daily.length < 30) throw new Error(`only ${daily.length} candles`);
      const closes = daily.map(d => d[1]); closesBySym[sym] = closes;
      const athH = Math.max(...closes);
      const ind = { samples: closes.length, sma20: round(sma(closes, 20), closes.at(-1) > 100 ? 2 : 6), sma50: round(sma(closes, 50), closes.at(-1) > 100 ? 2 : 6), sma200: round(sma(closes, 200), closes.at(-1) > 100 ? 2 : 6), vol30: round(stdevReturns(closes.slice(-30)), 4), drawdownPct: round((closes.at(-1) - athH) / athH * 100, 1), distAthPct: c.athChangePct };
      if (closesBySym.BTC && closesBySym.BTC.length > 31 && closes.length > 31) ind.rs30VsBtc = round((pctChange(closes, 30) || 0) - (pctChange(closesBySym.BTC, 30) || 0), 2);
      indBySym[sym] = ind;
      write(`history/${sym}.json`, { sym, name: c.name, source: 'coingecko', ts: runTs, indicators: ind, daily });
      fetched++;
      await sleep(2500);
    } catch (e) {
      failed.push({ sym, reason: 'history: ' + e.message });
      log(`[history] ${sym} FAILED: ${e.message}`);
      if (existing) { closesBySym[sym] = existing.daily.map(d => d[1]); indBySym[sym] = existing.indicators; log(`[history] ${sym} using stale cached data`); }
    }
  }
  log(`history: fetched=${fetched} cached=${cached} failed=${failed.length}`);

  const latest = {};
  for (const sym of ['BTC', 'ETH']) { const c = bySym[sym]; if (!c) continue; let v = null, cdc = null, dev = null; try { cdc = await cryptocomPrice(sym + '_USDT'); dev = round(Math.abs(cdc - c.price) / c.price * 100, 3); v = dev <= 2; health.sources['crypto.com'] = { status: 'ok', lastOk: runTs }; } catch (e) { health.sources['crypto.com'] = { status: 'error', lastError: e.message, at: runTs }; log('crypto.com validation FAILED: ' + e.message); } latest[sym] = { ts: runTs, symbol: sym, price: c.price, source: 'coingecko', crossCheck: cdc, crossCheckSource: 'crypto.com', deviationPct: dev, validated: v }; }

  const verdicts = { ts: runTs, coins: {} };
  let analysed = 0;
  for (const sym of shortSyms) { const c = bySym[sym]; if (c) { verdicts.coins[sym] = analyze(c, indBySym[sym]); analysed++; } }

  const V = s => verdicts.coins[s];
  const cat = { ts: runTs };
  cat.longTerm = shortSyms.filter(s => V(s) && ['Accumulate candidate', 'Hold'].includes(V(s).horizons.long.label)).map(s => ({ sym: s, why: V(s).horizons.long.label }));
  cat.shortSetups = shortSyms.filter(s => V(s) && ['Buy-zone candidate', 'Wait for confirmation'].includes(V(s).horizons.short.label)).map(s => ({ sym: s, why: V(s).horizons.short.label }));
  cat.emerging = coins.filter(c => c.group === 'emerging').sort((a, b) => b.score - a.score).slice(0, 8).map(c => ({ sym: c.sym, why: `emerging rank #${c.rank}, score ${c.score}` }));
  cat.bigDrawdowns = coins.filter(c => c.group !== 'stablecoin' && c.athChangePct != null && c.athChangePct < -70 && c.rank <= 60).slice(0, 8).map(c => ({ sym: c.sym, why: `${c.athChangePct}% from ATH (value vs broken?)` }));
  cat.unusualVolume = coins.filter(c => c.group !== 'stablecoin' && c.liqRatio != null && c.liqRatio > 0.35).slice(0, 8).map(c => ({ sym: c.sym, why: `vol/mcap ${round(c.liqRatio * 100, 0)}% high turnover` }));
  cat.avoid = coins.filter(c => c.group === 'high-risk').slice(0, 10).map(c => ({ sym: c.sym, why: (c.flags || []).join(', ') || 'high-risk' }));
  cat.excludedStable = skippedStable;
  cat.noAction = (cat.longTerm.length || cat.shortSetups.length) ? null : 'No asset passes the quality + confirmation filters right now. Explicit no-action.';

  let regime = { label: 'Insufficient data' };
  if (closesBySym.BTC && closesBySym.BTC.length > 50) { const v = stdevReturns(closesBySym.BTC.slice(-30)), drift = pctChange(closesBySym.BTC, 30); regime = { label: v > 0.045 ? 'Volatile' : drift > 8 ? 'Risk-on / uptrend' : drift < -8 ? 'Risk-off / downtrend' : 'Ranging', method: '30d BTC daily-return stdev + 30d drift', volatilityPct: round(v * 100, 2), driftPct: round(drift, 1), btcDominance: global.btcDominance ? round(global.btcDominance, 1) : null }; }

  for (const p of paper.positions || []) { const c = bySym[p.symbol]; if (c) { p.markPrice = c.price; p.markTs = runTs; const g = (c.price - p.entryPrice) * p.qty * (p.side === 'short' ? -1 : 1); p.unrealizedPnl = round(g - (p.feesPaid || 0), 2); p.pnlPct = round(p.entryPrice ? g / (p.entryPrice * p.qty) * 100 : 0, 2); } }

  const briefing = { date: ams.date, timezone: 'Europe/Amsterdam', generatedAt: runTs, regime: regime.label, btcDominance: regime.btcDominance,
    conclusions: [ cat.longTerm.length ? `Long-term interest: ${cat.longTerm.map(x => x.sym + ' (' + x.why + ')').join(', ')}` : 'No long-term Accumulate/Hold candidates today.', cat.shortSetups.length ? `Short-term setups: ${cat.shortSetups.map(x => x.sym + ' (' + x.why + ')').join(', ')}` : 'No confirmed short-term setups.', cat.bigDrawdowns.length ? `Deep drawdowns to investigate: ${cat.bigDrawdowns.slice(0, 4).map(x => x.sym).join(', ')}` : null, `Excluded ${skippedStable.length} stablecoins from opportunities.` ].filter(Boolean),
    risks: [regime.label === 'Volatile' ? 'Volatile — smaller size, wider stops' : 'Regime ' + regime.label, 'Crypto is satellite risk, never house-deposit money'],
    researchPriorities: failed.map(f => `${f.sym}: ${f.reason}`).slice(0, 5) };

  meta.refreshes = [runTs, ...(meta.refreshes || [])].slice(0, 20);
  meta.lastRefresh = runTs; meta.lastRefreshAmsterdam = `${ams.date} ${ams.time} Europe/Amsterdam`;
  meta.latest = latest; meta.regime = regime; meta.shortlist = shortSyms; meta.universeCount = coins.length;
  meta.counts = { scanned: coins.length, analysed, historyFetched: fetched, historyCached: cached, failed: failed.length, stablecoinsExcluded: skippedStable.length };
  meta.failedAssets = failed; meta.stale = meta.stale || false;
  meta.intervalPolicy = 'Actions cron */15 (best-effort). Universe 50/1 request; histories cached <20h; validation cross-check each run.';
  meta.portfolio = { status: 'not_connected', note: 'Personal Crypto.com balances need a read-only API key you create.' };

  activity.unshift({ ts: runTs, type: 'scan', detail: `scanned ${coins.length} · analysed ${analysed} · history fetched ${fetched}/cached ${cached}/failed ${failed.length} · stables excluded ${skippedStable.length} · long ${cat.longTerm.length}/short ${cat.shortSetups.length}` });
  while (activity.length > 300) activity.pop();

  write('global.json', global); write('market_scan.json', { ts: runTs, count: coins.length, coins }); write('verdicts.json', verdicts); write('categories.json', cat); write('meta.json', meta); write('paper.json', paper); write('activity.json', activity); write('health.json', health); write('briefing.json', briefing);

  const problems = [];
  if (!coins.length) problems.push('market universe empty');
  if (!bySym.BTC || !bySym.ETH) problems.push('BTC/ETH missing from universe');
  if (!indBySym.BTC || !indBySym.ETH) problems.push('BTC/ETH history missing');
  if (!fs.existsSync(path.join(DATA, 'categories.json'))) problems.push('categories.json not written');
  for (const [s, v] of Object.entries(verdicts.coins)) { if (!v.sources || !v.sources.length || !v.dataFreshness) problems.push(`verdict ${s} missing sources/timestamp`); }
  log(`SUMMARY scanned=${coins.length} analysed=${analysed} fetched=${fetched} cached=${cached} failed=${JSON.stringify(failed)} stablesExcluded=${JSON.stringify(skippedStable)}`);
  if (problems.length) { console.error('[scan] VALIDATION FAILED:', problems.join('; ')); process.exit(1); }
  log('VALIDATION PASSED — outputs usable');
})().catch(e => { console.error('[scan] FATAL', e); process.exit(1); });
