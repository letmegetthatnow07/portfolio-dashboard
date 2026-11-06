'use strict';
// Deterministic business, state-transition and earnings scenarios.   node backend/tests/mb-scenarios.js
const { mb, D, now, iso, fys, S, prevOf, LOSS } = require('./helpers');
let pass = 0, fail = 0;
const t = (ok, name, extra) => { ok ? pass++ : (fail++, console.log('FAIL', name, extra ?? '')); };
const has = (x, code) => (x.flags || []).some(f => f.code === code);
const ago = d => iso(now - d * D);
const rq = (daysAgo, surprisePct) => ({ date: ago(daysAgo), quarter: 1, year: 2026, revenueActual: 100 * (1 + surprisePct / 100), revenueEstimate: 100, epsActual: 1, epsEstimate: 1 });
const SUR = (...qs) => ({ quarters: qs });
const base = S();

// ── base sanity ─────────────────────────────────────────────────────────────
t(base.verdict === 'MULTIBAGGER' && base.status === 'PASS' && base.action === 'HOLD_AND_ADD', 'base stock is a clean MULTIBAGGER / HOLD_AND_ADD', `${base.verdict} ${base.status} ${base.action}`);
t(base.scoreParts.execution == null, 'no earnings on file: execution part absent, score unchanged');

// ── earnings: revenue vs estimate ───────────────────────────────────────────
const beat = S({ surprises: SUR(rq(300, 2), rq(200, 3), rq(100, 4), rq(10, 5)) });
t(has(beat, 'REVENUE_BEAT') && has(beat, 'REVENUE_BEAT_STREAK') && beat.scoreParts.execution >= 90, 'four beats: beat flags + high execution score', JSON.stringify(beat.scoreParts));
t(beat.action === 'HOLD_AND_ADD', 'beats keep buying allowed');
const miss = S({ surprises: SUR(rq(10, -4)) });
t(has(miss, 'REVENUE_MISS') && miss.action === 'HOLD_DONT_ADD' && miss.status === 'PASS', 'one revenue miss: warning + buying paused, but NOT a sell and status unchanged', `${miss.action} ${miss.status}`);
t(miss.reasons.some(r => /paused/.test(r)) && miss.earnings.blockAdds, 'pause is explained in the reasons');
const inline = S({ surprises: SUR(rq(10, 0.2)) });
t(inline.earnings.highExpectations && inline.action === 'HOLD_DONT_ADD', 'in-line report on a high-expectation stock pauses buying', inline.action);
const calm = S({ surprises: SUR(rq(10, 0.2)), m: { revenueGrowth3Y: 12, revenueGrowthTTMYoy: 12, epsGrowth3Y: 12 }, est: mb.parseEstimates(fys(0.12, 0.13)), q: { score_fund: 8 } });
t(!calm.earnings.highExpectations || calm.earnings.blockAdds === false, 'in-line report on a normal-expectation stock does not pause buying');
const streak3 = S({ prev: prevOf('PASS'), surprises: SUR(rq(280, -3), rq(190, -2.5), rq(10, -4)) });
t(streak3.thesis.brokenReasons.includes('REVENUE_MISS_STREAK') && streak3.action === 'THESIS_AT_RISK', 'three revenue misses in a row = thesis at risk (needs confirmation before any exit)', `${streak3.action} ${JSON.stringify(streak3.thesis.brokenReasons)}`);
const streak2 = S({ prev: prevOf('PASS'), surprises: SUR(rq(100, -2), rq(10, -3)) });
t(has(streak2, 'REVENUE_MISS_STREAK') && !streak2.thesis.brokenReasons.includes('REVENUE_MISS_STREAK') && streak2.action === 'HOLD_DONT_ADD', 'two misses: warning + pause only, not a thesis break');
const wlMiss = S({ held: false, surprises: SUR(rq(10, -4)) });
t(['CANDIDATE_WAIT', 'CANDIDATE_PROVISIONAL', 'NOT_QUALIFIED'].includes(wlMiss.action), 'watchlist stock after a miss is never CANDIDATE_READY', wlMiss.action);
const guide = S({ earnings: undefined, surprises: SUR(rq(10, 3)) });
const guideCut = mb.screen({ symbol: 'T', metric: require('./helpers').metric(), profile: { name: 'T', finnhubIndustry: 'Software', shareOutstanding: 1000 }, estimates: mb.parseEstimates(fys()), stock: require('./helpers').quality(), sectorHealth: require('./helpers').SEC_OK, held: true, earnings: { date: ago(10), gemini: { guidance_direction: 'lowered' } }, surprises: SUR(rq(10, 3)) });
t(has(guideCut, 'GUIDANCE_CUT') && guideCut.action === 'HOLD_DONT_ADD', 'lowered guidance pauses buying even after a revenue beat');
const old = S({ surprises: SUR(rq(150, -6)) });
t(old.action === 'HOLD_AND_ADD' && !has(old, 'REVENUE_MISS'), 'a miss from 150 days ago no longer affects anything');

// ── state transitions ───────────────────────────────────────────────────────
const failing = { m: LOSS, est: null };                                   // loss-maker => raw FAIL
const r1 = S({ prev: prevOf('PASS'), ...failing });
t(r1.rawStatus === 'FAIL' && r1.status === 'PASS' && r1.pending?.to === 'FAIL' && r1.pending.runs === 1 && r1.action === 'HOLD_DONT_ADD', 'previous PASS + raw FAIL: stays PASS, pending run 1, no buy-ready action', `${r1.status} ${r1.action}`);
const r2 = S({ prev: prevOf('PASS', { pending: { to: 'FAIL', since: new Date(now - 9 * D).toISOString(), runs: 1 } }), ...failing });
t(r2.status === 'FAIL', 'second failing check 9 days later confirms FAIL');
const r2b = S({ prev: prevOf('PASS', { pending: { to: 'FAIL', since: new Date(now - 1 * D).toISOString(), runs: 1 } }), ...failing });
t(r2b.status === 'PASS' && r2b.pending.runs === 2, 'second failing check only 1 day later does NOT confirm (needs 5+ days)');
const r3 = S({ prev: prevOf('FAIL'), held: true });
t(r3.rawStatus === 'PASS' && r3.status === 'FAIL' && r3.pending?.to === 'PASS' && !['HOLD_AND_ADD'].includes(r3.action), 'previous FAIL + raw PASS: pending, no add');
t(S({ prev: prevOf('PASS', { pending: { to: 'FAIL', since: 'garbage', runs: 1 } }), ...failing }).pending.runs === 1, 'malformed pending date restarts confirmation');
t(S({ prev: prevOf('PASS', { pending: { to: 'FAIL', since: new Date(now - 9 * D).toISOString(), runs: 'abc' } }), ...failing }).pending.runs === 1, 'non-numeric pending runs restarts confirmation');
const nodata = { m: {}, est: null, q: null };
const st1 = mb.screen({ symbol: 'T', metric: {}, profile: {}, held: true, prev: prevOf('PASS') });
t(st1.stale && st1.status === 'PASS' && st1.action === 'DATA_STALE', 'confirmed PASS + unavailable data: kept, stale, no new buying');
t(mb.screen({ symbol: 'T', metric: {}, profile: {}, held: false, prev: prevOf('PASS') }).action === 'STALE_NO_BUY', 'same for a non-held stock: STALE_NO_BUY');
const st2 = mb.screen({ symbol: 'T', metric: {}, profile: {}, held: true, prev: prevOf('FAIL') });
t(st2.stale && st2.status === 'FAIL' && st2.action === 'HOLD_WATCH', 'confirmed FAIL + unavailable data: kept as FAIL, hold-watch');
const at = days => mb.screen({ symbol: 'T', metric: {}, profile: {}, held: true, prev: prevOf('PASS', { staleSince: new Date(now - days * D).toISOString() }) });
t(at(29).stale && at(29).status === 'PASS', 'stale for 29 days: still kept');
t(at(31).status === 'NO_DATA' && at(31).lastConfirmed?.status === 'PASS', 'stale for 31 days: expires to NO_DATA, last confirmed state kept for audit');
t(mb.screen({ symbol: 'T', metric: {}, profile: {}, held: true, prev: prevOf('PASS', { action: 'CANDIDATE_READY' }) }).action === 'DATA_STALE', 'watchlist result that became a holding never keeps a candidate action');
t(mb.screen({ symbol: 'T', metric: {}, profile: {}, held: false, prev: prevOf('PASS', { action: 'HOLD_AND_ADD' }) }).action === 'STALE_NO_BUY', 'holding that became unowned never keeps a holding action');

// ── business rules ──────────────────────────────────────────────────────────
const lm = S({ ...failing });
t(lm.verdict === 'UNPROVEN_PROFITABILITY' && lm.status === 'FAIL' && lm.valuation.illustrative, 'loss-maker: illustrative only, UNPROVEN, cannot pass');
const cross = S({ est: mb.parseEstimates([{ date: ago(100), revenueAvg: 100, epsAvg: -1, numAnalystsRevenue: 10, numAnalystsEps: 10 }, { date: iso(now + 260 * D), revenueAvg: 130, epsAvg: 0.5, numAnalystsRevenue: 10, numAnalystsEps: 10 }, { date: iso(now + 625 * D), revenueAvg: 170, epsAvg: 2, numAnalystsRevenue: 10, numAnalystsEps: 10 }]) });
t(cross.growth.forwardSource === 'NOT_MEANINGFUL' && cross.verdict === 'UNPROVEN_PROFITABILITY', 'EPS forecast crosses zero: no EPS-growth based pass');
const nomc = S({ m: { marketCapitalization: null }, profile: { marketCapitalization: undefined } });
t(nomc.verdict !== 'MULTIBAGGER' && has(nomc, 'RUNWAY_UNVERIFIED'), 'unknown market cap can never be MULTIBAGGER');
t(S({ est: mb.parseEstimates(fys(0.25, 0.275, { years: 1 })) }).verdict !== 'MULTIBAGGER', 'one year of consensus cannot be MULTIBAGGER');
t(S({ est: mb.parseEstimates(fys(0.25, 0.275, { nr: null, ne: null })) }).verdict !== 'MULTIBAGGER', 'analyst counts missing cannot be MULTIBAGGER');
const oneLeg = S({ held: false, q: { score_fund: 8 }, sector: { XLK: { price: { priceOk: true }, fund: null } }, source: 'portfolio' });
t(oneLeg.action !== 'CANDIDATE_READY' && has(oneLeg, 'SECTOR_PARTIAL'), 'only one sector leg: not a full-pass candidate');
const covered = S({ m: { 'totalDebt/totalEquityAnnual': 3.0, totalDebtAnnual: 30000, roicTTM: 25, netInterestCoverageTTM: 30, freeCashFlowMarginTTM: 15 } });
t(covered.quality.leverage === 'HIGH_COVERED' && !covered.thesis.brokenReasons.includes('BALANCE_SHEET'), 'D/E 3.0 with strong ROIC, cover and FCF: covered leverage, not distress', covered.quality.leverage);
const weak = S({ m: { 'totalDebt/totalEquityAnnual': 3.0, totalDebtAnnual: 30000, roicTTM: 6, netInterestCoverageTTM: 1, freeCashFlowMarginTTM: -8 } });
t(weak.quality.leverage === 'BROKEN' && weak.thesis.brokenReasons.includes('BALANCE_SHEET'), 'D/E 3.0 with weak cover, ROIC and negative FCF: balance-sheet break', weak.quality.leverage);
const noFcf = S({ m: { 'totalDebt/totalEquityAnnual': 3.0, totalDebtAnnual: 30000, freeCashFlowMarginTTM: null } });
t(noFcf.quality.leverage === 'HIGH_UNVERIFIED', 'high D/E with FCF missing is unverified, not healthy', noFcf.quality.leverage);
const cycSec = { SMH: { price: { priceOk: true }, fund: { label: 'OK', medRevYoY: 0.1 } } };
const cycOff = S({ profile: { finnhubIndustry: 'Semiconductors' }, q: { industry: 'Semiconductors' }, sector: cycSec });
const cycOn = S({ profile: { finnhubIndustry: 'Semiconductors' }, q: { industry: 'Semiconductors', cyclical_peak_flag: true }, sector: cycSec });
t(has(cycOn, 'CYCLICAL_PEAK') && cycOn.growth.g0 < cycOff.growth.g0, 'cyclical-peak margins in a cyclical sector: growth haircut applied');
t(S({ held: false, source: 'watchlist' }).qualityGate.state === 'UNVERIFIED' && S({ held: false, source: 'watchlist' }).verdict !== 'MULTIBAGGER', 'watchlist result is quality-UNVERIFIED and never MULTIBAGGER, even if a quality record is passed in');

// ── EPS estimates: next-twelve-months forward EPS ───────────────────────────
const fyRow = (daysAhead, eps) => ({ date: iso(now + daysAhead * D), revenueAvg: 100, epsAvg: eps, numAnalystsRevenue: 10, numAnalystsEps: 10 });
const e1 = mb.parseEstimates([fyRow(-100, 5), fyRow(90, 6), fyRow(455, 7.5)]);
t(Math.abs(e1.firstEps - (6 * (90 / 365.25) + 7.5 * (1 - 90 / 365.25))) < 0.01 && e1.fy1Eps === 6, 'forward EPS blends this and next fiscal year by time left (FY ends in 90d -> mostly next year)', JSON.stringify([e1.firstEps, e1.fy1Eps]));
const e2 = mb.parseEstimates([fyRow(-100, 5), fyRow(360, 6), fyRow(725, 7.5)]);
t(Math.abs(e2.firstEps - 6) < 0.05, 'fiscal year ending in ~12 months: forward EPS is essentially that year');
const e3 = mb.parseEstimates([fyRow(-100, 5), fyRow(90, 6)]);
t(e3.firstEps === 6, 'only one forward year available: falls back to it');
const e4 = mb.parseEstimates([fyRow(-100, 5), fyRow(90, 6), fyRow(455, -1)]);
t(e4.firstEps === 6, 'a loss in the following year is not blended in');
const e5 = mb.parseEstimates([fyRow(-100, 5), fyRow(90, -2), fyRow(455, 3)]);
t(e5.firstEps === null, 'a loss in the nearest forward year gives no forward P/E');

console.log(fail ? `FAILED ${fail} of ${pass + fail}` : `OK: ${pass} scenario tests passed`);
process.exit(fail ? 1 : 0);
