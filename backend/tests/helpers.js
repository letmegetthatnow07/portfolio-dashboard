'use strict';
// Shared fixtures for the multibagger tests. A "base" stock that should be a clean MULTIBAGGER, with overrides per test.
const mb = require('../lib/multibagger');
const D = 86400000, now = Date.now();
const iso = t => new Date(t).toISOString().slice(0, 10);
const row = (d, rev, eps, nr = 10, ne = 10) => ({ date: iso(d), revenueAvg: rev, epsAvg: eps, numAnalystsRevenue: nr, numAnalystsEps: ne });
const fys = (r = 0.25, e = r * 1.1, opts = {}) => {
  const n = opts.years ?? 3, nr = 'nr' in opts ? opts.nr : 10, ne = 'ne' in opts ? opts.ne : 10, a = [row(now - 100 * D, 100, 5, nr, ne)];
  for (let i = 1; i <= n; i++) a.push(row(now + (i * 365 - 105) * D, 100 * Math.pow(1 + r, i), 5 * Math.pow(1 + e, i), nr, ne));
  return a;
};
const metric = (o = {}) => ({
  'totalDebt/totalEquityAnnual': 0.3, revenueGrowth3Y: 25, revenueGrowthTTMYoy: 25, epsGrowth3Y: 28, peTTM: 20, psTTM: 4,
  roicTTM: 25, grossMarginTTM: 65, grossMargin5Y: 65, operatingMarginTTM: 25, operatingMargin5Y: 25, netProfitMarginTTM: 20,
  freeCashFlowMarginTTM: 15, marketCapitalization: 100000, netInterestCoverageTTM: 30,
  totalDebtAnnual: 500, cashAndEquivalentsAnnual: 2000, bookValuePerShareAnnual: 10, ...o,
});
const SEC_OK = { XLK: { price: { priceOk: true }, fund: { label: 'OK', medRevYoY: 0.1 } } };
const quality = (o = {}) => ({ symbol: 'T', instrument_type: 'Stock', current_price: 100, industry: 'Software', score_fund: 8, signal: 'HOLD', score_insider: 5, score_rating: 7, ...o });
/** Screen the base stock with overrides. `m` overrides metric fields, `q` overrides the quality-engine record (null = none). */
function S({ m = {}, q = {}, est, prev = null, held = true, source, sector = SEC_OK, profile = {}, surprises = null, earnings = null } = {}) {
  return mb.screen({
    symbol: 'T', metric: metric(m), profile: { name: 'T', finnhubIndustry: 'Software', shareOutstanding: 1000, ...profile },
    estimates: est === undefined ? mb.parseEstimates(fys()) : est, stock: q === null ? null : quality(q),
    sectorHealth: sector, held, prev, surprises, earnings, source: source || (held ? 'portfolio' : 'watchlist'),
  });
}
const prevOf = (status, extra = {}) => ({ symbol: 'T', status, verdict: status === 'PASS' ? 'ALPHA_COMPOUNDER' : 'NOT_MULTIBAGGER', asOf: new Date(now - 20 * D).toISOString(), history: [], action: status === 'PASS' ? 'HOLD_AND_ADD' : 'HOLD_WATCH', ...extra });
const LOSS = { peTTM: null, forwardPE: null, psTTM: 4, netProfitMarginTTM: -5 };   // loss-maker: valued on sales only
module.exports = { mb, D, now, iso, row, fys, metric, quality, SEC_OK, S, prevOf, LOSS };
