'use strict';
// Calibration view: how the verdict moves with growth and price. Not pass/fail: read the table.
// Run: node backend/tests/mb-sweep.js
const mb = require('../lib/multibagger');
const D = 86400000, now = Date.now(), iso = t => new Date(t).toISOString().slice(0, 10);
const row = (d, rev, eps) => ({ date: iso(d), revenueAvg: rev, epsAvg: eps, numAnalystsRevenue: 10, numAnalystsEps: 10 });
function run(name, { r, e, pe, roic = 22, gm = 60, nm = 18, de = 0.3, mcap = 100000, qual = 8, held = true, sector = 'XLK', ind = 'Software' }) {
  const fys = [row(now - 100 * D, 100, 5)];
  for (let i = 1; i <= 3; i++) fys.push(row(now + (i * 365 - 105) * D, 100 * Math.pow(1 + r, i), 5 * Math.pow(1 + e, i)));
  const metric = { 'totalDebt/totalEquityAnnual': de, revenueGrowth3Y: r * 100, revenueGrowthTTMYoy: r * 100, epsGrowth3Y: e * 100, peTTM: pe, psTTM: pe * nm / 100, roicTTM: roic, grossMarginTTM: gm, grossMargin5Y: gm, operatingMarginTTM: nm * 1.2, operatingMargin5Y: nm * 1.2, netProfitMarginTTM: nm, freeCashFlowMarginTTM: nm, marketCapitalization: mcap, netInterestCoverageTTM: 30, totalDebtAnnual: 500, cashAndEquivalentsAnnual: 2000, bookValuePerShareAnnual: 10 };
  const x = mb.screen({ symbol: 'T', metric, profile: { name, finnhubIndustry: ind, shareOutstanding: 1000 }, estimates: mb.parseEstimates(fys),
    stock: { symbol: 'T', instrument_type: 'Stock', current_price: pe * 5, industry: ind, score_fund: qual, signal: 'HOLD', score_insider: 5, score_rating: 7 },
    sectorHealth: { [sector]: { price: { priceOk: true }, fund: { label: 'OK', medRevYoY: 0.1 } } }, held });
  console.log(name.padEnd(34), String(x.verdict).padEnd(22), String(x.score).padStart(3), 'growth', ((x.growth?.g0 || 0) * 100).toFixed(1).padStart(5) + '%', '5y x', (x.valuation?.mult5y || 0).toFixed(2), 'after-tax', ((x.valuation?.afterTaxCagr || 0) * 100).toFixed(1).padStart(5) + '%/yr', 'bear', ((x.valuation?.bearCagr || 0) * 100).toFixed(1).padStart(5) + '%');
}
console.log('--- same 25% grower, price rising (P/E)');
for (const pe of [15, 20, 25, 30, 40, 60, 90]) run(`25% growth, P/E ${pe}`, { r: .25, e: .28, pe });
console.log('--- growth ladder at P/E 25');
for (const g of [.05, .08, .10, .12, .15, .20, .25, .30, .40]) run(`growth ${g * 100}%, P/E 25`, { r: g, e: g * 1.1, pe: 25 });
console.log('--- archetypes');
run('Mature staple 6%, P/E 22', { r: .06, e: .07, pe: 22, gm: 45, roic: 15, nm: 12, sector: 'XLP', ind: 'Packaged Foods' });
run('Quality 18%, P/E 28', { r: .18, e: .20, pe: 28 });
run('Hyper 35%, P/E 60', { r: .35, e: .40, pe: 60 });
run('Mega-cap 15%, P/E 28, $3T', { r: .15, e: .17, pe: 28, mcap: 3000000 });
run('Low-ROIC 20%, P/E 20', { r: .20, e: .22, pe: 20, roic: 6, gm: 30, nm: 5 });
run('Quality score 4 (fails daily gate)', { r: .25, e: .28, pe: 20, qual: 4 });
run('Leveraged D/E 2.2, 20%, P/E 20', { r: .20, e: .22, pe: 20, de: 2.2 });
