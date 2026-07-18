// Life HQ — Crypto Intelligence Agent · data pipeline
// Runs on GitHub Actions (Node 20, global fetch). Fetches real market data,
// cross-validates against a second source, persists history, updates paper
// positions, computes a transparent market regime, logs activity + health,
// and writes a daily briefing in Europe/Amsterdam time. Read-only. No trading.

const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data');

const SYMBOLS = [
  { sym: 'BTC', cdc: 'BTC_USDT', cg: 'bitcoin' },
  { sym: 'ETH', cdc: 'ETH_USDT', cg: 'ethereum' },
];
const FORCE_FAIL = (process.env.FORCE_FAIL || '').toLowerCase(); // demo failure state

const nowIso = () => new Date().toISOString();
const read = (f, dflt) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return dflt; } };
const write = (f, obj) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(obj, null, 2));

async function getJson(url, ms = 9000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  const started = Date.now();
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': 'life-hq-crypto-agent' } });
    const body = await r.json();
    return { ok: r.ok, status: r.status, body, latency: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e), latency: Date.now() - started };
  } finally { clearTimeout(t); }
}

// --- Source A: Crypto.com public (primary) ---
async function fromCryptoCom(inst) {
  if (FORCE_FAIL === 'crypto.com') throw new Error('FORCED FAILURE (demo): crypto.com');
  const r = await getJson(`https://api.crypto.com/v2/public/get-ticker?instrument_name=${inst}`);
  if (!r.ok || !r.body) throw new Error(`crypto.com HTTP ${r.status} ${r.error || ''}`);
  const d = (r.body.result && r.body.result.data) || {};
  const row = Array.isArray(d) ? d[0] : d;
  const price = Number(row.a ?? row.last); // 'a' = latest trade price
  if (!isFinite(price)) throw new Error('crypto.com: no price field');
  return { price, volume: Number(row.v ?? row.volume ?? 0), latency: r.latency };
}
// --- Source B: CoinGecko (validation) ---
async function fromCoinGecko() {
  if (FORCE_FAIL === 'coingecko') throw new Error('FORCED FAILURE (demo): coingecko');
  const r = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true');
  if (!r.ok || !r.body) throw new Error(`coingecko HTTP ${r.status} ${r.error || ''}`);
  return r.body;
}

function amsterdamParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function regimeFor(sym, history) {
  const pts = history.filter(h => h.symbol === sym).slice(-48).map(h => h.price);
  if (pts.length < 4) return { label: 'Insufficient data', method: 'need >= 4 samples', samples: pts.length };
  const rets = [];
  for (let i = 1; i < pts.length; i++) rets.push((pts[i] - pts[i - 1]) / pts[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const vol = Math.sqrt(variance);
  const drift = (pts[pts.length - 1] - pts[0]) / pts[0];
  let label = 'Calm';
  if (vol > 0.01) label = 'Volatile';
  else if (drift > 0.02) label = 'Trending up';
  else if (drift < -0.02) label = 'Trending down';
  return { label, method: 'stdev of last<=48 sample-returns; >1% => Volatile; else drift +/-2% => Trending', volatilityPct: +(vol * 100).toFixed(3), driftPct: +(drift * 100).toFixed(2), samples: pts.length };
}

(async () => {
  const runTs = nowIso();
  const ams = amsterdamParts();
  const history = read('price_history.json', []);
  const health = read('health.json', { sources: {} });
  const activity = read('activity.json', []);
  const meta = read('meta.json', { refreshes: [] });
  const paper = read('paper.json', { cash: 0, positions: [], transactions: [], startedAt: runTs });
  const latest = {};
  let cg = null;
  try { cg = await fromCoinGecko(); health.sources.coingecko = { status: 'ok', lastOk: runTs }; }
  catch (e) { health.sources.coingecko = { status: 'error', lastError: String(e.message), at: runTs }; activity.unshift({ ts: runTs, type: 'data_failure', source: 'coingecko', detail: String(e.message) }); }

  for (const s of SYMBOLS) {
    try {
      const a = await fromCryptoCom(s.cdc);
      let validated = false, altPrice = null, deviationPct = null;
      const cgPrice = cg && cg[s.cg] && cg[s.cg].usd;
      if (isFinite(cgPrice)) {
        altPrice = cgPrice;
        deviationPct = +(Math.abs(a.price - cgPrice) / cgPrice * 100).toFixed(3);
        validated = deviationPct <= 2;
        if (!validated) activity.unshift({ ts: runTs, type: 'validation_warning', symbol: s.sym, detail: `crypto.com vs coingecko deviate ${deviationPct}%` });
      }
      const rec = { ts: runTs, symbol: s.sym, price: a.price, volume: a.volume, source: 'crypto.com', validatedAgainst: 'coingecko', altPrice, deviationPct, validated };
      history.push(rec);
      latest[s.sym] = rec;
      health.sources['crypto.com'] = { status: 'ok', lastOk: runTs, latencyMs: a.latency };
    } catch (e) {
      health.sources['crypto.com'] = { status: 'error', lastError: String(e.message), at: runTs };
      activity.unshift({ ts: runTs, type: 'data_failure', source: 'crypto.com', symbol: s.sym, detail: String(e.message) });
    }
  }

  while (history.length > 8000) history.shift();

  for (const p of paper.positions) {
    const l = latest[p.symbol];
    if (l) {
      p.markPrice = l.price;
      p.markTs = runTs;
      const gross = (l.price - p.entryPrice) * p.qty * (p.side === 'short' ? -1 : 1);
      p.unrealizedPnl = +(gross - (p.feesPaid || 0)).toFixed(2);
      p.pnlPct = +((p.entryPrice ? (gross / (p.entryPrice * p.qty)) * 100 : 0)).toFixed(2);
    }
  }

  const regime = {};
  for (const s of SYMBOLS) regime[s.sym] = regimeFor(s.sym, history);

  meta.refreshes = [runTs, ...(meta.refreshes || [])].slice(0, 20);
  meta.lastRefresh = runTs;
  meta.lastRefreshAmsterdam = `${ams.date} ${ams.time} Europe/Amsterdam`;
  meta.latest = latest;
  meta.regime = regime;
  meta.intervalPolicy = 'GitHub Actions cron */15 (min ~5m, best-effort) + manual dispatch';

  const okCount = Object.values(health.sources).filter(x => x.status === 'ok').length;
  activity.unshift({ ts: runTs, type: 'refresh', detail: `pipeline run · ${Object.keys(latest).length} priced · sources ok=${okCount}`, symbols: latest });
  while (activity.length > 300) activity.pop();

  const briefing = read('briefing.json', { date: null });
  if (briefing.date !== ams.date && Object.keys(latest).length) {
    briefing.date = ams.date;
    briefing.generatedAt = runTs;
    briefing.timezone = 'Europe/Amsterdam';
    briefing.lines = SYMBOLS.filter(s => latest[s.sym]).map(s => {
      const l = latest[s.sym]; const rg = regime[s.sym];
      return `${s.sym}: $${l.price.toLocaleString()} · regime ${rg.label} (drift ${rg.driftPct ?? '—'}%, vol ${rg.volatilityPct ?? '—'}%) · source ${l.source}${l.validated ? ' ✓validated' : ' (unvalidated)'}`;
    });
    write('briefing.json', briefing);
  }

  write('price_history.json', history);
  write('health.json', health);
  write('activity.json', activity);
  write('meta.json', meta);
  write('paper.json', paper);
  console.log('pipeline done', runTs, 'priced:', Object.keys(latest));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
