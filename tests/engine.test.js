'use strict';
// Validity tests for the NEW engines: liquidity, dilution, fundamentals, trend_v1.
const L = require('../scripts/liquidity.js');
const D = require('../scripts/dilution.js');
const F = require('../scripts/fundamentals.js');
const T = require('../scripts/trend.js');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n); } };
const NOW = '2026-07-18T18:27:27.405Z';

console.log('== LIQUIDITY: turnover must NOT alone brand a big-cap as illiquid/high-risk ==');
const bnb = L.assessLiquidity({ sym: 'BNB', vol: 422.1e6, mcap: 76.073e9 }, {});
ok('BNB not "Low liquidity"', bnb.category !== 'Low liquidity');
ok('BNB not excluded on turnover alone', bnb.excluded === false);
ok('BNB category = Likely adequate for small orders', bnb.category === 'Likely adequate for small orders');
ok('turnover explicitly renamed (screening signal)', /screening signal/.test(bnb.turnoverNote));
ok('BNB execution NOT fully assessed w/o tickers', bnb.executionAssessed === false);
const xrp = L.assessLiquidity({ sym: 'XRP', vol: 609.2e6, mcap: 68.268e9 }, {});
const trx = L.assessLiquidity({ sym: 'TRX', vol: 296.1e6, mcap: 30.832e9 }, {});
ok('XRP not excluded', xrp.excluded === false && xrp.category !== 'Low liquidity');
ok('TRX not excluded', trx.excluded === false && trx.category !== 'Low liquidity');

console.log('== LIQUIDITY: genuinely tiny volume stays low ==');
const leo = L.assessLiquidity({ sym: 'LEO', vol: 0.3e6, mcap: 9.007e9 }, {});
ok('LEO = Low liquidity', leo.category === 'Low liquidity');
ok('LEO excluded', leo.excluded === true);

console.log('== LIQUIDITY: with tickers we can reach High execution liquidity ==');
const rawT = [
  { market: { name: 'Binance' }, trust_score: 'green', bid_ask_spread_percentage: 0.02, converted_volume: { usd: 40e6 }, base: 'ETH', target: 'USDT' },
  { market: { name: 'Coinbase Exchange' }, trust_score: 'green', bid_ask_spread_percentage: 0.05, converted_volume: { usd: 30e6 }, base: 'ETH', target: 'USD' },
  { market: { name: 'Kraken' }, trust_score: 'green', bid_ask_spread_percentage: 0.04, converted_volume: { usd: 20e6 }, base: 'ETH', target: 'USD' },
];
const sum = L.summariseTickers(rawT);
ok('summarise: 3 reputable venues', sum.reputableCount === 3);
ok('summarise: median green spread computed', sum.medianGreenSpreadPct != null);
const eth = L.assessLiquidity({ sym: 'ETH', vol: 90e6, mcap: 300e9 }, { tickers: sum, orderUsd: 5000, volSeriesUsd: [80e6, 85e6, 90e6, 88e6, 84e6, 86e6, 92e6] });
ok('ETH = High execution liquidity', eth.category === 'High execution liquidity');
ok('ETH execution assessed = true', eth.executionAssessed === true);
ok('ETH tradeEligible', eth.tradeEligible === true);
ok('ETH slippage estimate present', eth.slippageEstimate && eth.slippageEstimate.estBps != null);

console.log('== LIQUIDITY: inflated/anomaly volume => suspicious ==');
const rawAnom = [
  { market: { name: 'NoName' }, trust_score: 'yellow', is_anomaly: true, converted_volume: { usd: 80e6 }, base: 'X', target: 'USDT' },
  { market: { name: 'NoName2' }, trust_score: 'red', is_anomaly: true, converted_volume: { usd: 40e6 }, base: 'X', target: 'USDT' },
];
const susp = L.assessLiquidity({ sym: 'X', vol: 120e6, mcap: 1e9 }, { tickers: L.summariseTickers(rawAnom) });
ok('suspicious volume category', susp.category === 'Unreliable/suspicious volume');
ok('suspicious excluded', susp.excluded === true);

console.log('== LIQUIDITY: no data at all => Insufficient data, NOT high-risk ==');
const nd = L.assessLiquidity({ sym: 'Z', vol: null, mcap: null }, {});
ok('Insufficient data', nd.category === 'Insufficient data');
ok('not excluded as high-risk', nd.excluded === false);

console.log('== DILUTION: never "no risk" from missing data; supply math when present ==');
const dilHigh = D.assessDilution({ sym: 'A', price: 2, mcap: 1e9, fdv: 3e9, circ: 300e6, total: 1e9, max: 1e9 });
ok('remaining dilution computed', dilHigh.remainingDilutionPct === 70);
ok('High dilution ahead', dilHigh.category === 'High dilution ahead');
ok('FDV gap surfaced', dilHigh.fdvGapPct === 200);
const dilFull = D.assessDilution({ sym: 'B', price: 1, mcap: 1e9, fdv: 1e9, circ: 1e9, total: 1e9, max: 1e9 });
ok('fully circulating', dilFull.category === 'Fully circulating (supply side)');
const dilNo = D.assessDilution({ sym: 'C', price: 1, mcap: null, fdv: null, circ: null, total: null, max: null });
ok('insufficient supply data (not zero risk)', dilNo.category === 'Insufficient supply data');
ok('never emits "no unlock risk"', !JSON.stringify(dilNo).toLowerCase().includes('no unlock risk') && !JSON.stringify(dilNo).toLowerCase().includes('no dilution risk'));
ok('unlock schedule flagged unavailable', dilNo.unlockScheduleAvailable === false && /UNAVAILABLE/.test(dilNo.unlockStatus));
const dilUncapped = D.assessDilution({ sym: 'ETH', price: 3000, mcap: 360e9, fdv: 360e9, circ: 120e6, total: 120e6, max: null });
ok('uncapped emission flagged', dilUncapped.uncapped === true);

console.log('== FUNDAMENTALS: description ALONE cannot produce a positive verdict ==');
const raw = { description: { en: 'Solana is a high-performance blockchain. It is amazing and the best.' }, categories: ['Smart Contract Platform', 'Solana Ecosystem'], genesis_date: '2020-04-10', developer_data: { commit_count_4_weeks: 120, stars: 12000 }, links: { repos_url: { github: ['https://github.com/solana-labs/solana'] } } };
const dos = F.buildDossier(raw, { sym: 'SOL', name: 'Solana', circ: 560e6, total: 600e6, max: null, fdv: 45e9, mcap: 42e9, supplyInflationPct: 6.7, athChangePct: -70, chg1y: -30 }, NOW);
ok('project quality still Not assessed', dos.projectQuality.label === 'Not assessed');
ok('facts carry source + retrievedAt', dos.identity.category.source && dos.identity.category.retrievedAt === NOW);
ok('missing durability listed', dos.projectQuality.missingDurabilityInputs.length >= 10);
ok('dev activity collected as real input', dos.development.commits4w.value === 120 && dos.development.activityLabel.value === 'active');
ok('purpose confidence is low (desc only)', dos.identity.purpose.confidence === 'low');
ok('contradicting evidence present (below ATH)', dos.contradicting.some(x => /all-time high/.test(x)));
const dosEmpty = F.buildDossier({}, { sym: 'ZZZ', name: 'Zed', circ: null, total: null, max: null, fdv: null, mcap: null }, NOW);
ok('missing fact => value null, confidence none', dosEmpty.identity.launchDate.value === null && dosEmpty.identity.launchDate.confidence === 'none');

console.log('== TREND_V1: rules frozen + realistic backtest + honest validation gate ==');
ok('rules id/version present', T.TREND_V1.id === 'trend_v1' && T.TREND_V1.version === '1.0.0');
ok('costs modelled', T.TREND_V1.costs.feeBpsPerSide === 10 && T.TREND_V1.costs.slippageBpsPerSide === 15);
// synthetic 400-day uptrend with pullbacks
const daily = Array.from({ length: 400 }, (_, i) => [1e6 + i * 86400, 100 * (1 + 0.0015 * i) + 6 * Math.sin(i / 5), 1e6 + 5e5 * (1 + Math.sin(i / 3))]);
const bt = T.trendV1Backtest(daily);
ok('backtest ok', bt.ok === true);
ok('reports full metric set', ['returnPct', 'maxDrawdownPct', 'winRatePct', 'profitFactor', 'timeInMarketPct', 'sharpeAnnual', 'buyHoldPct'].every(k => k in bt));
ok('no-look-ahead: has tradeList with entry<=exit ts', bt.tradeList.every(t => t.entryTs <= t.exitTs));
ok('needs >=250 candles enforced', T.trendV1Backtest(daily.slice(0, 100)).ok === false);
const sp = T.splitBacktest(daily);
ok('split produces in + out sample', sp.ok === true && sp.inSample.ok && sp.outOfSample.ok);
const agg = T.aggregate({ BTC: bt, ETH: T.trendV1Backtest(daily) });
ok('aggregate never sets validated=true', agg.validated === false);
ok('few trades => FAILED gate wording', /Insufficient sample|not yet validated/.test(agg.validationStatus));

console.log('== TREND_V1: latestSignal fires a well-formed, ordered entry on a fresh reclaim ==');
// build 260 bars: strong uptrend, then a 1-bar dip to below SMA20 on the penultimate bar,
// then a reclaim close above SMA20 on the last bar.
const upDaily = [];
for (let i = 0; i < 258; i++) upDaily.push([1e6 + i * 86400, 100 + i * 1.2, 5e6]);
const s20now = upDaily.slice(-20).reduce((a, d) => a + d[1], 0) / 20;
upDaily.push([1e6 + 258 * 86400, s20now - 5, 5e6]);
upDaily.push([1e6 + 259 * 86400, upDaily[257][1] + 2, 5e6]);
const liqOk = { tradeEligible: true, category: 'High execution liquidity' };
const ls = T.latestSignal(upDaily, liqOk);
ok('latestSignal fires', ls.signal === true);
ok('entry/stop ordered (stop<entry)', ls.signal && ls.stop < ls.entry);
ok('position size fraction within cap', ls.signal && ls.sizeFracEquity > 0 && ls.sizeFracEquity <= 0.25);
ok('exit + invalidation rules attached', ls.signal && /SMA50/.test(ls.exitRule) && /SMA200/.test(ls.invalidation));
ok('latestSignal blocks when liquidity not eligible', T.latestSignal(upDaily, { tradeEligible: false, category: 'Low liquidity' }).signal === false);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
