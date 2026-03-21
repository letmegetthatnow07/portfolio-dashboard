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
 *   6. Fetch last 21-day average of regime_flags per symbol for stable winner logic
 *   7. Save matrix + insights to Redis
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
function calculatePearson(x, y) {
  const n = x.length;
  if (n < 5 || n !== y.length) return null;
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const mx = mean(x), my = mean(y);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const ex = x[i] - mx, ey = y[i] - my;
    num += ex * ey; dx2 += ex * ex; dy2 += ey * ey;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function runCorrelationEngine() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' CORRELATION ENGINE — Rolling 250-Day Returns Matrix');
  console.log('═══════════════════════════════════════════════════════════\n');

  const priceData = {};
  const allDates  = new Set();

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
  // This ensures deleted stocks disappear from the matrix on the next run.
  // Redis portfolio is the source of truth for what's currently tracked.
  let portfolioSymbols = null;
  try {
    const redis = createRedisClient({ url: process.env.REDIS_URL });
    redis.on('error', () => {});
    await redis.connect();
    const raw = await redis.get('portfolio');
    if (raw) {
      const portfolioData = JSON.parse(raw);
      portfolioSymbols = new Set(
        (portfolioData.stocks || []).map(s => s.symbol.toUpperCase())
      );
      console.log(`✓ Portfolio filter: ${[...portfolioSymbols].join(', ')}`);
    }
    await redis.quit();
  } catch (e) {
    console.warn(`⚠ Portfolio filter unavailable (${e.message}) — using all tickers from price data`);
  }

  // Apply filter: only keep tickers in the current portfolio
  // Always include all tickers if filter unavailable (graceful fallback)
  if (portfolioSymbols) {
    for (const ticker of Object.keys(priceData)) {
      if (!portfolioSymbols.has(ticker.toUpperCase())) {
        delete priceData[ticker];
        console.log(`  ↳ Removed ${ticker} (not in current portfolio)`);
      }
    }
  }

  // STEP 4: Rolling 250-day window
  // ISO dates sort correctly alphabetically (YYYY-MM-DD)
  const sortedDates = Array.from(allDates).sort().slice(-250);
  const tickers     = Object.keys(priceData).sort();

  console.log(`✓ Window: ${sortedDates[0]} → ${sortedDates[sortedDates.length - 1]} (${sortedDates.length} days)`);
  console.log(`✓ Tickers: ${tickers.join(', ')}\n`);

  // STEP 5: Returns-based correlation matrix
  console.log('Calculating returns matrix...');
  const matrix = {};

  for (let i = 0; i < tickers.length; i++) {
    matrix[tickers[i]] = {};
    for (let j = 0; j < tickers.length; j++) {
      const t1 = tickers[i], t2 = tickers[j];
      if (t1 === t2) { matrix[t1][t2] = 1.0; continue; }

      const shared = sortedDates.filter(
        d => priceData[t1][d] !== undefined && priceData[t2][d] !== undefined
      );

      const r1 = [], r2 = [];
      for (let k = 1; k < shared.length; k++) {
        const td = shared[k], pd = shared[k - 1];
        if (td === pd) continue;
        const p1t = priceData[t1][td], p1p = priceData[t1][pd];
        const p2t = priceData[t2][td], p2p = priceData[t2][pd];
        if (p1p > 0 && p2p > 0) {
          r1.push((p1t - p1p) / p1p);
          r2.push((p2t - p2p) / p2p);
        }
      }

      const corr = calculatePearson(r1, r2);
      matrix[t1][t2] = corr !== null ? parseFloat(corr.toFixed(3)) : 0;
    }
  }
  console.log('✓ Matrix complete');

  // STEP 6: Multi-window regime stats — 21d AND 63d per symbol
  //
  // Why two windows?
  //   21d = recent momentum (can be noisy — one earnings beat inflates it)
  //   63d = one quarter of structural behaviour (harder to fake)
  //
  // A recommendation only fires when BOTH windows agree on the winner.
  // This prevents switching based on a single good month.

  const now = new Date();

  const cutoff21d = new Date(now);
  cutoff21d.setDate(cutoff21d.getDate() - 30);  // ~21 trading days in calendar days

  const cutoff63d = new Date(now);
  cutoff63d.setDate(cutoff63d.getDate() - 90);  // ~63 trading days in calendar days

  // Fetch all rows from the 63d window (includes the 21d window too)
  const { data: regimeRows, error: regimeError } = await supabase
    .from('regime_flags')
    .select('symbol, date, excess_return_pct, quality_score, action, regime_status, w2_confirmed, w3_confirmed, w4_confirmed')
    .gte('date', cutoff63d.toISOString().split('T')[0])
    .order('date', { ascending: false });

  if (regimeError) console.warn(`⚠ Regime flags warning: ${regimeError.message}`);

  const cutoff21dISO = cutoff21d.toISOString().split('T')[0];

  // Separate accumulators for 21d and 63d windows
  const accum = {};

  (regimeRows || []).forEach(row => {
    const sym = row.symbol;
    if (!accum[sym]) {
      accum[sym] = {
        // 21d bucket
        excess21Sum: 0, quality21Sum: 0, count21: 0,
        // 63d bucket
        excess63Sum: 0, quality63Sum: 0, count63: 0,
        // Cascade worst-case across the 63d window
        w2Hits: 0, w3Hits: 0, w4Hits: 0, totalRows: 0,
        // Most recent snapshot (first row = most recent because ordered DESC)
        latest_action:  row.action,
        latest_regime:  row.regime_status,
      };
    }

    const a   = accum[sym];
    const exc = parseFloat(row.excess_return_pct || 0);
    const ql  = parseFloat(row.quality_score     || 0);

    // Always add to 63d bucket
    a.excess63Sum += exc;
    a.quality63Sum += ql;
    a.count63++;

    // Only add to 21d bucket if within the tighter window
    if (row.date >= cutoff21dISO) {
      a.excess21Sum += exc;
      a.quality21Sum += ql;
      a.count21++;
    }

    // Count cascade warning days
    if (row.w2_confirmed) a.w2Hits++;
    if (row.w3_confirmed) a.w3Hits++;
    if (row.w4_confirmed) a.w4Hits++;
    a.totalRows++;
  });

  // Build final statsMap with computed averages and cascade health flags
  const statsMap = {};
  Object.entries(accum).forEach(([sym, a]) => {

    const alpha21 = a.count21 > 0 ? a.excess21Sum / a.count21 : null;
    const alpha63 = a.count63 > 0 ? a.excess63Sum / a.count63 : null;
    const qual21  = a.count21 > 0 ? a.quality21Sum / a.count21 : null;
    const qual63  = a.count63 > 0 ? a.quality63Sum / a.count63 : null;

    // Cascade health: what % of the 63d window showed each warning level
    const w2Pct = a.totalRows > 0 ? a.w2Hits / a.totalRows : 0;
    const w3Pct = a.totalRows > 0 ? a.w3Hits / a.totalRows : 0;
    const w4Pct = a.totalRows > 0 ? a.w4Hits / a.totalRows : 0;

    // Health verdict: HEALTHY / WEAKENING / DECAYING / CRITICAL
    let cascadeHealth = 'HEALTHY';
    if (w4Pct > 0.10)      cascadeHealth = 'CRITICAL';   // W4 active >10% of days
    else if (w3Pct > 0.25) cascadeHealth = 'DECAYING';   // W3 active >25% of days
    else if (w2Pct > 0.40) cascadeHealth = 'WEAKENING';  // W2 active >40% of days

    statsMap[sym] = {
      alpha21,          // 21d avg excess return (nullable if <21d data)
      alpha63,          // 63d avg excess return (nullable if <63d data)
      qual21,
      qual63,
      cascadeHealth,
      w2Pct, w3Pct, w4Pct,
      dataRows:        a.count63,
      action:          a.latest_action || 'HOLD',
      regime_status:   a.latest_regime || 'NORMAL',
    };
  });

  console.log(`✓ Regime stats: 21d + 63d windows for ${Object.keys(statsMap).length} symbols`);

  // STEP 7: Capital optimisation insights — conviction-gated
  //
  // Conviction gates (ALL must pass for a recommendation to fire):
  //   G1. Correlation confirmed:    Returns-based Pearson >= 0.65 over 250d
  //   G2. Both tickers have data:   >= 21 days of Supabase history each
  //   G3. Winner not in decay:      cascadeHealth != DECAYING / CRITICAL
  //   G4. Winner regime is safe:    not IDIOSYNCRATIC_DECAY
  //   G5. Alpha edge is material:   winner leads by > 2% on 21d alpha
  //   G6. 63d confirms 21d:         winner also leads on 63d alpha (same direction)
  //   G7. Quality confirms:         winner's qual63 >= loser's qual63
  //
  // If gates G5/G6/G7 don't clearly point to one ticker, we emit a
  // MONITOR card (no recommendation, just flagging the correlation).

  const THRESHOLD = 0.65;
  const MIN_ALPHA_EDGE = 2.0;     // % — minimum meaningful alpha difference
  const MIN_DATA_ROWS  = 21;      // days of Supabase history required
  const insights = [];

  // Actions that block a ticker from being recommended as a consolidation target
  const BLOCKED_ACTIONS  = new Set(['SELL', 'TRIM_25', 'IDIOSYNCRATIC_DECAY']);
  const BLOCKED_REGIMES  = new Set(['IDIOSYNCRATIC_DECAY']);
  const BLOCKED_CASCADE  = new Set(['DECAYING', 'CRITICAL']);

  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const t1 = tickers[i], t2 = tickers[j];
      const corr = matrix[t1][t2];

      // G1: correlation threshold
      if (corr < THRESHOLD) continue;

      const s1 = statsMap[t1];
      const s2 = statsMap[t2];

      // G2: minimum data — if either ticker has < 21 days, we can't make a call
      const t1HasData = s1 && s1.dataRows >= MIN_DATA_ROWS;
      const t2HasData = s2 && s2.dataRows >= MIN_DATA_ROWS;

      // Shared base payload for both RECOMMEND and MONITOR cards
      const basePayload = {
        pair:         [t1, t2],
        correlation:  corr,
        corrTier:     corr >= 0.85 ? 'extreme' : corr >= 0.75 ? 'high' : 'moderate',
        t1Stats:      s1 || null,
        t2Stats:      s2 || null,
      };

      // Not enough data yet — emit a MONITOR card, no recommendation
      if (!t1HasData || !t2HasData) {
        insights.push({
          ...basePayload,
          verdict:       'MONITOR',
          verdictReason: 'Insufficient Supabase history (<21 days) to make a data-driven recommendation.',
          winner: null, loser: null,
        });
        continue;
      }

      // Evaluate each ticker as a potential winner
      const evaluate = (sym, s, oSym, oS) => {
        const reasons = [];
        let score = 0;

        // Alpha edge on 21d window
        const alphaEdge21 = (s.alpha21 ?? 0) - (oS.alpha21 ?? 0);
        if (alphaEdge21 > MIN_ALPHA_EDGE) {
          score += 3;
          reasons.push(`+${alphaEdge21.toFixed(1)}% alpha edge (21d)`);
        } else if (alphaEdge21 > 0) {
          score += 1; // marginal, not decisive
        }

        // 63d confirms 21d (both windows agree)
        const alphaEdge63 = (s.alpha63 ?? 0) - (oS.alpha63 ?? 0);
        if (alphaEdge63 > 0 && alphaEdge21 > 0) {
          score += 2;
          reasons.push(`confirmed over 63d (+${alphaEdge63.toFixed(1)}%)`);
        }

        // Quality score higher over 63d
        const qualEdge = (s.qual63 ?? 0) - (oS.qual63 ?? 0);
        if (qualEdge > 0.5) {
          score += 2;
          reasons.push(`higher quality score (${(s.qual63 ?? 0).toFixed(1)} vs ${(oS.qual63 ?? 0).toFixed(1)})`);
        }

        // Cascade health bonus
        if (s.cascadeHealth === 'HEALTHY') { score += 1; }

        // Hard blockers — disqualify regardless of score
        const blocked =
          BLOCKED_ACTIONS.has(s.action) ||
          BLOCKED_REGIMES.has(s.regime_status) ||
          BLOCKED_CASCADE.has(s.cascadeHealth);

        return { score, reasons, blocked };
      };

      const e1 = evaluate(t1, s1, t2, s2);
      const e2 = evaluate(t2, s2, t1, s1);

      // Both blocked — neither is safe to recommend
      if (e1.blocked && e2.blocked) {
        insights.push({
          ...basePayload,
          verdict:       'MONITOR',
          verdictReason: `Both ${t1} and ${t2} are in a decay or sell regime. Hold both until conditions improve.`,
          winner: null, loser: null,
        });
        continue;
      }

      // Determine winner
      let winner, loser, wStat, lStat, winnerReasons, winnerScore;

      if (!e1.blocked && e2.blocked) {
        // t2 is blocked — t1 wins by default
        winner = t1; loser = t2; wStat = s1; lStat = s2;
        winnerReasons = [`${t2} is in ${s2.cascadeHealth} cascade / ${s2.action} action`];
        winnerScore = e1.score;
      } else if (e1.blocked && !e2.blocked) {
        // t1 is blocked — t2 wins by default
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
        // Tied — emit MONITOR, don't force a call
        insights.push({
          ...basePayload,
          verdict:       'MONITOR',
          verdictReason: `Insufficient evidence to prefer either ticker. Both show similar multi-window alpha and quality. Watch for divergence.`,
          winner: null, loser: null,
        });
        continue;
      }

      // Final check: does the winner have a material proven edge?
      // Score < 4 means we found a winner but the edge is thin — downgrade to MONITOR
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
        winnerReasons,   // array of human-readable evidence strings
        winnerScore,
      });
    }
  }

  // Sort: RECOMMEND first, then by correlation strength
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
  const redisClient = createRedisClient({ url: process.env.REDIS_URL });
  redisClient.on('error', err => console.error('Redis error:', err.message));

  try {
    await redisClient.connect();
    await redisClient.set('portfolio_correlation', JSON.stringify({
      lastUpdated: new Date().toISOString(),
      windowStart: sortedDates[0],
      windowEnd:   sortedDates[sortedDates.length - 1],
      windowDays:  sortedDates.length,
      tickers,
      matrix,
      insights,
      threshold:   THRESHOLD,
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
