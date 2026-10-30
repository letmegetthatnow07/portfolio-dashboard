'use strict';
// Robustness: 20,000 random/garbage inputs must never throw, never give an invalid verdict/action,
// and must respect ownership rules. Run: node backend/tests/mb-fuzz.js   (exit code 1 on any violation)
const mb = require('../lib/multibagger');
const D = 86400000, now = Date.now(), iso = t => new Date(t).toISOString().slice(0, 10);
const V = new Set(['MULTIBAGGER','ALPHA_COMPOUNDER','WAIT_FOR_PRICE','UNPROVEN_PROFITABILITY','NOT_MULTIBAGGER','INSUFFICIENT_DATA','NOT_APPLICABLE']);
const HELD_A = ['HOLD_AND_ADD','HOLD_DONT_ADD','HOLD_WATCH','THESIS_AT_RISK','REVIEW_EXIT','DATA_STALE'];
const CAND_A = ['CANDIDATE_READY','CANDIDATE_PROVISIONAL','NOT_QUALIFIED','STALE_NO_BUY'];
const A = new Set([...HELD_A, ...CAND_A]);
const pick = a => a[Math.floor(Math.random() * a.length)];
const vals = [undefined, null, NaN, Infinity, -Infinity, 0, -5, 0.01, 1, 5, 20, 150, 1e6, '12', 'x'];
const keys = ['totalDebt/totalEquityAnnual','longTermDebt/equityAnnual','revenueGrowth3Y','revenueGrowth5Y','revenueGrowthTTMYoy','epsGrowth3Y','peTTM','forwardPE','psTTM','roicTTM','grossMarginTTM','grossMargin5Y','operatingMarginTTM','netProfitMarginTTM','marketCapitalization','netInterestCoverageTTM','totalDebtAnnual','cashAndEquivalentsAnnual','bookValuePerShareAnnual','52WeekPriceReturnDaily'];
let bad = 0;
for (let i = 0; i < 20000; i++) {
  const metric = {}; for (const k of keys) if (Math.random() < 0.7) metric[k] = pick(vals);
  const rows = Math.random() < 0.5 ? null : [0,1,2,3].map(j => ({ date: iso(now + (j * 365 - 105) * D), revenueAvg: pick(vals), epsAvg: pick(vals), numAnalystsRevenue: pick([undefined,0,1,3,10]), numAnalystsEps: pick([undefined,0,1,3,10]) }));
  const held = Math.random() < 0.5;
  const prev = Math.random() < 0.4 ? { status: pick(['PASS','FAIL']), verdict: 'ALPHA_COMPOUNDER', asOf: pick([new Date(now - 20 * D).toISOString(), 'bad', undefined]), history: [], action: pick([...A]) } : null;
  try {
    const est = rows ? mb.parseEstimates(rows) : null;
    const x = mb.screen({ symbol: 'F', metric, profile: pick([{}, { name: 'F', finnhubIndustry: 'Software' }, { type: 'ETP' }]), estimates: est,
      stock: Math.random() < 0.6 ? { symbol: 'F', instrument_type: 'Stock', score_fund: pick([...vals, 8, 6, 4.9]), signal: pick(['HOLD','SELL','TRIM_25','WATCH',undefined]), current_price: pick(vals) } : null,
      sectorHealth: pick([{}, { XLK: { price: { priceOk: true }, fund: { label: 'OK' } } }, null]), held, prev });
    const fail = m => { bad++; console.log('VIOLATION:', m); };
    if (!V.has(x.verdict)) fail('verdict ' + x.verdict);
    if (x.action && !A.has(x.action)) fail('action ' + x.action);
    if (!['PASS','FAIL','NO_DATA','NOT_APPLICABLE'].includes(x.status)) fail('status ' + x.status);
    if (x.score != null && !(x.score >= 0 && x.score <= 100)) fail('score ' + x.score);
    if (!held && HELD_A.includes(x.action)) fail('holding-only action on a watchlist stock: ' + x.action);
    if (held && CAND_A.includes(x.action) && x.action !== 'NOT_QUALIFIED') fail('candidate action on a holding: ' + x.action);
    if (!held && x.verdict === 'MULTIBAGGER') fail('watchlist stock reached MULTIBAGGER (quality gate must block)');
  } catch (e) { bad++; console.log('THREW:', e.message.slice(0, 120)); }
}
console.log(bad ? `FAILED: ${bad} violations` : 'OK: 20,000 random inputs, 0 violations');
process.exit(bad ? 1 : 0);
