'use strict';
/**
 * EARNINGS CONTEXT: what the last reports said about revenue (and EPS) versus what analysts expected.
 *
 * Why revenue: revenue is the hardest line to manage. A beat means demand is running ahead of what analysts modelled;
 * a miss usually means estimates and guidance come down next. For stocks priced for perfection, merely MEETING
 * the number is itself a disappointment, so those names get a higher bar (see isHighExpectation).
 *
 * Inputs (all produced by backend/scripts/earnings-event.js):
 *   surprises = Redis earnings_surprise_{SYM}: { quarters: [{ date, quarter, year, revenueActual, revenueEstimate, epsActual, epsEstimate }] }
 *   event     = Redis earnings_event_{SYM}:    Gemini read of the latest release (only guidance_direction and the old booleans are used)
 *
 * One function, two consumers:
 *   daily-update.js   -> compositePoints (adjusts the daily composite) + blockAdds (suppresses ADD / SPRING signals)
 *   multibagger.js    -> flags, blockAdds, streak (thesis check) and executionScore (a scored part)
 * The two layers use it independently. Nothing here changes the quality (fund) score or the W1-W4 decay cascade.
 *
 * All thresholds are PROPOSED defaults, not backtested. They live in one table so they can be tuned in one place.
 */
const DAY = 86400000;

const P = {
  // revenue surprise grading (fraction of the estimate)
  BEAT: 0.01, STRONG_BEAT: 0.03, MISS: -0.01, BIG_MISS: -0.03,
  // raw points per grade (before scaling)
  PTS: { STRONG_BEAT: 1.0, BEAT: 0.5, IN_LINE: 0.0, MISS: -0.7, BIG_MISS: -1.2 },
  // priced-for-perfection names: meeting the number is a mild negative, a small beat is only neutral-to-slight positive
  HIGH_EXPECT_PTS: { IN_LINE: -0.4, BEAT: 0.2 },
  EPS_PTS: 0.3, EPS_BAND: 0.02,                       // EPS beat/miss of 2%+ adds/subtracts this (secondary to revenue)
  GUIDE_PTS: { raised: 0.5, lowered: -0.8 },          // guidance direction (Gemini read: lower confidence, smaller weight)
  RAW_CAP: 2.0,
  COMPOSITE_SCALE: 0.3,                               // raw +/-2.0 -> +/-0.6 on the 0-10 daily composite (news carries about +/-0.14)
  DECAY_DAYS: 60, DECAY_FLOOR: 0.15,                  // the adjustment fades over ~2 months, like the 8-K adjustment
  BLOCK_ADD_DAYS: 45,                                 // after a miss / disappointing report: no NEW buying for this long
  STREAK_BLOCK_DAYS: 90,
  RECENT_DAYS: 100,                                   // older than this = no longer "the latest cycle"
  MAX_PLAUSIBLE: 0.5,                                 // a |surprise| above 50% is treated as bad data (currency/unit mismatch), not a result
  LLM_FALLBACK_WEIGHT: 0.5,                           // only the Gemini beat/miss boolean available: half weight, never blocks alone
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const dayMs = d => { const t = Date.parse(d ?? ''); return Number.isFinite(t) ? t : null; };

/** (actual - estimate) / |estimate|. null when either side is missing/zero or the result is implausible. */
function surprise(actual, estimate) {
  const a = num(actual), e = num(estimate);
  if (a == null || e == null || e === 0) return null;
  const s = (a - e) / Math.abs(e);
  return Math.abs(s) > P.MAX_PLAUSIBLE ? null : s;
}

function grade(s) {
  if (s == null) return null;
  if (s >= P.STRONG_BEAT) return 'STRONG_BEAT';
  if (s >= P.BEAT) return 'BEAT';
  if (s <= P.BIG_MISS) return 'BIG_MISS';
  if (s <= P.MISS) return 'MISS';
  return 'IN_LINE';
}

/** Names the market already prices for perfection: a rich forward multiple, hypergrowth, or very high expected growth. */
function isHighExpectation({ forwardPE, hypergrowth, g0 } = {}) {
  return (num(forwardPE) != null && forwardPE > 35) || hypergrowth === true || (num(g0) != null && g0 >= 0.25);
}

const pct = (s, dp = 1) => `${s >= 0 ? '+' : ''}${(s * 100).toFixed(dp)}%`;

function assessEarningsContext({ surprises = null, event = null, highExpectations = false, now = Date.now() } = {}) {
  const empty = { source: 'NONE', latest: null, daysSince: null, grade: null, rawPoints: 0, compositePoints: 0, blockAdds: false, blockReason: null, blockDays: 0, missStreak: 0, beatStreak: 0, executionScore: null, quarters: [], flags: [] };

  // reported quarters, oldest -> newest, with computed surprises
  const quarters = (surprises?.quarters || [])
    .map(q => ({ ...q, t: dayMs(q?.date), revSurprise: surprise(q?.revenueActual, q?.revenueEstimate), epsSurprise: surprise(q?.epsActual, q?.epsEstimate) }))
    .filter(q => q.t != null && (q.revSurprise != null || q.epsSurprise != null))
    .sort((a, b) => a.t - b.t)
    .map(q => ({ date: q.date, quarter: q.quarter ?? null, year: q.year ?? null, revSurprise: q.revSurprise, epsSurprise: q.epsSurprise, grade: grade(q.revSurprise), t: q.t }));
  const guidance = ['raised', 'lowered'].includes(event?.gemini?.guidance_direction) ? event.gemini.guidance_direction : null;

  let latest = quarters.length ? quarters[quarters.length - 1] : null;
  let source = latest ? 'NUMBERS' : 'NONE';

  // Fallback: no numbers yet, only Gemini's beat/miss read of the latest release
  let llmOnly = false;
  if (!latest && event?.gemini && (typeof event.gemini.revenue_beat === 'boolean' || typeof event.gemini.eps_beat === 'boolean')) {
    const t = dayMs(event.date) ?? dayMs(event.processedAt);
    if (t != null) {
      const rb = event.gemini.revenue_beat;
      latest = { date: new Date(t).toISOString().slice(0, 10), t, revSurprise: null, epsSurprise: null, grade: rb === true ? 'BEAT' : rb === false ? 'MISS' : null, llm: true, epsBeat: event.gemini.eps_beat };
      source = 'LLM'; llmOnly = true;
    }
  }
  if (!latest) return { ...empty, flags: guidance === 'lowered' ? [{ code: 'GUIDANCE_CUT', level: 'amber', text: 'Management lowered guidance at the last report.' }] : [] };

  const daysSince = Math.max(0, (now - latest.t) / DAY);
  const recent = daysSince <= P.RECENT_DAYS;
  const flags = [];

  // raw points: revenue grade (+ EPS, + guidance)
  let raw = 0;
  if (latest.grade) {
    raw += highExpectations && latest.grade in P.HIGH_EXPECT_PTS ? P.HIGH_EXPECT_PTS[latest.grade] : P.PTS[latest.grade];
  }
  // An EPS beat that came WITH a revenue miss was not earned from demand (costs, buybacks, tax, one-offs): no credit for it.
  let lowQualityBeat = false;
  if (latest.epsSurprise != null && Math.abs(latest.epsSurprise) >= P.EPS_BAND) {
    if (latest.epsSurprise > 0 && (latest.grade === 'MISS' || latest.grade === 'BIG_MISS')) lowQualityBeat = true;
    else raw += Math.sign(latest.epsSurprise) * P.EPS_PTS;
  }
  if (guidance) raw += P.GUIDE_PTS[guidance];
  if (llmOnly) raw *= P.LLM_FALLBACK_WEIGHT;
  raw = clamp(raw, -P.RAW_CAP, P.RAW_CAP);
  const decay = Math.max(P.DECAY_FLOOR, 1 - daysSince / P.DECAY_DAYS);
  const compositePoints = recent ? +(raw * P.COMPOSITE_SCALE * decay).toFixed(3) : 0;

  // streaks over consecutive reported quarters (newest first)
  let missStreak = 0, beatStreak = 0;
  const rev = quarters.filter(q => q.revSurprise != null);
  for (let i = rev.length - 1; i >= 0 && rev[i].revSurprise <= P.MISS; i--) missStreak++;
  for (let i = rev.length - 1; i >= 0 && rev[i].revSurprise >= P.BEAT; i--) beatStreak++;

  // new-buying block: a miss, a "met but expected more" report on a high-expectation name, or lowered guidance
  let blockAdds = false, blockReason = null, blockDays = 0;
  if (recent) {
    const miss = latest.grade === 'MISS' || latest.grade === 'BIG_MISS';
    const disappoint = highExpectations && latest.grade === 'IN_LINE' && !llmOnly;
    const llmBothMiss = llmOnly && latest.grade === 'MISS' && latest.epsBeat === false;
    const days = missStreak >= 2 ? P.STREAK_BLOCK_DAYS : P.BLOCK_ADD_DAYS;
    if ((miss && !llmOnly) || llmBothMiss || disappoint || guidance === 'lowered') {
      if (daysSince <= days) {
        blockAdds = true; blockDays = Math.ceil(days - daysSince);
        blockReason = missStreak >= 2 ? `revenue missed estimates ${missStreak} quarters in a row`
          : miss || llmBothMiss ? `revenue missed estimates${latest.revSurprise != null ? ` (${pct(latest.revSurprise)})` : ''}`
          : disappoint ? `revenue only met estimates (${pct(latest.revSurprise)}) on a stock priced for more`
          : 'management lowered guidance';
      }
    }
  }

  // execution score 0-100 from the last (up to) 4 revenue surprises, recent quarters weighted more
  let execScore = null;
  const last4 = rev.slice(-4).reverse();
  if (last4.length) {
    const w = [4, 3, 2, 1];
    let ws = 0, sum = 0;
    last4.forEach((q, i) => { const v = clamp((q.revSurprise + 0.05) / 0.10, 0, 1) * 100; sum += v * w[i]; ws += w[i]; });
    execScore = Math.round(sum / ws);
  }

  // human-readable flags
  const q = latest;
  if (q.revSurprise != null && recent) {
    const d = Math.round(daysSince);
    if (q.grade === 'STRONG_BEAT' || q.grade === 'BEAT') flags.push({ code: 'REVENUE_BEAT', level: 'green', text: `Last report: revenue ${pct(q.revSurprise)} vs estimate (${d}d ago).` });
    else if (q.grade === 'IN_LINE') flags.push({ code: 'REVENUE_MET', level: highExpectations ? 'amber' : 'green', text: `Last report: revenue ${pct(q.revSurprise)}, in line with estimate (${d}d ago)${highExpectations ? '. For a stock priced for more than "in line" this counts as a mild disappointment.' : '.'}` });
    else flags.push({ code: 'REVENUE_MISS', level: 'amber', text: `Last report: revenue ${pct(q.revSurprise)} vs estimate (${d}d ago). Misses usually pull estimates and guidance down next.` });
  } else if (llmOnly && recent) {
    flags.push({ code: q.grade === 'MISS' ? 'REVENUE_MISS' : 'REVENUE_BEAT', level: q.grade === 'MISS' ? 'amber' : 'green', text: `Last report: revenue ${q.grade === 'MISS' ? 'missed' : 'beat'} estimates (AI read of the release; exact numbers not available yet).` });
  }
  if (lowQualityBeat && recent) flags.push({ code: 'LOW_QUALITY_BEAT', level: 'amber', text: `EPS beat estimates (${pct(q.epsSurprise)}) but revenue missed (${pct(q.revSurprise)}). Profit was helped by costs, buybacks or one-offs rather than sales, so it earns no credit.` });
  if (missStreak >= 2) flags.push({ code: 'REVENUE_MISS_STREAK', level: missStreak >= 3 ? 'red' : 'amber', text: `Revenue missed estimates ${missStreak} quarters in a row. Demand is running below what analysts expect.` });
  if (beatStreak >= 3) flags.push({ code: 'REVENUE_BEAT_STREAK', level: 'green', text: `Revenue beat estimates ${beatStreak} quarters in a row.` });
  if (guidance === 'lowered' && recent) flags.push({ code: 'GUIDANCE_CUT', level: 'amber', text: 'Management lowered guidance at the last report.' });
  if (guidance === 'raised' && recent) flags.push({ code: 'GUIDANCE_RAISED', level: 'green', text: 'Management raised guidance at the last report.' });

  return {
    source, latest: { date: q.date, revSurprise: q.revSurprise, epsSurprise: q.epsSurprise, grade: q.grade }, daysSince: +daysSince.toFixed(1),
    grade: q.grade, rawPoints: +raw.toFixed(3), compositePoints, blockAdds, blockReason, blockDays, missStreak, beatStreak,
    executionScore: execScore, quarters: quarters.map(({ t, ...r }) => r), flags, guidance, highExpectations: !!highExpectations,
  };
}

module.exports = { PARAMS: P, surprise, grade, isHighExpectation, assessEarningsContext };
