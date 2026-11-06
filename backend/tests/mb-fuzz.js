'use strict';
// Robustness + policy invariants on random/garbage input. Seeded: a failure prints the seed and the exact case.
//   node backend/tests/mb-fuzz.js            (default seed 12345)
//   MB_SEED=987 node backend/tests/mb-fuzz.js
const { mb, D, now, iso } = require('./helpers');
const SEED = Number(process.env.MB_SEED) || 12345, N = Number(process.env.MB_N) || 20000;
let st = SEED >>> 0;
const rnd = () => { st = (st + 0x6D2B79F5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];

const VERDICTS = new Set(['MULTIBAGGER','ALPHA_COMPOUNDER','WAIT_FOR_PRICE','UNPROVEN_PROFITABILITY','NOT_MULTIBAGGER','INSUFFICIENT_DATA','NOT_APPLICABLE']);
const HELD_A = ['HOLD_AND_ADD','HOLD_DONT_ADD','HOLD_WATCH','THESIS_AT_RISK','REVIEW_EXIT','DATA_STALE'];
const CAND_A = ['CANDIDATE_READY','CANDIDATE_WAIT','CANDIDATE_PROVISIONAL','NOT_QUALIFIED','STALE_NO_BUY'];
const ALL_A = new Set([...HELD_A, ...CAND_A]);
const BUY_READY = ['HOLD_AND_ADD','CANDIDATE_READY','CANDIDATE_WAIT'];
const CAUTION = ['WATCH','TRIM_25','REDUCE','SELL','IDIOSYNCRATIC_DECAY'];
const vals = [undefined, null, NaN, Infinity, -Infinity, 0, -5, 0.01, 1, 5, 20, 150, 1e6, '12', 'x'];
const keys = ['totalDebt/totalEquityAnnual','longTermDebt/equityAnnual','revenueGrowth3Y','revenueGrowth5Y','revenueGrowthTTMYoy','epsGrowth3Y','peTTM','forwardPE','psTTM','roicTTM','grossMarginTTM','grossMargin5Y','operatingMarginTTM','netProfitMarginTTM','freeCashFlowMarginTTM','marketCapitalization','netInterestCoverageTTM','totalDebtAnnual','cashAndEquivalentsAnnual','bookValuePerShareAnnual','52WeekPriceReturnDaily'];

let bad = 0;
for (let i = 0; i < N; i++) {
  const metric = {}; for (const k of keys) if (rnd() < 0.7) metric[k] = pick(vals);
  const rows = rnd() < 0.5 ? null : [0,1,2,3].map(j => ({ date: iso(now + (j * 365 - 105) * D), revenueAvg: pick(vals), epsAvg: pick(vals), numAnalystsRevenue: pick([undefined,0,1,3,10]), numAnalystsEps: pick([undefined,0,1,3,10]) }));
  const held = rnd() < 0.5, source = held ? 'portfolio' : pick(['watchlist','portfolio']);
  const pendingJunk = pick([undefined, { to: pick(['PASS','FAIL']), since: pick(['garbage', undefined, new Date(now - 9 * D).toISOString()]), runs: pick([1, '1', NaN, undefined, 0, 2.7]) }]);
  const prev = rnd() < 0.5 ? { status: pick(['PASS','FAIL']), verdict: 'ALPHA_COMPOUNDER', asOf: pick([new Date(now - 20 * D).toISOString(), new Date(now - 45 * D).toISOString(), 'bad', undefined]), staleSince: pick([undefined, new Date(now - 40 * D).toISOString()]), history: [], action: pick([...ALL_A]), pending: pendingJunk } : null;
  const profile = pick([{}, { name: 'F', finnhubIndustry: 'Software' }, { type: 'ETP' }]);
  const stock = rnd() < 0.6 ? { symbol: 'F', instrument_type: 'Stock', score_fund: pick([...vals, 8, 6, 4.9]), signal: pick(['HOLD','SELL','TRIM_25','REDUCE','WATCH','IDIOSYNCRATIC_DECAY',undefined]), regime: pick([undefined,'MARKET_NOISE','IDIOSYNCRATIC_DECAY']), current_price: pick(vals), sma200: pick(vals) } : null;
  const sectorHealth = pick([{}, { XLK: { price: { priceOk: true }, fund: { label: 'OK' } } }, null]);
  const input = { symbol: 'F', metric, profile, estimates: rows, stock, sectorHealth, held, source, prev };
  const fail = m => { bad++; if (bad <= 8) console.log(`VIOLATION seed=${SEED} case=${i}: ${m}\n  input=${JSON.stringify(input).slice(0, 700)}`); };
  let x;
  try {
    x = mb.screen({ ...input, estimates: rows ? mb.parseEstimates(rows) : null, isETF: mb.isEtfProfile(profile) });
  } catch (e) { fail('THREW ' + e.message.slice(0, 100)); continue; }
  if (!VERDICTS.has(x.verdict)) fail('verdict ' + x.verdict);
  if (!['PASS','FAIL','NO_DATA','NOT_APPLICABLE'].includes(x.status)) fail('status ' + x.status);
  if (x.score != null && (typeof x.score !== 'number' || !Number.isFinite(x.score) || x.score < 0 || x.score > 100)) fail('score ' + x.score);
  if (x.action != null && !ALL_A.has(x.action)) fail('invalid action ' + x.action);
  if (['PASS','FAIL'].includes(x.status) && !ALL_A.has(x.action)) fail(`missing action for ${x.status}`);
  if (x.status === 'NOT_APPLICABLE' && x.action) fail('ETF got an action');
  if (!held && HELD_A.includes(x.action)) fail('holding-only action on non-held: ' + x.action);
  if (held && CAND_A.includes(x.action)) fail('candidate-only action on a holding: ' + x.action);
  if (x.rawStatus === 'FAIL' && BUY_READY.includes(x.action)) fail('buy-ready action despite CURRENT raw FAIL: ' + x.action);
  if (BUY_READY.includes(x.action) && x.stale) fail('buy-ready action on stale data');
  if (stock && (CAUTION.includes(stock.signal) || stock.regime === 'IDIOSYNCRATIC_DECAY') && source !== 'watchlist' && ['HOLD_AND_ADD','CANDIDATE_READY'].includes(x.action)) fail(`add allowed under daily-engine caution (${stock.signal}/${stock.regime})`);
  if (x.action === 'CANDIDATE_READY' && x.pricing !== 'OK') fail('CANDIDATE_READY with pricing ' + x.pricing);
  if (source === 'watchlist' && x.verdict === 'MULTIBAGGER') fail('watchlist stock reached MULTIBAGGER');
  if (source === 'watchlist' && x.qualityGate && x.qualityGate.state !== 'UNVERIFIED') fail('watchlist quality gate not UNVERIFIED: ' + x.qualityGate.state);
  if (x.pending && (!Number.isFinite(Date.parse(x.pending.since)) || !Number.isInteger(x.pending.runs) || x.pending.runs < 1)) fail('malformed pending ' + JSON.stringify(x.pending));
  if (x.stale && !['DATA_STALE','STALE_NO_BUY','REVIEW_EXIT','THESIS_AT_RISK','HOLD_WATCH'].includes(x.action)) fail('stale result with action ' + x.action);
}
console.log(bad ? `FAILED: ${bad} violations (seed ${SEED})` : `OK: ${N} random inputs, 0 violations (seed ${SEED})`);
process.exit(bad ? 1 : 0);
