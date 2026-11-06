'use strict';
// node backend/tests/earnings-context.test.js
const { surprise, grade, isHighExpectation, assessEarningsContext: A, PARAMS: P } = require('../lib/earnings-context');
const DAY = 86400000, now = Date.parse('2026-11-01T12:00:00Z');
const ago = d => new Date(now - d * DAY).toISOString().slice(0, 10);
const Q = (daysAgo, rev, revEst = 100, eps = 1, epsEst = 1) => ({ date: ago(daysAgo), quarter: 1, year: 2026, revenueActual: rev, revenueEstimate: revEst, epsActual: eps, epsEstimate: epsEst });
let pass = 0, fail = 0;
const t = (ok, name) => { ok ? pass++ : (fail++, console.log('FAIL', name)); };
const ctx = (quarters, o = {}) => A({ surprises: { quarters }, now, ...o });

// surprise maths + bad data
t(Math.abs(surprise(103, 100) - 0.03) < 1e-9, 'surprise +3%');
t(surprise(100, 0) === null && surprise(null, 100) === null && surprise('x', 100) === null, 'missing/zero estimate -> null');
t(surprise(300, 100) === null, '+200% is treated as bad data (unit/currency mismatch), not a result');
t(surprise(1e9, 1e9) === 0, 'exact match -> 0');
// grading bands
t(grade(0.04) === 'STRONG_BEAT' && grade(0.02) === 'BEAT' && grade(0) === 'IN_LINE' && grade(-0.02) === 'MISS' && grade(-0.05) === 'BIG_MISS' && grade(null) === null, 'grading bands');
// direction: beat > in-line > miss
const pts = r => ctx([Q(10, r)]).compositePoints;
t(pts(104) > pts(102) && pts(102) > pts(100) && pts(100) > pts(98) && pts(98) > pts(95), 'points rise monotonically with the revenue surprise');
t(Math.abs(pts(104)) <= 0.6 + 1e-9 && Math.abs(pts(90)) <= 0.6 + 1e-9, 'composite adjustment never exceeds +/-0.6');
// fade with time
t(ctx([Q(5, 104)]).compositePoints > ctx([Q(50, 104)]).compositePoints && ctx([Q(50, 104)]).compositePoints > 0, 'adjustment fades with age but stays positive');
t(ctx([Q(120, 104)]).compositePoints === 0 && !ctx([Q(120, 95)]).blockAdds, 'a report older than 100 days no longer counts');
// "meeting expectations can go down": in-line is neutral normally, negative + blocks adds for priced-for-perfection names
const inLine = ctx([Q(10, 100)]), inLineHi = ctx([Q(10, 100)], { highExpectations: true });
t(inLine.compositePoints === 0 && !inLine.blockAdds, 'in-line on a normal stock: neutral, adds allowed');
t(inLineHi.compositePoints < 0 && inLineHi.blockAdds && /only met estimates/.test(inLineHi.blockReason), 'in-line on a high-expectation stock: negative and blocks adds');
t(ctx([Q(10, 102)], { highExpectations: true }).compositePoints < ctx([Q(10, 102)]).compositePoints, 'a small beat is worth less on a high-expectation stock');
t(ctx([Q(10, 104)], { highExpectations: true }).compositePoints > 0 && !ctx([Q(10, 104)], { highExpectations: true }).blockAdds, 'a strong beat still clears the higher bar');
// blocking window
t(ctx([Q(10, 97)]).blockAdds && ctx([Q(10, 97)]).blockDays === 35, 'miss 10d ago blocks adds for the remaining 35 days');
t(!ctx([Q(60, 97)]).blockAdds, 'miss 60d ago no longer blocks adds');
// streaks
const streak2 = ctx([Q(100, 98), Q(10, 97)]);
t(streak2.missStreak === 2 && streak2.flags.some(f => f.code === 'REVENUE_MISS_STREAK' && f.level === 'amber'), '2 misses in a row -> streak flag (amber)');
t(ctx([Q(200, 97), Q(100, 98), Q(10, 97)]).flags.some(f => f.code === 'REVENUE_MISS_STREAK' && f.level === 'red'), '3 misses -> red');
t(ctx([Q(300, 98), Q(200, 104), Q(100, 103), Q(10, 102)]).missStreak === 0 && ctx([Q(300, 98), Q(200, 104), Q(100, 103), Q(10, 102)]).beatStreak === 3, 'streak counts only consecutive newest quarters');
t(streak2.blockDays > 35, '2-miss streak blocks adds for longer (90d window)');
// execution score
t(ctx([Q(10, 105)]).executionScore === 100 && ctx([Q(10, 95)]).executionScore === 0 && ctx([Q(10, 100)]).executionScore === 50, 'execution score: +5% =100, -5% =0, in line =50');
t(ctx([Q(300, 95), Q(200, 95), Q(100, 105), Q(10, 105)]).executionScore > 50, 'recent beats outweigh older misses');
// guidance
const withGuide = d => A({ surprises: { quarters: [Q(10, 102)] }, event: { gemini: { guidance_direction: d } }, now });
t(withGuide('lowered').compositePoints < ctx([Q(10, 102)]).compositePoints && withGuide('lowered').blockAdds, 'lowered guidance lowers points and blocks adds even after a beat');
t(withGuide('raised').compositePoints > ctx([Q(10, 102)]).compositePoints, 'raised guidance adds points');
// EPS secondary
t(ctx([Q(10, 102, 100, 1.1, 1)]).compositePoints > ctx([Q(10, 102, 100, 1, 1)]).compositePoints && ctx([Q(10, 102, 100, 0.9, 1)]).compositePoints < ctx([Q(10, 102, 100, 1, 1)]).compositePoints, 'EPS beat/miss nudges, secondary to revenue');
// EPS beat WITH a revenue miss is low quality: no EPS credit, flagged
const lq = ctx([Q(10, 96, 100, 1.1, 1)]), noEps = ctx([Q(10, 96, 100, 1, 1)]);
t(lq.compositePoints === noEps.compositePoints && lq.flags.some(f => f.code === 'LOW_QUALITY_BEAT'), 'EPS beat + revenue miss: no EPS credit, LOW_QUALITY_BEAT flagged');
t(ctx([Q(10, 102, 100, 1.1, 1)]).compositePoints > ctx([Q(10, 102, 100, 1, 1)]).compositePoints, 'EPS beat WITH a revenue beat still earns the EPS credit');
// LLM-only fallback: half weight, cannot block on its own
const llm = (rb, eb) => A({ event: { date: ago(10), gemini: { revenue_beat: rb, eps_beat: eb } }, now });
t(llm(true, true).source === 'LLM' && llm(true, true).compositePoints > 0 && llm(true, true).compositePoints < ctx([Q(10, 102)]).compositePoints + 0.0001, 'LLM-only beat: positive but half weight');
t(!llm(false, true).blockAdds && llm(false, false).blockAdds, 'LLM-only: a revenue miss alone does not block; revenue AND EPS miss does');
// empty / junk input never throws
let threw = false;
try { A(); A({ surprises: { quarters: [null, {}, { date: 'x' }, { date: ago(5), revenueActual: 'a' }] }, event: { gemini: null }, now }); A({ surprises: 5, event: 'x' }); } catch (e) { threw = true; }
t(!threw, 'junk input does not throw');
t(A().compositePoints === 0 && A().blockAdds === false && A().executionScore === null, 'no data -> neutral and inert');
// high-expectation detector
t(isHighExpectation({ forwardPE: 40 }) && isHighExpectation({ hypergrowth: true }) && isHighExpectation({ g0: 0.3 }) && !isHighExpectation({ forwardPE: 20, g0: 0.12 }) && !isHighExpectation(), 'high-expectation detector');
console.log(fail ? `FAILED ${fail} of ${pass + fail}` : `OK: ${pass} earnings-context tests passed`);
process.exit(fail ? 1 : 0);
