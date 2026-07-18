// Life HQ — Crypto Strategist pipeline v4 (GitHub Actions, Node 20).
// Uses the unit-tested strategy engine (scripts/strategy.js).
// Read-only. No trading. No LLM calls.

const fs = require('fs');
const path = require('path');
const S = require('./strategy.js');
const DATA = path.join(__dirname, '..', 'data');
const HIST = path.join(DATA, 'history');
fs.mkdirSync(HIST, { recursive: true });

const CG = 'https://api.coingecko.com/api/v3';
const CG_KEY = process.env.COINGECKO_KEY || '';
const nowIso = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };
const write = (f, o) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(o));
const round = S.round;
const log = (...a) => console.log('[scan]', ...a);
const HIST_MAX_AGE_H = 20;
const BANNER = 'Research engine under validation — no verdict is currently a real-money recommendation.';

async function cgFetch(pathq, label) {
  const url = CG + pathq + (CG_KEY ? (pathq.includes('?') ? '&' : '?') + 'x_cg_demo_api_key=' + CG_KEY : '');
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'life-hq-crypto-agent', ...(CG_KEY ? { 'x-cg-demo-api-key': CG_KEY } : {}) } });
      const ra = r.headers.get('retry-after'), remain = r.headers.get('x-ratelimit-remaining');
      if (r.status === 429) { const w = ra ? parseInt(ra) : Math.min(60, 2 ** attempt * 3); log(`[cg] ${label} -> 429 attempt${attempt} retry-after=${ra || 'n/a'} remaining=${remain || 'n/a'} waiting ${w}s`); await sleep(w * 1000); continue; }
      if (!r.ok) { log(`[cg] ${label} -> HTTP ${r.status} attempt${attempt}`); if (attempt === 4) throw new Error('HTTP ' + r.status); await sleep(2 ** attempt * 1500); continue; }
      const body = await r.json(); const n = Array.isArray(body) ? body.length : (body.prices ? body.prices.length : 1);
      log(`[cg] ${label} -> 200 (${n} records) remaining=${remain || 'n/a'}`); return body;
    } catch (e) { log(`[cg] ${label} -> ERR ${e.message} attempt${attempt}`); if (attempt === 4) throw e; await sleep(2 ** attempt * 1500); }
  }
  throw new Error(`rate-limited after 4 attempts: ${label}`);
}
async function cryptocomPrice(inst) { const r = await fetch(`https://api.crypto.com/v2/public/get-ticker?instrument_name=${inst}`); const d = (await r.json()).result.data; const row = Array.isArray(d) ? d[0] : d; return Number(row.a ?? row.last); }
function sma(a, n) { if (a.length < n) return null; return a.slice(-n).reduce((x, y) => x + y, 0) / n; }
function stdev(c) { const r = []; for (let i = 1; i < c.length; i++) r.push((c[i] - c[i - 1]) / c[i - 1]); if (!r.length) return null; const m = r.reduce((x, y) => x + y, 0) / r.length; return Math.sqrt(r.reduce((x, y) => x + (y - m) ** 2, 0) / r.length); }
function pctChange(c, d) { if (c.length <= d) return null; return (c[c.length - 1] - c[c.length - 1 - d]) / c[c.length - 1 - d] * 100; }
function ams() { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; }

(async () => {
  const runTs = nowIso(), A = ams();
  log('[cg] auth mode:', CG_KEY ? 'demo-key present (masked)' : 'anonymous (no key)');
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
    coins = m.map(x => { const liqRatio = x.market_cap ? x.total_volume / x.market_cap : null, circ = x.circulating_supply, max = x.max_supply || x.total_supply; return { id: x.id, sym: (x.symbol || '').toUpperCase(), name: x.name, rank: x.market_cap_rank, price: x.current_price, mcap: x.market_cap, fdv: x.fully_diluted_valuation, vol: x.total_volume, liqRatio: round(liqRatio, 5), ath: x.ath, athChangePct: round(x.ath_change_percentage, 1), chg1h: round(x.price_change_percentage_1h_in_currency, 2), chg24h: round(x.price_change_percentage_24h_in_currency, 2), chg7d: round(x.price_change_percentage_7d_in_currency, 2), chg30d: round(x.price_change_percentage_30d_in_currency, 2), chg1y: round(x.price_change_percentage_1y_in_currency, 1), circ, total: x.total_supply, max, supplyInflationPct: (max && circ) ? round(Math.max(0, (max - circ) / max * 100), 1) : null, flags: [] }; });
    health.sources['coingecko-markets'] = { status: 'ok', lastOk: runTs, count: coins.length };
  } catch (e) { health.sources['coingecko-markets'] = { status: 'error', lastError: e.message, at: runTs }; log('markets FAILED — preserving last-good'); coins = prevScan.coins || []; meta.stale = true; }

  for (const c of coins) { if (c.liqRatio != null && c.liqRatio < 0.005) c.flags.push('very_low_liquidity'); if (c.mcap != null && c.mcap < 5e7) c.flags.push('micro_cap'); if (S.isStable(c) && !['BTC', 'ETH'].includes(c.sym)) skippedStable.push(c.sym); c.samples = null; }
  const bySym = Object.fromEntries(coins.map(c => [c.sym, c]));

  const pool = coins.filter(c => !S.isStable(c) && !c.flags.includes('very_low_liquidity') && !c.flags.includes('micro_cap') && (c.liqRatio || 0) >= 0.01);
  const estCand = pool.filter(c => c.mcap >= 3e9 && !['BTC', 'ETH'].includes(c.sym)).sort((a, b) => b.mcap - a.mcap).slice(0, 6).map(c => c.sym);
  const emgCand = pool.filter(c => c.mcap >= 3e8 && c.mcap < 3e9).sort((a, b) => b.mcap - a.mcap).slice(0, 6).map(c => c.sym);
  const wl = (watchlist.symbols || []).filter(s => bySym[s] && !S.isStable(bySym[s]));
  const shortSyms = [...new Set(['BTC', 'ETH', ...estCand, ...emgCand, ...wl])].filter(s => bySym[s]).slice(0, 14);
  log(`candidate established=[${estCand}] emerging=[${emgCand}] shortlist=[${shortSyms}] stablesExcluded=[${skippedStable}]`);

  const closesBySym = {}, indBySym = {}; let fetched = 0, cached = 0;
  for (const sym of ['BTC', ...shortSyms.filter(s => s !== 'BTC')]) {
    const c = bySym[sym]; if (!c) { failed.push({ sym, reason: 'not in universe' }); continue; }
    const ex = read(`history/${sym}.json`, null); const ageH = ex && ex.ts ? (Date.now() - new Date(ex.ts)) / 3.6e6 : Infinity;
    if (ex && ex.daily && ex.daily.length > 100 && ageH < HIST_MAX_AGE_H && sym !== 'BTC') { log(`[history] ${sym} CACHE hit (${round(ageH, 1)}h, ${ex.daily.length}pts)`); closesBySym[sym] = ex.daily.map(d => d[1]); indBySym[sym] = ex.indicators; c.samples = ex.indicators.samples; cached++; continue; }
    try {
      const mc = await cgFetch(`/coins/${c.id}/market_chart?vs_currency=usd&days=365&interval=daily`, `history:${sym}`);
      const daily = (mc.prices || []).map((p, i) => [Math.round(p[0] / 1000), round(p[1], p[1] > 100 ? 2 : 6), round((mc.total_volumes[i] || [0, 0])[1], 0)]);
      if (daily.length < 30) throw new Error(`only ${daily.length} candles`);
      const cl = daily.map(d => d[1]); closesBySym[sym] = cl; const athH = Math.max(...cl);
      const ind = { samples: cl.length, sma20: round(sma(cl, 20), cl.at(-1) > 100 ? 2 : 6), sma50: round(sma(cl, 50), cl.at(-1) > 100 ? 2 : 6), sma200: round(sma(cl, 200), cl.at(-1) > 100 ? 2 : 6), vol30: round(stdev(cl.slice(-30)), 4), drawdownPct: round((cl.at(-1) - athH) / athH * 100, 1), distAthPct: c.athChangePct };
      if (closesBySym.BTC && closesBySym.BTC.length > 31 && cl.length > 31) ind.rs30VsBtc = round((pctChange(cl, 30) || 0) - (pctChange(closesBySym.BTC, 30) || 0), 2);
      indBySym[sym] = ind; c.samples = ind.samples; write(`history/${sym}.json`, { sym, name: c.name, source: 'coingecko', ts: runTs, indicators: ind, daily }); fetched++; await sleep(2500);
    } catch (e) { failed.push({ sym, reason: 'history: ' + e.message }); log(`[history] ${sym} FAILED: ${e.message}`); if (ex) { closesBySym[sym] = ex.daily.map(d => d[1]); indBySym[sym] = ex.indicators; c.samples = ex.indicators.samples; } }
  }
  log(`history fetched=${fetched} cached=${cached} failed=${failed.length}`);

  for (const c of coins) { const cl = S.classify(c); c.group = cl.group; c.groupWhy = cl.why; c.score = round((c.chg7d || 0) * 0.5 + (c.chg30d || 0) * 0.5 + (c.liqRatio || 0) * 1000, 1); }

  const latest = {};
  for (const sym of ['BTC', 'ETH']) { const c = bySym[sym]; if (!c) continue; let v = null, cdc = null, dev = null; try { cdc = await cryptocomPrice(sym + '_USDT'); dev = round(Math.abs(cdc - c.price) / c.price * 100, 3); v = dev <= 2; health.sources['crypto.com'] = { status: 'ok', lastOk: runTs }; } catch (e) { health.sources['crypto.com'] = { status: 'error', lastError: e.message, at: runTs }; } latest[sym] = { ts: runTs, symbol: sym, price: c.price, source: 'coingecko', crossCheck: cdc, crossCheckSource: 'crypto.com', deviationPct: dev, validated: v }; }

  const verdicts = { ts: runTs, banner: BANNER, coins: {} }; let analysed = 0;
  for (const sym of shortSyms) {
    const c = bySym[sym]; if (!c) continue; const ind = indBySym[sym];
    const setup = S.setupVerdict(c, ind), lt = S.longTermVerdict(c, ind, c.group, null), pq = S.projectQuality(c, null), sc = S.scenarios(c, ind);
    verdicts.coins[sym] = {
      name: c.name, symbol: sym, price: c.price, group: c.group, groupWhy: c.groupWhy, ts: runTs,
      conclusions: { projectQuality: pq, longTerm: lt, tradeSetup: { label: setup.label, reason: setup.reason, proposal: setup.proposal, qc: setup.qc } },
      scenarios: { bull: sc.bull, base: sc.base, bear: sc.bear }, evidenceFor: sc.evidenceFor, evidenceAgainst: sc.evidenceAgainst, missingFundamentals: pq.missing,
      indicators: ind ? { sma20: ind.sma20, sma50: ind.sma50, sma200: ind.sma200, drawdownPct: ind.drawdownPct, rs30VsBtc: ind.rs30VsBtc } : null,
      confidence: ind && ind.samples >= 300 ? (c.group === 'established' ? 'High' : 'Medium') : ind ? 'Medium' : 'Low',
      houseFit: 'Crypto is a satellite/high-risk sleeve — NOT house-deposit money.',
      sources: ['CoinGecko /coins/markets + /market_chart', 'Crypto.com public ticker'], dataFreshness: runTs,
    }; analysed++;
  }

  const backtests = { ts: runTs, strategy: 'v1 pullback: in uptrend (SMA50>SMA200) buy reclaim of SMA20, exit close<SMA50', results: {} };
  for (const sym of ['BTC', 'ETH']) if (closesBySym[sym]) backtests.results[sym] = S.backtest(closesBySym[sym]);

  const V = s => verdicts.coins[s];
  const cat = { ts: runTs, banner: BANNER };
  cat.longResearch = shortSyms.filter(s => V(s) && /research candidate|Quant watch/i.test(V(s).conclusions.longTerm.label)).map(s => ({ sym: s, why: V(s).conclusions.longTerm.label }));
  cat.potentialSetups = shortSyms.filter(s => V(s) && V(s).conclusions.tradeSetup.label.startsWith('Potential')).map(s => ({ sym: s, why: V(s).conclusions.tradeSetup.label }));
  cat.noValidSetup = shortSyms.filter(s => V(s) && V(s).conclusions.tradeSetup.label === 'No valid setup').map(s => ({ sym: s, why: V(s).conclusions.tradeSetup.reason }));
  cat.emerging = coins.filter(c => c.group === 'emerging').sort((a, b) => b.mcap - a.mcap).slice(0, 8).map(c => ({ sym: c.sym, why: c.groupWhy }));
  cat.bigDrawdowns = coins.filter(c => c.group !== 'stablecoin' && c.athChangePct != null && c.athChangePct < -70 && c.rank <= 60).slice(0, 8).map(c => ({ sym: c.sym, why: `${c.athChangePct}% from ATH — investigate (value vs broken)` }));
  cat.avoid = coins.filter(c => c.group === 'high-risk').slice(0, 10).map(c => ({ sym: c.sym, why: c.groupWhy }));
  cat.excludedStable = skippedStable;
  cat.noAction = (cat.potentialSetups.length) ? null : 'No asset currently presents a valid, QC-passing trade setup. Explicit no-action.';

  let regime = { label: 'Insufficient data' };
  if (closesBySym.BTC && closesBySym.BTC.length > 50) { const v = stdev(closesBySym.BTC.slice(-30)), drift = pctChange(closesBySym.BTC, 30); regime = { label: v > 0.045 ? 'Volatile' : drift > 8 ? 'Risk-on / uptrend' : drift < -8 ? 'Risk-off / downtrend' : 'Ranging', method: '30d BTC daily-return stdev + 30d drift', volatilityPct: round(v * 100, 2), driftPct: round(drift, 1), btcDominance: global.btcDominance ? round(global.btcDominance, 1) : null }; }

  for (const p of paper.positions || []) { const c = bySym[p.symbol]; if (c) { p.markPrice = c.price; p.markTs = runTs; const g = (c.price - p.entryPrice) * p.qty * (p.side === 'short' ? -1 : 1); p.unrealizedPnl = round(g - (p.feesPaid || 0), 2); p.pnlPct = round(p.entryPrice ? g / (p.entryPrice * p.qty) * 100 : 0, 2); } }

  const briefing = { date: A.date, timezone: 'Europe/Amsterdam', generatedAt: runTs, banner: BANNER, regime: regime.label, btcDominance: regime.btcDominance,
    conclusions: [ cat.potentialSetups.length ? `Potential (unvalidated) setups: ${cat.potentialSetups.map(x => x.sym).join(', ')}` : 'No valid trade setups right now.', cat.longResearch.length ? `Long-term research candidates: ${cat.longResearch.map(x => x.sym).join(', ')}` : 'No long-term research candidates.', `Excluded ${skippedStable.length} stablecoins; ${cat.noValidSetup.length} shortlist coins had no valid setup.` ],
    risks: [regime.label === 'Volatile' ? 'Volatile — smaller size, wider stops' : 'Regime ' + regime.label, 'Engine under validation — no verdict is a real-money recommendation'], researchPriorities: failed.map(f => `${f.sym}: ${f.reason}`).slice(0, 5) };

  meta.refreshes = [runTs, ...(meta.refreshes || [])].slice(0, 20);
  meta.lastRefresh = runTs; meta.lastRefreshAmsterdam = `${A.date} ${A.time} Europe/Amsterdam`;
  meta.latest = latest; meta.regime = regime; meta.shortlist = shortSyms; meta.universeCount = coins.length; meta.banner = BANNER;
  meta.classificationRules = { established: 'non-stable, liquid (vol/mcap≥1%), ≥330 daily candles (≥~1y history), mcap≥$3B', emerging: 'non-stable, liquid, mcap $0.3–3B OR <~1y history', highRisk: 'illiquid (vol/mcap<0.5%) or micro-cap (<$50M)', stablecoin: 'symbol in stable set or pegged ~$1' };
  meta.counts = { scanned: coins.length, analysed, historyFetched: fetched, historyCached: cached, failed: failed.length, stablecoinsExcluded: skippedStable.length, noValidSetup: cat.noValidSetup.length, potentialSetups: cat.potentialSetups.length };
  meta.failedAssets = failed; meta.stale = meta.stale || false;
  meta.intervalPolicy = 'Actions cron */15 (best-effort). Universe 50/1 request; histories cached <20h.';
  meta.portfolio = { status: 'not_connected', note: 'Personal Crypto.com balances need a read-only API key you create.' };

  activity.unshift({ ts: runTs, type: 'scan', detail: `scanned ${coins.length} · analysed ${analysed} · potential-setups ${cat.potentialSetups.length} · no-valid-setup ${cat.noValidSetup.length} · long-research ${cat.longResearch.length} · fetched ${fetched}/cached ${cached}/failed ${failed.length}` });
  while (activity.length > 300) activity.pop();

  write('global.json', global); write('market_scan.json', { ts: runTs, count: coins.length, coins }); write('verdicts.json', verdicts); write('categories.json', cat); write('backtest.json', backtests); write('meta.json', meta); write('paper.json', paper); write('activity.json', activity); write('health.json', health); write('briefing.json', briefing);

  const problems = [];
  if (!coins.length) problems.push('market universe empty');
  if (!bySym.BTC || !bySym.ETH) problems.push('BTC/ETH missing');
  if (!indBySym.BTC || !indBySym.ETH) problems.push('BTC/ETH history missing');
  for (const [s, v] of Object.entries(verdicts.coins)) { const ts = v.conclusions.tradeSetup; if (ts.proposal) { const p = ts.proposal; if (!(p.stop < p.entry && p.entry < p.target)) problems.push(`${s} setup ordering invalid`); } if (!v.sources || !v.dataFreshness) problems.push(`${s} missing sources/timestamp`); }
  log(`SUMMARY scanned=${coins.length} analysed=${analysed} potentialSetups=${cat.potentialSetups.length} noValidSetup=${cat.noValidSetup.length} failed=${JSON.stringify(failed)} stablesExcluded=${JSON.stringify(skippedStable)}`);
  if (problems.length) { console.error('[scan] VALIDATION FAILED:', problems.join('; ')); process.exit(1); }
  log('VALIDATION PASSED — outputs usable');
})().catch(e => { console.error('[scan] FATAL', e); process.exit(1); });
