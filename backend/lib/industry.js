'use strict';
/**
 * INDUSTRY LAYER for the multibagger screen.
 *
 * THREE LAYERS
 *   A. Universal tests (multibagger.js, unchanged): 5-year after-tax return, entry valuation, growth quality and
 *      estimate depth, moat/runway, dilution, bear case. They apply to every business where the data is meaningful.
 *   B. Industry fundamentals (this file): which businesses the model can judge at all, which economic ranges to score
 *      them on (gross margin, ROIC), and the industry-specific measures that can be computed from the data we
 *      actually have (rule of 40 for software, interest cover for utilities, operating margin for payment networks).
 *      Things the data feed does NOT carry (ARR/retention, backlog, CET1, reserve life, rate base) are flagged as
 *      unverified. They are never invented.
 *   C. Sector regime (multibagger.js + PEER_GROUPS below): price trend and constituent fundamentals as risk context.
 *      Peer groups give a sharper comparison set than a broad ETF; the broad ETF stays as the fallback and the price leg.
 *
 * RANGES ARE ONLY CHANGED WHERE THE ECONOMICS ARE STRUCTURALLY DIFFERENT (low-margin or capital-intensive businesses:
 * defence, healthcare services, utilities, mining, oil and gas). For high-margin industries (software, semiconductors, pharma,
 * biotech, medtech, payment networks) the default ranges already fit, and changing them would be curve-fitting by opinion, so
 * they keep the default and only gain the industry-specific measure and flags. The headline hurdles (22% after tax, 3x, 8%/10%
 * revenue growth) are NOT loosened per industry. Ranges are documented heuristics, not backtested. GENERAL = previous behaviour.
 */

// First match wins, so order is specific -> generic. Tested against Finnhub, FMP and portfolio labels.
const RULES = [
  [/\bbank|thrift|savings institution|mortgage finance/i, 'BANKS'],
  [/insur|reinsur/i, 'INSURANCE'],
  [/asset manag|capital markets|brokerage|investment bank|digital asset|crypto/i, 'ASSET_MGMT'],
  [/payment|financial data|stock exchange|financial exchange|transaction processing/i, 'PAYMENTS_EXCHANGES'],
  [/reit|real estate/i, 'REITS'],
  [/biotech/i, 'BIOTECH'],
  [/medical (device|instrument|equipment|suppl)|diagnostic|life sciences tool|health ?care equipment/i, 'MEDTECH'],
  [/health ?care (plan|provider|facilit|service)|medical care|managed health|hospital/i, 'HEALTH_SERVICES'],
  [/pharma|drug manufactur/i, 'PHARMA'],
  [/aerospace|defen[cs]e/i, 'DEFENSE'],
  [/semiconductor/i, 'SEMIS'],
  [/software|internet content|information technology service|it services|cyber|data processing|cloud/i, 'SOFTWARE'],
  [/utilit|independent power|renewable electricity/i, 'UTILITIES'],
  [/gold|silver|copper|uranium|lithium|rare earth|metals|mining|steel|aluminum|coal|precious/i, 'MINING'],
  [/\boil\b|gas e&p|petroleum|midstream|energy equipment|consumable fuels|drilling/i, 'OIL_GAS'],
];

const DEFAULTS = { label: 'General', scope: 'IN', gmRange: [0.30, 0.70], roicRange: [0.08, 0.30], roicFloor: 0.10, cyclical: false, commodity: false, leverageModel: 'STANDARD' };

const OUT = (label, why) => ({ ...DEFAULTS, label, scope: 'OUT', outReason: why });

const PROFILES = {
  GENERAL: { ...DEFAULTS },
  BANKS: OUT('Banks', 'Banks are outside this model: their economics are ROE, tangible book, credit losses and CET1 capital, not ROIC or free cash flow, and those inputs are not in the data feed. No verdict is given rather than a misleading one.'),
  INSURANCE: OUT('Insurance', 'Insurers are outside this model: they are judged on combined ratio, reserve adequacy, float and ROE, which are not in the data feed. No verdict is given rather than a misleading one.'),
  ASSET_MGMT: OUT('Asset managers, brokers, crypto-financials', 'Asset managers, brokers and crypto-financial firms are outside this model: AUM, net flows, fee margins and trading-revenue quality are not in the data feed, and reported revenue swings with markets. No verdict is given rather than a misleading one.'),
  REITS: OUT('REITs', 'REITs are valued on FFO/AFFO and NAV, which this model does not have. No verdict is given rather than a misleading one.'),
  PAYMENTS_EXCHANGES: { ...DEFAULTS, label: 'Payment networks and exchanges' },
  SOFTWARE: { ...DEFAULTS, label: 'Software and internet' },
  SEMIS: { ...DEFAULTS, label: 'Semiconductors', cyclical: true },
  BIOTECH: { ...DEFAULTS, label: 'Biotechnology' },
  PHARMA: { ...DEFAULTS, label: 'Pharmaceuticals' },
  MEDTECH: { ...DEFAULTS, label: 'Medical technology' },
  HEALTH_SERVICES: { ...DEFAULTS, label: 'Healthcare services', gmRange: [0.10, 0.30] },
  DEFENSE: { ...DEFAULTS, label: 'Aerospace and defence', gmRange: [0.12, 0.30] },
  UTILITIES: { ...DEFAULTS, label: 'Utilities', gmRange: [0.20, 0.50], roicRange: [0.04, 0.10], roicFloor: 0.05, leverageModel: 'REGULATED' },
  MINING: { ...DEFAULTS, label: 'Mining and metals', gmRange: [0.15, 0.45], roicRange: [0.05, 0.18], roicFloor: 0.06, cyclical: true, commodity: true },
  OIL_GAS: { ...DEFAULTS, label: 'Oil and gas', gmRange: [0.15, 0.40], roicRange: [0.05, 0.18], roicFloor: 0.06, cyclical: true, commodity: true },
};

// Layer C: sharper comparison sets than the broad ETF. `etf` stays the price leg and the fallback when a group has no cached reading.
const PEER_GROUPS = {
  SOFTWARE: { etf: 'XLK', peers: ['MSFT', 'ORCL', 'CRM', 'ADBE', 'NOW'] },
  PHARMA: { etf: 'XLV', peers: ['LLY', 'JNJ', 'MRK', 'ABBV', 'PFE'] },
  MEDTECH: { etf: 'XLV', peers: ['MDT', 'SYK', 'BSX', 'ISRG', 'ABT'] },
  HEALTH_SERVICES: { etf: 'XLV', peers: ['UNH', 'ELV', 'CI', 'HCA', 'CVS'] },
  PAYMENTS_EXCHANGES: { etf: 'XLF', peers: ['V', 'MA', 'PYPL', 'ICE', 'CME'] },
  MINING: { etf: 'XLB', peers: ['FCX', 'SCCO', 'NEM', 'RIO', 'BHP'] },
};

function classifyIndustry(...labels) {
  const ls = labels.filter(l => typeof l === 'string' && l.trim());
  for (const [rx, key] of RULES) if (ls.some(l => rx.test(l))) return key;
  return 'GENERAL';
}

const profileOf = key => PROFILES[key] || PROFILES.GENERAL;
/** A peer-group key if the industry has one, else null (caller falls back to the broad ETF). */
const groupKey = industryKey => (PEER_GROUPS[industryKey] ? industryKey : null);
const priceEtfFor = key => (PEER_GROUPS[key] ? PEER_GROUPS[key].etf : key);
const constituentsFor = (key, etfConstituents = {}) => (PEER_GROUPS[key] ? PEER_GROUPS[key].peers : etfConstituents[key] || []);
const isCyclicalKey = (key, cyclicalEtfs = new Set()) => cyclicalEtfs.has(priceEtfFor(key)) || (PROFILES[key] ? PROFILES[key].cyclical : false);

const clamp01 = x => Math.max(0, Math.min(1, x));
const lin = (x, lo, hi) => (x == null || !isFinite(x) ? null : clamp01((x - lo) / (hi - lo)) * 100);

/**
 * Layer B measures computable from the feed. d = { revG, fcfM, opm, icovEff } (fractions; icovEff may be Infinity).
 * Returns { part: 0-100 | null, flags: [{code, level, text}] }. A null part is left out of the score (weights renormalise).
 */
function industryChecks(key, d = {}) {
  const flags = [];
  let part = null;
  const { revG, fcfM, opm, icovEff } = d;
  switch (key) {
    case 'SOFTWARE':
      if (revG != null && fcfM != null) {
        const r40 = (revG + fcfM) * 100;
        part = lin(r40, 10, 50);
        if (r40 >= 40) flags.push({ code: 'RULE_OF_40', level: 'green', text: `Rule of 40 is ${r40.toFixed(0)} (revenue growth plus free-cash-flow margin): growth and cash generation both check out.` });
        else if (r40 < 20) flags.push({ code: 'RULE_OF_40', level: 'amber', text: `Rule of 40 is only ${r40.toFixed(0)} (revenue growth plus free-cash-flow margin). Recurring-revenue retention (ARR, net revenue retention) is not in the data feed to confirm quality.` });
      }
      break;
    case 'UTILITIES':
      if (icovEff != null) part = lin(icovEff === Infinity ? 6 : icovEff, 1.5, 4);
      flags.push({ code: 'RATE_BASE_UNVERIFIED', level: 'amber', text: 'Utility economics (rate-base growth, allowed return, funding plan) are not in the data feed. Judged on interest cover and returns only.' });
      break;
    case 'PAYMENTS_EXCHANGES':
      if (opm != null) part = lin(opm, 0.25, 0.50);
      break;
    case 'HEALTH_SERVICES':
      if (opm != null) part = lin(opm, 0.04, 0.12);
      break;
    case 'DEFENSE':
      flags.push({ code: 'BACKLOG_UNVERIFIED', level: 'amber', text: 'Backlog, funded orders and book-to-bill are not in the data feed. Growth is judged on analyst estimates only, which can understate contracted visibility.' });
      break;
    case 'MINING':
    case 'OIL_GAS':
      flags.push({ code: 'COMMODITY_PRICE_DRIVEN', level: 'amber', text: 'Revenue growth in this industry mostly follows commodity prices, not durable demand. Growth is haircut 40%; cost curve and reserve life are not in the data feed.' });
      break;
    case 'BIOTECH':
      flags.push({ code: 'PIPELINE_UNVERIFIED', level: 'amber', text: 'Pipeline stage, trial odds and cash runway are not in the data feed. Only commercial revenue and earnings can be judged.' });
      break;
    default:
  }
  return { part, flags };
}

module.exports = { RULES, PROFILES, PEER_GROUPS, classifyIndustry, profileOf, groupKey, priceEtfFor, constituentsFor, isCyclicalKey, industryChecks };
