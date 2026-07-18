'use strict';
// Automated validity tests for the strategy engine. Run: node tests/strategy.test.js
const S = require('../scripts/strategy.js');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };

console.log('== 1. SOL real-world contradiction must resolve to No valid setup ==');
const sol = { sym: 'SOL', price: 80, mcap: 35e9, liqRatio: 0.02 };
const solInd = { sma20: 78, sma50: 73.44, sma200: 90.32, samples: 365 };
const solSetup = S.setupVerdict(sol, solInd);
ok('SOL setup label = No valid setup', solSetup.label === 'No valid setup');
ok('SOL rejected because not an uptrend', /not an uptrend/.test(solSetup.reason));
ok('SOL long-term is NOT Accumulate', S.longTermVerdict(sol, solInd, 'established', null).label.startsWith('Quant watch'));

console.log('== 2. A genuine uptrend produces a valid, correctly-ordered setup ==');
const up = { sym: 'XYZ', price: 110, mcap: 5e9, liqRatio: 0.03 };
const upInd = { sma20: 104, sma50: 100, sma200: 90, samples: 365 };
const upSetup = S.setupVerdict(up, upInd);
ok('uptrend setup passes QC', upSetup.qc.pass === true);
ok('label = Potential quantitative setup — not validated', upSetup.label === 'Potential quantitative setup — not validated');
const p = upSetup.proposal;
ok('stop < entry (long)', p.stop < p.entry);
ok('entry < target', p.entry < p.target);
ok('stop < current price', p.stop < p.currentPrice);
ok('reward:risk >= 1.5', p.rr >= 1.5);

console.log('== 3. QC blocks a mis-ordered proposal (stop above entry) ==');
const bad = { valid: true, side: 'long', currentPrice: 100, entry: 90, stop: 95, target: 110, rr: 2, entryDistPct: 5, minRR: 1.5, maxEntryDistPct: 15 };
const badQC = S.validateProposal(bad);
ok('mis-ordered long rejected', badQC.pass === false);
ok('failure names stop-below-entry rule', badQC.failures.some(x => /stop must be BELOW entry/.test(x)));

console.log('== 4. Conclusions change correctly when inputs change ==');
const same = { sym: 'ABC', price: 110, mcap: 5e9, liqRatio: 0.03 };
const trendUp = S.setupVerdict(same, { sma20: 104, sma50: 100, sma200: 90, samples: 365 });
const trendDown = S.setupVerdict({ ...same, price: 95 }, { sma20: 104, sma50: 100, sma200: 90, samples: 365 });
ok('uptrend => valid setup', trendUp.qc.pass === true);
ok('same asset, price below SMA50 => No valid setup', trendDown.label === 'No valid setup');

console.log('== 5. Classification uses explicit rules (fixes LTC) ==');
ok('LTC-like (mcap $6.5B, 1y history, liquid) = established', S.classify({ sym: 'LTC', mcap: 6.5e9, samples: 365, liqRatio: 0.03 }).group === 'established');
ok('HYPE-like (big mcap but <1y history) = emerging', S.classify({ sym: 'HYPE', mcap: 12e9, samples: 200, liqRatio: 0.05 }).group === 'emerging');
ok('stablecoin excluded', S.classify({ sym: 'USDC', mcap: 60e9, samples: 365, liqRatio: 0.2 }).group === 'stablecoin');
ok('illiquid micro = high-risk', S.classify({ sym: 'JUNK', mcap: 2e7, samples: 60, liqRatio: 0.0003 }).group === 'high-risk');

console.log('== 6. Backtest runs on real-shaped series and reports honest stats ==');
const closes = Array.from({ length: 400 }, (_, i) => 100 * (1 + 0.002 * i) + 5 * Math.sin(i / 6));
const bt = S.backtest(closes);
ok('backtest ok', bt.ok === true);
ok('backtest reports trades + winRate + buyHold', typeof bt.trades === 'number' && bt.winRatePct != null && bt.buyHoldPct != null);
console.log('    backtest:', JSON.stringify(bt));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
