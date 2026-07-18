'use strict';
// Life HQ — Fundamental Research layer (pure assembly + verdict; unit-tested).
//
// Principles:
//  * Every fact carries {value, source, retrievedAt, confidence}. Missing stays missing (null).
//  * A CoinGecko description ALONE can NEVER produce a positive project-quality verdict.
//  * We separate three things: (a) descriptive facts we can source for free,
//    (b) durability inputs we do NOT have for free (usage, revenue, unlocks, concentration…),
//    (c) evidence that CONTRADICTS a bullish thesis. Quality verdict stays "Not assessed"
//    until real durability inputs are connected — but the dossier is now populated & sourced.

const round = (n, p = 2) => (n == null || !isFinite(n)) ? null : +n.toFixed(p);
const fact = (value, source, retrievedAt, confidence = 'medium', note = null) =>
  ({ value: value == null ? null : value, source: value == null ? null : source, retrievedAt: value == null ? null : retrievedAt, confidence: value == null ? 'none' : confidence, ...(note ? { note } : {}) });

// Durability inputs that a genuine quality verdict REQUIRES but free market data lacks.
const REQUIRED_DURABILITY = ['network usage & trend', 'fees/protocol revenue', 'active addresses',
  'TVL (if applicable)', 'token utility depth', 'holder/validator concentration', 'governance concentration',
  'audits', 'security-incident history', 'downtime history', 'regulatory status', 'verified upcoming catalysts',
  'competitive moat', 'insider/team allocation & vesting'];

function ageDays(genesisDate, now) {
  if (!genesisDate) return null;
  const g = new Date(genesisDate + 'T00:00:00Z').getTime(), n = new Date(now).getTime();
  return isFinite(g) ? Math.round((n - g) / 8.64e7) : null;
}

// rawCoin: CoinGecko /coins/{id} object (fetched on the runner). c: market-row (supply/price/mcap).
// retrievedAt: ISO ts of the fetch. Returns a fully-structured, source-stamped dossier.
function buildDossier(rawCoin, c, retrievedAt) {
  const src = 'CoinGecko /coins/{id} (aggregated from project sources)';
  const desc = rawCoin && rawCoin.description && rawCoin.description.en ? String(rawCoin.description.en).replace(/<[^>]+>/g, '').trim() : null;
  const cats = rawCoin && Array.isArray(rawCoin.categories) ? rawCoin.categories.filter(Boolean) : [];
  const genesis = rawCoin && rawCoin.genesis_date ? rawCoin.genesis_date : null;
  const dev = (rawCoin && rawCoin.developer_data) || {};
  const links = (rawCoin && rawCoin.links) || {};
  const githubRepos = (links.repos_url && links.repos_url.github || []).filter(Boolean);
  const notices = [rawCoin && rawCoin.public_notice, ...((rawCoin && rawCoin.additional_notices) || [])].filter(Boolean);

  const commits4w = numOr(dev.commit_count_4_weeks);
  const devLabel = commits4w == null ? 'unknown' : commits4w >= 80 ? 'active' : commits4w >= 15 ? 'moderate' : commits4w > 0 ? 'quiet' : 'dormant';

  const dossier = {
    symbol: c.sym, name: c.name, retrievedAt,
    identity: {
      purpose: fact(desc ? firstSentences(desc, 2) : null, src, retrievedAt, 'low', 'descriptive text aggregated by CoinGecko — NOT independently verified; cannot by itself justify a positive verdict'),
      category: fact(cats.length ? cats.slice(0, 6) : null, src, retrievedAt, 'medium'),
      launchDate: fact(genesis, src, retrievedAt, genesis ? 'medium' : 'none'),
      operatingHistoryDays: fact(ageDays(genesis, retrievedAt), 'derived from genesis_date', retrievedAt, genesis ? 'medium' : 'none'),
      network: fact(rawCoin && rawCoin.asset_platform_id ? rawCoin.asset_platform_id : (cats.find(x => /chain|layer|ecosystem/i.test(x)) || null), src, retrievedAt, 'low'),
    },
    supply: {
      circulating: fact(numOr(c.circ), 'CoinGecko /coins/markets', retrievedAt, 'high'),
      total: fact(numOr(c.total), 'CoinGecko /coins/markets', retrievedAt, 'high'),
      max: fact(numOr(c.max), 'CoinGecko /coins/markets', retrievedAt, c.max ? 'high' : 'none'),
      fdvUsd: fact(numOr(c.fdv), 'CoinGecko /coins/markets', retrievedAt, 'medium'),
      inflationRemainingPct: fact(c.supplyInflationPct != null ? c.supplyInflationPct : null, 'derived (max−circ)/max', retrievedAt, 'medium'),
    },
    development: {
      github: fact(githubRepos.length ? githubRepos.slice(0, 3) : null, 'CoinGecko links.repos_url', retrievedAt, 'medium'),
      commits4w: fact(commits4w, 'CoinGecko developer_data (GitHub)', retrievedAt, commits4w == null ? 'none' : 'medium'),
      stars: fact(numOr(dev.stars), 'CoinGecko developer_data (GitHub)', retrievedAt, 'low'),
      activityLabel: fact(commits4w == null ? null : devLabel, 'derived from commit_count_4_weeks', retrievedAt, commits4w == null ? 'none' : 'low', 'proxy only — an active repo is NOT proof of adoption or revenue'),
    },
    // durability inputs we DO NOT have for free — explicitly missing, never fabricated
    durabilityMissing: REQUIRED_DURABILITY,
    security: { notices: fact(notices.length ? notices.map(n => String(n).replace(/<[^>]+>/g, '').slice(0, 240)) : null, src, retrievedAt, notices.length ? 'medium' : 'none'), incidentHistory: fact(null, null, null, 'none', 'no free structured incident feed connected — UNKNOWN, not clean') },
    governance: { concentration: fact(null, null, null, 'none', 'holder/validator/governance concentration not available free — UNKNOWN') },
    competitors: fact(cats.length ? peersFromCategories(cats) : null, 'derived from CoinGecko categories', retrievedAt, 'low', 'category peers only — not a curated competitive analysis'),
    catalysts: fact(null, null, null, 'none', 'no verified upcoming-catalyst feed connected — UNKNOWN'),
  };
  dossier.contradicting = contradictingEvidence(c);
  dossier.projectQuality = projectQualityVerdict(dossier, c);
  dossier.sources = [src, 'CoinGecko /coins/markets', 'GitHub (via CoinGecko developer_data)'];
  return dossier;
}

// Evidence that argues AGAINST a bullish thesis (always shown when present).
function contradictingEvidence(c) {
  const out = [];
  if (c.athChangePct != null && c.athChangePct < -60) out.push(`${c.athChangePct}% below all-time high — prolonged underperformance`);
  if (c.chg1y != null && c.chg1y < 0) out.push(`Negative 1-year return (${c.chg1y}%)`);
  if (c.supplyInflationPct != null && c.supplyInflationPct > 25) out.push(`~${c.supplyInflationPct}% of max supply not yet circulating — structural sell pressure`);
  if (c.fdv != null && c.mcap != null && c.mcap > 0 && (c.fdv - c.mcap) / c.mcap > 0.5) out.push(`FDV far above market cap — dilution overhang`);
  return out;
}

// The verdict: description/dev-activity can never make this positive. Stays "Not assessed".
function projectQualityVerdict(dossier, c) {
  const have = [];
  if (dossier.identity.category.value) have.push('category');
  if (dossier.identity.launchDate.value) have.push('operating history');
  if (dossier.development.commits4w.value != null) have.push('development activity');
  if (dossier.supply.circulating.value != null) have.push('supply structure');
  // durability inputs are all missing for free => cannot be positive
  return {
    label: 'Not assessed',
    basis: `descriptive + supply + dev-activity facts collected (${have.join(', ') || 'minimal'}), but durability inputs (usage, revenue, unlocks, concentration, audits, competition) are NOT connected — a positive quality verdict is not permitted from these inputs`,
    collectedInputs: have, missingDurabilityInputs: dossier.durabilityMissing,
    contradicting: dossier.contradicting,
  };
}

function firstSentences(s, n) { const m = s.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g); return m ? m.slice(0, n).join(' ').trim() : s.slice(0, 240); }
function peersFromCategories(cats) { const c = cats.find(x => !/^(Cryptocurrency|Coins|Tokens)$/i.test(x)); return c ? `peers in category: ${c}` : null; }
function numOr(x) { return (x == null || !isFinite(+x)) ? null : +x; }

module.exports = { REQUIRED_DURABILITY, buildDossier, contradictingEvidence, projectQualityVerdict, ageDays };
