'use strict';
// Life HQ — token-unlock & dilution risk (pure, unit-tested). Best FREE version first.
//
// Hard rule: NEVER output "no unlock risk" merely because unlock data could not be
// found. Absence of a schedule => risk is UNKNOWN, not zero. We separate what supply
// math tells us (circulating vs total vs max => remaining dilution) from what we do
// NOT have for free (dated unlock cliffs, team/insider allocation, vesting curves).

const round = (n, p = 2) => (n == null || !isFinite(n)) ? null : +n.toFixed(p);

// c: {sym, price, mcap, fdv, circ (circulating), total (total supply), max (max supply)}
// unlockFacts: optional array of verified {date, amountTokens, pctOfCirc, source, retrievedAt, confidence}
function assessDilution(c, unlockFacts = null) {
  const circ = num(c.circ), total = num(c.total), max = num(c.max), price = num(c.price);
  const evidence = [], caveats = [];

  // reference supply cap: prefer max; else total; else unknown
  const cap = max != null ? max : (total != null ? total : null);
  const capBasis = max != null ? 'max supply' : (total != null ? 'total supply (no hard max published)' : 'unknown');

  let remainingDilutionPct = null, notYetCirculating = null;
  if (cap != null && circ != null && cap > 0) {
    notYetCirculating = Math.max(0, cap - circ);
    remainingDilutionPct = round(notYetCirculating / cap * 100, 1);
    evidence.push(`Circulating ${fmt(circ)} of ${fmt(cap)} ${capBasis} — ${remainingDilutionPct}% not yet circulating`);
  } else caveats.push('Circulating/total/max supply incomplete — remaining dilution not computable');

  // FDV vs mcap gap (market's own dilution signal)
  let fdvGapPct = null;
  if (c.fdv != null && c.mcap != null && c.mcap > 0) { fdvGapPct = round((c.fdv - c.mcap) / c.mcap * 100, 1); if (fdvGapPct > 0) evidence.push(`Fully-diluted valuation ${fdvGapPct}% above market cap (FDV $${fmt(c.fdv)} vs mcap $${fmt(c.mcap)})`); }

  // infinite / uncapped emission (no max supply)
  const uncapped = max == null;
  if (uncapped) caveats.push('No published hard max supply — token may have ongoing/uncapped issuance (staking/emissions); treat remaining-dilution as a floor');

  // dated unlock cliffs — only if verified facts supplied; otherwise explicitly unknown
  let nextUnlock = null, unlockStatus;
  if (Array.isArray(unlockFacts) && unlockFacts.length) {
    const future = unlockFacts.filter(u => u.date).sort((a, b) => new Date(a.date) - new Date(b.date));
    nextUnlock = future[0] || null;
    unlockStatus = nextUnlock ? `Next verified unlock ${nextUnlock.date}: ${nextUnlock.amountTokens ? fmt(nextUnlock.amountTokens) + ' tokens' : ''}${nextUnlock.pctOfCirc ? ' (~' + nextUnlock.pctOfCirc + '% of circulating)' : ''}` : 'No dated unlock in supplied facts';
    if (nextUnlock) evidence.push(unlockStatus + ` [source: ${nextUnlock.source || 'n/a'}]`);
  } else {
    unlockStatus = 'Dated unlock schedule UNAVAILABLE from free sources — unlock cliffs unknown, NOT assumed zero';
    caveats.push(unlockStatus);
  }

  // ---- deterministic dilution-risk category (evidence-based; unknown stays unknown) ----
  let category, basis;
  if (remainingDilutionPct == null) { category = 'Insufficient supply data'; basis = 'cannot compute remaining dilution'; }
  else if (uncapped && remainingDilutionPct >= 5) { category = 'Ongoing emission — monitor'; basis = 'no hard cap; supply expands via issuance/staking'; }
  else if (remainingDilutionPct >= 50) { category = 'High dilution ahead'; basis = `${remainingDilutionPct}% of ${capBasis} not yet circulating`; }
  else if (remainingDilutionPct >= 20) { category = 'Moderate dilution ahead'; basis = `${remainingDilutionPct}% of ${capBasis} still to enter supply`; }
  else if (remainingDilutionPct > 0) { category = 'Low remaining dilution'; basis = `${remainingDilutionPct}% left to circulate`; }
  else { category = 'Fully circulating (supply side)'; basis = 'circulating ≈ cap; supply-side dilution ~none (unlock cliffs still require verification)'; }

  // The category above is a SUPPLY-MATH read. Timing risk stays unknown without schedule.
  const unlockTimingKnown = !!(nextUnlock);
  if (!unlockTimingKnown && category !== 'Fully circulating (supply side)') caveats.push('Category reflects supply math only; timing/size of specific unlocks not verified');

  return {
    circulating: circ, total, max, capBasis,
    remainingDilutionPct, notYetCirculating, fdvGapPct, uncapped,
    nextUnlock, unlockScheduleAvailable: unlockTimingKnown, unlockStatus,
    insiderAllocation: null, insiderNote: 'team/investor allocation not available from free market API — mark UNKNOWN, do not assume none',
    category, basis, evidence, caveats,
    dilutionValueAtRiskUsd: (notYetCirculating != null && price != null) ? round(notYetCirculating * price, 0) : null,
  };
}

function num(x) { return (x == null || !isFinite(x)) ? null : +x; }
function fmt(n) { if (n == null) return 'n/a'; if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(round(n, 2)); }

module.exports = { assessDilution };
