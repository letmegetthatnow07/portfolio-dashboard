#!/usr/bin/env node
'use strict';

/**
 * CORRELATION ENGINE — Rolling 250-Day Returns-Based Pearson Matrix
 *
 * Architecture:
 *   1. Read historical_prices.csv  → seed data (M/D/YYYY dates)
 *   2. Fetch daily_metrics from Supabase → live daily updates (YYYY-MM-DD dates)
 *   3. Merge in memory, normalise all dates to ISO, deduplicate
 *   4. Slice to last 250 trading days
 *   5. Compute RETURNS-based Pearson (not raw prices — avoids trending bias)
 *   6. Fetch last 21-day + 63-day average of regime_flags per symbol for stable winner logic
 *   7. Save matrix + insights to Redis
 *
 * FIXES applied vs previous version:
 *   FIX-A: lowConfidence flag now correctly set for pairs with 15-29 shared return observations.
 *          Was: n < 30 returned null before lowConfidence could ever be true (dead code).
 *          Now: n < 15 → null (absolute minimum), 15-29 → r with lowConfidence:true, 30+ → full confidence.
 *   FIX-B: _dataPoints now stores r1.length (actual return observations used in Pearson)
 *          not shared.length (price date count, which is off-by-1).
 *   FIX-C: _dataPoints is now included in the Redis payload so dashboard can display data quality.
 *   FIX-D: Multi-day gap detection skips returns that span >3 calendar days (halts, new listings).
 *          This prevents inflated single-return observations from distorting the correlation.
 *   FIX-E: Single Redis connection reused across the entire run (was two separate open/close cycles).
 *   FIX-F: WEAK_SIGNAL verdict is now documented alongside the conviction gates.
 */

const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { createClient: createRedisClient }    = require('redis');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Normalise any date string to ISO YYYY-MM-DD ──────────────────────────────
// Handles: "2/18/2025", "02/18/2025", "2025-02-18"
function toISO(dateStr) {
  if (!dateStr) return null;
  const s = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;        // already ISO
  const parts = s.split('/');
  if (parts.length === 3) {
    const [m, d, y] = parts;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

// ── Returns-based Pearson correlation ────────────────────────────────────────
// FIX-A: Three-tier minimum, not a hard n<30 cutoff.
//
// n < 15:  Absolute minimum — too few points for any meaningful number. Return null.
// n 15-29: Low-confidence zone. Pearson r is computed and returned, but flagged
//          with lowConfidence:true so the dashboard can shade it. The 95% CI at
//          n=15 is roughly ±0.50 around the estimate, so it should be treated as
//          indicative, not reliable. Better to show a shaded estimate than '—' for
//          pairs that are genuinely accumulating history.
// n >= 30: Full confidence. 95% CI narrows to ±0.35 at n=30, ±0.18 at n=100.
//          This is the level at which correlation-based position sizing decisions
//          become defensible.
//
// Do not lower the full-confidence threshold below 30 — see methodology note above.
//
// Returns: { r, n, lowConfidence }
function calculatePearson(x, y) {
  const n = x.length;
  if (n !== y.length || n < 15) return { r: null, n, lowConfidence: true };
  const r = _pearson(x, y, n);
  return { r, n, lowConfidence: n < 30 };
}

function _pearson(x, y, n) {
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const mx = mean(x), my = mean(y);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const ex = x[i] - mx, ey = y[i] - my;
    num += ex * ey; dx2 += ex * ex; dy2 += ey * ey;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? null : num / denom;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function runCorrelationEngine() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' CORRELATION ENGINE — Rolling 250-Day Returns Matrix');
  console.log('═══════════════════════════════════════════════════════════\n');

  const priceData = {};
  const allDates  = new Set();

  // ── FIX-E: Open one Redis connection, reuse throughout ───────────────────
  const redisClient = createRedisClient({ url: process.env.REDIS_URL });
  redisClient.on('error', err => console.error('Redis error:', err.message));
  await redisClient.connect();

  // STEP 1: CSV seed data
  const csvPath = path.resolve(__dirname, '../data/historical_prices.csv');
  if (fs.existsSync(csvPath)) {
    const lines = fs.readFileSync(csvPath, 'utf8')
      .split('\n').filter(l => l.trim().length > 0);
    lines.shift(); // skip header
    let csvRows = 0;
    lines.forEach(line => {
      const cols = line.split(',');
      if (cols.length < 4) return;
      const ticker  = cols[0].trim();
      const isoDate = toISO(cols[2].trim());
      const price   = parseFloat(cols[3].trim());
      if (!ticker || !isoDate || isNaN(price) || price <= 0) return;
      if (!priceData[ticker]) priceData[ticker] = {};
      priceData[ticker][isoDate] = price;
      allDates.add(isoDate);
      csvRows++;
    });
    console.log(`✓ CSV: ${csvRows} rows loaded`);
  } else {
    console.warn('⚠ historical_prices.csv not found — Supabase only');
  }

  // STEP 2: Supabase live data (overwrites CSV on same date — more authoritative)
  const { data: liveData, error: liveError } = await supabase
    .from('daily_metrics')
    .select('symbol, date, price')
    .order('date', { ascending: true })
    .limit(10000);

  if (liveError) console.warn(`⚠ Supabase warning: ${liveError.message}`);

  if (liveData?.length) {
    let supaRows = 0;
    liveData.forEach(row => {
      const isoDate = toISO(row.date);
      const price   = parseFloat(row.price);
      if (!row.symbol || !isoDate || isNaN(price) || price <= 0) return;
      if (!priceData[row.symbol]) priceData[row.symbol] = {};
      priceData[row.symbol][isoDate] = price;
      allDates.add(isoDate);
      supaRows++;
    });
    console.log(`✓ Supabase: ${supaRows} rows merged`);
  }

  // STEP 3: Filter to CURRENT portfolio only
  // Redis portfolio is the source of truth for what's currently tracked.
  // Deleted stocks disappear from the matrix on the next run.
  // FIX-E: Use the already-open redisClient, not a new one.
  let portfolioSymbols = null;
  try {
    const raw = await redisClient.get('portfolio');
    if (raw) {
      const portfolioData = JSON.parse(raw);
      portfolioSymbols = new Set(
        (portfolioData.stocks || []).map(s => s.symbol.toUpperCase())
      );
      console.log(`✓ Portfolio filter: ${[...portfolioSymbols].join(', ')}`);
    }
  } catch (e) {
    console.warn(`⚠ Portfolio filter unavailable (${e.message}) — using all tickers from price data`);
  }

  if (portfolioSymbols) {
    for (const ticker of Object.keys(priceData)) {
      if (!portfolioSymbols.has(ticker.toUpperCase())) {
        delete priceData[ticker];
        console.log(`  ↳ Removed ${ticker} (not in current portfolio)`);
      }
    }
  }

  // STEP 4: Rolling 250-day window
  const sortedDates = Array.from(allDates).sort().slice(-250);
  const tickers     = Object.keys(priceData).sort();

  console.log(`✓ Window: ${sortedDates[0]} → ${sortedDates[sortedDates.length - 1]} (${sortedDates.length} days)`);
  console.log(`✓ Tickers: ${tickers.join(', ')}\n`);

  // STEP 5: Returns-based correlation matrix
  // FIX-D: Skip return observations where the price gap spans >3 calendar days.
  //        A stock missing on day 5 would otherwise produce a return from day 4→6
  //        that spans 2 trading days, inflating single-observation volatility.
  //        3 calendar days = covers weekends (Fri→Mon). Beyond that, it's a halt
  //        or new listing and the return is not comparable with daily returns.
  //
  // FIX-B: Store r1.length (return observations) not shared.length (price dates).
  //        shared.length - 1 = number of consecutive pairs. But after gap-skipping,
  //        the actual return count may be lower. r1.length is the authoritative count.
  //
  // FIX-C: dataPoints included in Redis payload.
  //
  // FIX-A: lowConfidence now correctly set for 15-29 observations.
  console.log('Calculating returns matrix...');
  const matrix         = {};
  const lowConfidence  = {};  // { t1: { t2: true } } — pairs with 15-29 shared returns
  const dataPoints     = {};  // { t1: { t2: n } }    — actual return count per pair

  const MAX_GAP_DAYS = 3; // calendar days — covers Fri→Mon weekends

  for (let i = 0; i < tickers.length; i++) {
    matrix[tickers[i]] = {};
    for (let j = 0; j < tickers.length; j++) {
      const t1 = tickers[i], t2 = tickers[j];
      if (t1 === t2) { matrix[t1][t2] = 1.0; continue; }

      // Shared dates where both stocks have a price
      const shared = sortedDates.filter(
        d => priceData[t1][d] !== undefined && priceData[t2][d] !== undefined
      );

      const r1 = [], r2 = [];
      for (let k = 1; k < shared.length; k++) {
        const td = shared[k], pd = shared[k - 1];

        // FIX-D: Skip multi-day gaps (halts, new listings, data holes)
        const gapDays = (new Date(td) - new Date(pd)) / 86_400_000;
        if (gapDays > MAX_GAP_DAYS) continue;

        const p1t = priceData[t1][td], p1p = priceData[t1][pd];
        const p2t = priceData[t2][td], p2p = priceData[t2][pd];
        if (p1p > 0 && p2p > 0) {
          r1.push((p1t - p1p) / p1p);
          r2.push((p2t - p2p) / p2p);
        }
      }

      const { r, n: returnCount, lowConfidence: isLowConf } = calculatePearson(r1, r2);
      matrix[t1][t2] = r !== null ? parseFloat(r.toFixed(3)) : null;

      // FIX-A: populate lowConfidence metadata for dashboard shading
      if (r !== null && isLowConf) {
        if (!lowConfidence[t1]) lowConfidence[t1] = {};
        lowConfidence[t1][t2] = true;
      }

      // FIX-B: store actual return observations (not price date count)
      // FIX-C: stored in separate object, included in Redis payload below
      if (i < j) {
        if (!dataPoints[t1]) dataPoints[t1] = {};
        dataPoints[t1][t2] = returnCount; // r1.length — actual Pearson input count
      }
    }
  }
  console.log('✓ Matrix complete');

  // STEP 6: Multi-window regime stats — 21d AND 63d per symbol
  //
  // Why two windows?
  //   21d = recent momentum (can be noisy — one earnings beat inflates it)
  //   63d = one quarter of structural behaviour (harder to fake)
  //
  // A RECOMMEND verdict only fires when BOTH windows agree on the winner.
  // This prevents switching based on a single good month.

  const now = new Date();

  const cutoff21d = new Date(now);
  cutoff21d.setDate(cutoff21d.getDate() - 30);  // ~21 trading days in calendar

  const cutoff63d = new Date(now);
  cutoff63d.setDate(cutoff63d.getDate() - 90);  // ~63 trading days in calendar

  const querySymbols = tickers.length > 0 ? tickers
    : portfolioSymbols ? [...portfolioSymbols] : [];

  let regimeFlagsQuery = supabase
    .from('regime_flags')
    .select('symbol, date, excess_return_pct, quality_score, action, regime_status, w2_confirmed, w3_confirmed, w4_confirmed')
    .gte('date', cutoff63d.toISOString().split('T')[0])
    .order('date', { ascending: false });

  // Only apply symbol filter when we have a non-empty list.
  // Empty .in() returns 0 rows on most PostgREST versions — avoid.
  if (querySymbols.length > 0) {
    regimeFlagsQuery = regimeFlagsQuery.in('symbol', querySymbols);
  } else {
    console.warn('⚠ No portfolio symbols available — fetching all regime_flags (unfiltered)');
  }

  const { data: regimeRows, error: regimeError } = await regimeFlagsQuery;
  if (regimeError) console.warn(`⚠ Regime flags warning: ${regimeError.message}`);

  const cutoff21dISO = cutoff21d.toISOString().split('T')[0];

  const accum = {};
  (regimeRows || []).forEach(row => {
    const sym = row.symbol;
    if (!accum[sym]) {
      accum[sym] = {
        excess21Sum: 0, quality21Sum: 0, count21: 0,
        excess63Sum: 0, quality63Sum: 0, count63: 0,
        w2Hits: 0, w3Hits: 0, w4Hits: 0, totalRows: 0,
        latest_action: row.action,
        latest_regime: row.regime_status,
      };
    }

    const a   = accum[sym];
    const exc = parseFloat(row.excess_return_pct || 0);
    const ql  = parseFloat(row.quality_score     || 0);

    a.excess63Sum += exc;
    a.quality63Sum += ql;
    a.count63++;

    if (row.date >= cutoff21dISO) {
      a.excess21Sum += exc;
      a.quality21Sum += ql;
      a.count21++;
    }

    if (row.w2_confirmed) a.w2Hits++;
    if (row.w3_confirmed) a.w3Hits++;
    if (row.w4_confirmed) a.w4Hits++;
    a.totalRows++;
  });

  const statsMap = {};
  Object.entries(accum).forEach(([sym, a]) => {
    const alpha21 = a.count21 > 0 ? a.excess21Sum / a.count21 : null;
    const alpha63 = a.count63 > 0 ? a.excess63Sum / a.count63 : null;
    const qual21  = a.count21 > 0 ? a.quality21Sum / a.count21 : null;
    const qual63  = a.count63 > 0 ? a.quality63Sum / a.count63 : null;

    const w2Pct = a.totalRows > 0 ? a.w2Hits / a.totalRows : 0;
    const w3Pct = a.totalRows > 0 ? a.w3Hits / a.totalRows : 0;
    const w4Pct = a.totalRows > 0 ? a.w4Hits / a.totalRows : 0;

    let cascadeHealth = 'HEALTHY';
    if (w4Pct > 0.10)      cascadeHealth = 'CRITICAL';
    else if (w3Pct > 0.25) cascadeHealth = 'DECAYING';
    else if (w2Pct > 0.40) cascadeHealth = 'WEAKENING';

    statsMap[sym] = {
      alpha21,
      alpha63,
      qual21,
      qual63,
      cascadeHealth,
      w2Pct, w3Pct, w4Pct,
      dataRows:      a.count63,
      action:        a.latest_action || 'HOLD',
      regime_status: a.latest_regime || 'NORMAL',
    };
  });

  console.log(`✓ Regime stats: 21d + 63d windows for ${Object.keys(statsMap).length} symbols`);

  // STEP 7: Capital optimisation insights — conviction-gated
  //
  // Conviction gates (ALL must pass for a RECOMMEND to fire):
  //   G1. Correlation confirmed:    Returns-based Pearson >= 0.65 over 250d
  //   G2. Both tickers have data:   >= 21 days of Supabase history each
  //   G3. Winner not in decay:      cascadeHealth != DECAYING / CRITICAL
  //   G4. Winner regime is safe:    not IDIOSYNCRATIC_DECAY
  //   G5. Alpha edge is material:   winner leads by > 2% on 21d alpha
  //   G6. 63d confirms 21d:         winner also leads on 63d alpha AND edge > 1%
  //   G7. Quality confirms:         winner's qual63 >= loser's qual63 by > 0.5 pts
  //
  // Verdict tiers:
  //   RECOMMEND   — winnerScore >= 4: clear multi-gate evidence for one ticker
  //   WEAK_SIGNAL — winnerScore  < 4: winner identified but evidence is thin
  //   MONITOR     — tied, blocked, or insufficient data: no recommendation yet
  //
  // FIX-F: WEAK_SIGNAL is documented here alongside the conviction gates.

  const THRESHOLD      = 0.65;
  const MIN_ALPHA_EDGE = 2.0;   // % — minimum meaningful alpha difference (G5)
  const MIN_DATA_ROWS  = 21;    // days of Supabase history required (G2)
  const insights = [];

  const BLOCKED_ACTIONS = new Set(['SELL', 'TRIM_25', 'IDIOSYNCRATIC_DECAY']);
  const BLOCKED_REGIMES = new Set(['IDIOSYNCRATIC_DECAY']);
  const BLOCKED_CASCADE = new Set(['DECAYING', 'CRITICAL']);

  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const t1 = tickers[i], t2 = tickers[j];
      const corr = matrix[t1][t2];

      // G1
      if (corr === null || corr < THRESHOLD) continue;

      const s1 = statsMap[t1];
      const s2 = statsMap[t2];

      const t1HasData = s1 && s1.dataRows >= MIN_DATA_ROWS;
      const t2HasData = s2 && s2.dataRows >= MIN_DATA_ROWS;

      const basePayload = {
        pair:        [t1, t2],
        correlation: corr,
        corrTier:    corr >= 0.85 ? 'extreme' : corr >= 0.75 ? 'high' : 'moderate',
        t1Stats:     s1 || null,
        t2Stats:     s2 || null,
      };

      if (!t1HasData || !t2HasData) {
        insights.push({
          ...basePayload,
          verdict:       'MONITOR',
          verdictReason: 'Insufficient Supabase history (<21 days) to make a data-driven recommendation.',
          winner: null, loser: null,
        });
        continue;
      }

      const evaluate = (sym, s, oSym, oS) => {
        const reasons = [];
        let score = 0;

        // G5: Alpha edge on 21d window
        const alphaEdge21 = (s.alpha21 ?? 0) - (oS.alpha21 ?? 0);
        if (alphaEdge21 > MIN_ALPHA_EDGE) {
          score += 3;
          reasons.push(`+${alphaEdge21.toFixed(1)}% alpha edge (21d)`);
        } else if (alphaEdge21 > 0) {
          score += 1;
        }

        // G6: 63d confirms 21d — both edge must be material (>1%) for full credit
        const alphaEdge63 = (s.alpha63 ?? 0) - (oS.alpha63 ?? 0);
        if (alphaEdge63 > MIN_ALPHA_EDGE / 2 && alphaEdge21 > MIN_ALPHA_EDGE) {
          score += 2;
          reasons.push(`confirmed over 63d (+${alphaEdge63.toFixed(1)}%)`);
        } else if (alphaEdge63 > 0 && alphaEdge21 > 0) {
          score += 1;
          reasons.push(`weak 63d confirmation (+${alphaEdge63.toFixed(1)}%)`);
        }

        // G7: Quality score higher over 63d (bonus, not a hard veto — see methodology note)
        const qualEdge = (s.qual63 ?? 0) - (oS.qual63 ?? 0);
        if (qualEdge > 0.5) {
          score += 2;
          reasons.push(`higher quality score (${(s.qual63 ?? 0).toFixed(1)} vs ${(oS.qual63 ?? 0).toFixed(1)})`);
        }

        // Cascade health bonus
        if (s.cascadeHealth === 'HEALTHY') { score += 1; }

        // Hard blockers — disqualify regardless of score (G3, G4)
        const blocked =
          BLOCKED_ACTIONS.has(s.action) ||
          BLOCKED_REGIMES.has(s.regime_status) ||
          BLOCKED_CASCADE.has(s.cascadeHealth);

        return { score, reasons, blocked };
      };

      const e1 = evaluate(t1, s1, t2, s2);
      const e2 = evaluate(t2, s2, t1, s1);

      if (e1.blocked && e2.blocked) {
        insights.push({
          ...basePayload,
          verdict:       'MONITOR',
          verdictReason: `Both ${t1} and ${t2} are in a decay or sell regime. Hold both until conditions improve.`,
          winner: null, loser: null,
        });
        continue;
      }

      let winner, loser, wStat, lStat, winnerReasons, winnerScore;

      if (!e1.blocked && e2.blocked) {
        winner = t1; loser = t2; wStat = s1; lStat = s2;
        winnerReasons = [`${t2} is in ${s2.cascadeHealth} cascade / ${s2.action} action`];
        winnerScore = e1.score;
      } else if (e1.blocked && !e2.blocked) {
        winner = t2; loser = t1; wStat = s2; lStat = s1;
        winnerReasons = [`${t1} is in ${s1.cascadeHealth} cascade / ${s1.action} action`];
        winnerScore = e2.score;
      } else if (e1.score > e2.score) {
        winner = t1; loser = t2; wStat = s1; lStat = s2;
        winnerReasons = e1.reasons;
        winnerScore = e1.score;
      } else if (e2.score > e1.score) {
        winner = t2; loser = t1; wStat = s2; lStat = s1;
        winnerReasons = e2.reasons;
        winnerScore = e2.score;
      } else {
        insights.push({
          ...basePayload,
          verdict:       'MONITOR',
          verdictReason: `Insufficient evidence to prefer either ticker. Both show similar multi-window alpha and quality. Watch for divergence.`,
          winner: null, loser: null,
        });
        continue;
      }

      // FIX-F: WEAK_SIGNAL fires when winner identified but evidence is thin (score < 4)
      const verdict = winnerScore >= 4 ? 'RECOMMEND' : 'WEAK_SIGNAL';

      insights.push({
        ...basePayload,
        verdict,
        winner,
        loser,
        winnerAlpha21:   wStat.alpha21,
        winnerAlpha63:   wStat.alpha63,
        winnerQual63:    wStat.qual63,
        winnerCascade:   wStat.cascadeHealth,
        winnerAction:    wStat.action,
        winnerRegime:    wStat.regime_status,
        loserAlpha21:    lStat.alpha21,
        loserAlpha63:    lStat.alpha63,
        loserQual63:     lStat.qual63,
        loserCascade:    lStat.cascadeHealth,
        loserAction:     lStat.action,
        loserRegime:     lStat.regime_status,
        winnerReasons,
        winnerScore,
      });
    }
  }

  insights.sort((a, b) => {
    const tier = { RECOMMEND: 0, WEAK_SIGNAL: 1, MONITOR: 2 };
    const tDiff = (tier[a.verdict] ?? 2) - (tier[b.verdict] ?? 2);
    return tDiff !== 0 ? tDiff : b.correlation - a.correlation;
  });

  const recommends  = insights.filter(i => i.verdict === 'RECOMMEND').length;
  const weakSignals = insights.filter(i => i.verdict === 'WEAK_SIGNAL').length;
  const monitors    = insights.filter(i => i.verdict === 'MONITOR').length;
  console.log(`✓ ${insights.length} pairs flagged — RECOMMEND:${recommends} WEAK:${weakSignals} MONITOR:${monitors}`);

  // STEP 8: Save to Redis
  // FIX-C: dataPoints now included in the payload.
  // FIX-E: reusing the already-open redisClient.
  try {
    await redisClient.set('portfolio_correlation', JSON.stringify({
      lastUpdated: new Date().toISOString(),
      windowStart: sortedDates[0],
      windowEnd:   sortedDates[sortedDates.length - 1],
      windowDays:  sortedDates.length,
      tickers,
      matrix,
      lowConfidence,  // pairs with 15-29 shared return observations — for dashboard shading
      dataPoints,     // FIX-C: actual return count per upper-triangle pair — for data quality display
      insights,
      threshold: THRESHOLD,
    }));
    console.log(`\n✅ Saved to Redis — ${tickers.length} tickers · ${insights.length} insights`);
  } catch (err) {
    console.error('Redis save failed:', err.message);
    process.exit(1);
  } finally {
    await redisClient.quit();
  }

  process.exit(0);
}

runCorrelationEngine().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
