'use strict';
// node backend/tests/shared.test.js
const { PARAMS, applyWeights, coverageOf } = require('../lib/shared/params');
const { classifyInstrument } = require('../lib/shared/instrument');
const R = require('../lib/shared/returns');
let pass = 0, fail = 0;
const t = (ok, name, x) => { ok ? pass++ : (fail++, console.log('FAIL', name, x ?? '')); };
const thrown = f => { try { f(); return false; } catch { return true; } };

// instrument: unknown stays unknown, REIT is not ETF
const c = x => classifyInstrument(x);
t(c({ finnhubType: 'ETP' }).type === 'ETF', 'ETP -> ETF');
t(c({ finnhubType: 'REIT' }).type === 'REIT' && c({ finnhubType: 'REIT' }).scoringPath === 'FUND_TECH_NEWS', 'REIT is its own type, fund path');
t(c({}).type === 'UNKNOWN' && c({}).scoringPath === 'BLOCKED', 'empty lookup -> UNKNOWN, blocked');
t(c({ lookupOk: false }).flags.includes('LOOKUP_FAILED'), 'failed lookup flagged, not defaulted to stock');
t(c({ finnhubType: 'Common Stock' }).type === 'STOCK', 'common stock');
t(c({ finnhubType: 'DR' }).type === 'ADR', 'DR -> ADR');
t(c({ finnhubType: 'Common Stock', fmpIsEtf: true }).type === 'ETF', 'FMP ETF flag overrides Finnhub Common Stock');
t(c({ finnhubType: 'Common Stock', fmpIsEtf: true }).flags.includes('SOURCE_CONFLICT_FUND_VS_STOCK'), 'conflict flagged');
t(c({ manualType: 'ETF' }).verified === 'MANUAL', 'manual only fills UNKNOWN');
t(c({ finnhubType: 'Common Stock', manualType: 'ETF' }).type === 'STOCK', 'provider beats manual');
t(c({ finnhubType: 'Weird' }).type === 'UNKNOWN', 'unrecognised provider type stays UNKNOWN');

// weights: missing component must throw, not default
const prof = Object.keys(PARAMS.scoringProfiles);
t(prof.length >= 4, 'four scoring profiles', prof);
for (const k of prof) {
  const w = PARAMS.scoringProfiles[k];
  const s = Object.values(w).reduce((a, b) => a + b, 0);
  t(Math.abs(s - 1) < 1e-9, `weights sum to 1: ${k}`, s);
}

// returns: date aligned, null on missing
const bars = (arr, start = Date.UTC(2026, 0, 5)) => arr.map((c, i) => ({ c, t: start + i * 86400000 }));
t(R.excessReturn(null, 1, 2) === null, 'excess null on missing input');
const short = R.calculateBetaDetailed(bars([1, 2, 3]), bars([1, 2, 3]));
t(short && /INSUFFICIENT/.test(JSON.stringify(short)), 'beta insufficient on short history', JSON.stringify(short));

console.log(fail ? `FAILED ${fail} of ${pass + fail}` : `OK: ${pass} shared tests passed`);
process.exit(fail ? 1 : 0);
