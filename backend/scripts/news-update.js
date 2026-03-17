#!/usr/bin/env node
'use strict';

/**
 * INTRADAY NEWS UPDATE
 *
 * Runs 3x per day: 9AM, 1PM, 4:15PM ET
 *
 * What it does:
 *   1. Fetches latest news for each stock
 *   2. Scores articles with recency weighting (fresher = more weight)
 *   3. Logs the run's news_score + recency_weight to Supabase intraday_news_log
 *   4. Updates Redis with the new composite score (using frozen master scores)
 *      and the latest headlines for the frontend
 *
 * What it does NOT do:
 *   - Fetch prices, technicals, fundamentals, insider, or analyst data
 *   - Write to daily_metrics or regime_flags
 *   - Recalculate anything except the news component
 *
 * The master run (daily-update.js) reads intraday_news_log at EOD
 * and uses the weighted average of all available runs as its news score.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const axios    = require('axios');
const logger   = require('../lib/logger');
const newsAnalyzer = require('../lib/advancedNewsAnalyzer');

const { createClient: createRedisClient }    = require('redis');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TODAY = new Date().toISOString().split('T')[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Determine which run slot this is based on current UTC hour ───────────────
// Cron times:  13 UTC = 9AM ET (slot 1)
//              17 UTC = 1PM ET (slot 2)
//              20 UTC = 4:15PM ET (slot 3)
function getRunSlot() {
  const hourUTC = new Date().getUTCHours();
  if (hourUTC < 15)  return 1; // 9AM ET run
  if (hourUTC < 19)  return 2; // 1PM ET run
  return 3;                     // 4:15PM ET run (and any later manual runs)
}

// ── Redis client ─────────────────────────────────────────────────────────────
let redisClient = null;
async function getRedisClient() {
  if (redisClient) return redisClient;
  try {
    const client = createRedisClient({ url: process.env.REDIS_URL });
    client.on('error', err => logger.warn('Redis error (non-fatal):', err.message));
    await client.connect();
    redisClient = client;
    return client;
  } catch (e) {
    logger.warn('Redis unavailable — news update will log to Supabase only');
    return null;
  }
}

// ── Fetch news from NewsData.io ───────────────────────────────────────────────
async function fetchNews(symbol) {
  try {
    const res = await axios.get(
      `https://newsdata.io/api/1/latest?apikey=${process.env.NEWSDATA_API_KEY}&q=${symbol} stock&language=en`,
      { timeout: 8000 }
    );
    if (res.data?.results?.length > 0) {
      return res.data.results.slice(0, 5).map(a => ({  // grab up to 5 for better coverage
        headline:     a.title       || '',
        description:  a.description || a.content || '',
        url:          a.link        || '',
        source:       a.source_id   || 'NewsData',
        published_at: a.pubDate     || new Date().toISOString()
      }));
    }
  } catch (e) {
    logger.warn(`News fetch failed for ${symbol}: ${e.message}`);
  }
  return [];
}

// ── Recency weight for a single article based on published_at ─────────────────
// Returns 0.15–1.00. Breaking news (< 1h old) = 1.00. Stale (> 24h) = 0.15.
function getArticleRecencyWeight(publishedAt) {
  try {
    const ageHours = (Date.now() - new Date(publishedAt).getTime()) / (1000 * 60 * 60);
    if (ageHours < 1)   return 1.00;
    if (ageHours < 3)   return 0.85;
    if (ageHours < 6)   return 0.70;
    if (ageHours < 12)  return 0.50;
    if (ageHours < 24)  return 0.30;
    return 0.15;
  } catch {
    return 0.50; // default if date parse fails
  }
}

// ── Score a batch of articles with recency weighting ─────────────────────────
// Returns { newsScore, totalRecencyWeight, scoredArticles }
// newsScore: 0–10
// totalRecencyWeight: sum of weights (used by master to compare run quality)
function scoreNewsWithRecency(rawNews, analyzedNews) {
  if (!analyzedNews?.length) {
    return { newsScore: 5, totalRecencyWeight: 0, scoredArticles: [] };
  }

  let weightedSentimentSum = 0;
  let weightedImportanceSum = 0;
  let totalWeight = 0;
  const scoredArticles = [];

  analyzedNews.forEach((item, idx) => {
    const raw = rawNews[idx];
    if (!raw) return;

    const recencyWeight = getArticleRecencyWeight(raw.published_at);
    const sentiment     = item.sentiment?.score ?? 0;
    const importance    = item.importance       ?? 5;

    weightedSentimentSum  += sentiment  * recencyWeight;
    weightedImportanceSum += importance * recencyWeight;
    totalWeight           += recencyWeight;

    scoredArticles.push({
      headline:      raw.headline.substring(0, 120),
      published_at:  raw.published_at,
      recencyWeight: parseFloat(recencyWeight.toFixed(3)),
      sentiment:     parseFloat(sentiment.toFixed(3)),
    });
  });

  if (totalWeight === 0) {
    return { newsScore: 5, totalRecencyWeight: 0, scoredArticles };
  }

  const avgSentiment  = weightedSentimentSum  / totalWeight;
  const avgImportance = weightedImportanceSum / totalWeight;

  let newsScore = 5 + (avgSentiment * 4);
  newsScore += avgSentiment > 0 ? (avgImportance / 10) : -(avgImportance / 10);
  newsScore = Math.max(0, Math.min(10, newsScore));

  return {
    newsScore:          parseFloat(newsScore.toFixed(2)),
    totalRecencyWeight: parseFloat(totalWeight.toFixed(4)),
    scoredArticles,
  };
}

// ── Composite score helper (mirrors master calculation) ───────────────────────
function computeComposite(breakdown, newsScore) {
  const { fund = 5, tech = 5, rating = 5, insider = 5 } = breakdown;
  return Math.max(0, Math.min(10,
    (fund   * 0.29) +
    (tech   * 0.16) +
    (rating * 0.20) +
    (newsScore * 0.15) +
    (insider * 0.20)
  ));
}

function getSignal(score) {
  if (score >= 8.5) return 'STRONG_BUY';
  if (score >= 7.0) return 'BUY';
  if (score >= 5.5) return 'HOLD';
  if (score >= 4.0) return 'REDUCE';
  return 'SELL';
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function updateNewsOnly() {
  const runSlot = getRunSlot();
  const slotLabel = runSlot === 1 ? 'Pre-Market (Slot 1)'
                  : runSlot === 2 ? 'Midday (Slot 2)'
                  : 'Post-Close (Slot 3)';

  logger.info('╔════════════════════════════════════════════════════════════╗');
  logger.info(`║   INTRADAY NEWS UPDATE — ${slotLabel.padEnd(31)}║`);
  logger.info(`║   Date: ${TODAY}   UTC Hour: ${new Date().getUTCHours().toString().padStart(2,'0')}:xx                    ║`);
  logger.info('╚════════════════════════════════════════════════════════════╝');

  const redisClient = await getRedisClient();

  // Read current portfolio from Redis
  let portfolio = { stocks: [] };
  if (redisClient) {
    try {
      const raw = await redisClient.get('portfolio');
      if (raw) portfolio = JSON.parse(raw);
    } catch (e) {
      logger.warn('Redis read failed — proceeding with Supabase log only');
    }
  }

  const stocks = portfolio.stocks || [];
  if (stocks.length === 0) {
    logger.warn('No stocks found in Redis. Exiting.');
    if (redisClient) await redisClient.quit();
    process.exit(0);
  }

  let updatedCount = 0;

  for (const stock of stocks) {
    try {
      logger.info(`\n  ${stock.symbol}...`);

      const rawNews = await fetchNews(stock.symbol);

      if (!rawNews.length) {
        logger.info(`  ⚪ No news found — skipping Supabase log for this slot`);
        await sleep(1500);
        continue;
      }

      rawNews.forEach(n => logger.info(`    📰 [${getArticleRecencyWeight(n.published_at).toFixed(2)}w] ${n.headline.substring(0, 70)}`));

      const analyzedNews = newsAnalyzer.analyzeNews(rawNews, stock.symbol);
      const { newsScore, totalRecencyWeight, scoredArticles } =
        scoreNewsWithRecency(rawNews, analyzedNews);

      logger.info(`  → News score: ${newsScore.toFixed(2)} | Recency weight: ${totalRecencyWeight.toFixed(2)} | Articles: ${analyzedNews.length}`);

      // ── Log to Supabase (permanent record, used by master at EOD) ───────────
      const { error: supaError } = await supabase
        .from('intraday_news_log')
        .upsert({
          date:           TODAY,
          symbol:         stock.symbol,
          run_slot:       runSlot,
          news_score:     newsScore,
          recency_weight: totalRecencyWeight,
          article_count:  analyzedNews.length,
          headlines:      scoredArticles,   // stored as JSONB for audit
        }, { onConflict: 'date,symbol,run_slot' });

      if (supaError) {
        logger.warn(`  Supabase log failed for ${stock.symbol}: ${supaError.message}`);
      } else {
        logger.info(`  ✓ Logged to Supabase (slot ${runSlot})`);
      }

      // ── Update Redis frontend cache ──────────────────────────────────────────
      // Recompute composite using frozen master scores + new news score
      if (redisClient && stock.score_breakdown) {
        const newTotal    = computeComposite(stock.score_breakdown, newsScore);
        const roundedTotal = Math.round(newTotal * 10) / 10;

        stock.score_breakdown.news = newsScore;
        stock.latest_score         = roundedTotal;
        stock.signal               = getSignal(roundedTotal);
        stock.recent_news          = rawNews.map(n => ({
          headline:     n.headline,
          url:          n.url,
          published_at: n.published_at,
        }));
        stock.news_last_updated = new Date().toISOString();

        logger.info(`  ✓ Redis: composite ${roundedTotal}/10 → ${stock.signal}`);
        updatedCount++;
      }

    } catch (e) {
      logger.error(`  Error processing ${stock.symbol}: ${e.message}`);
    }

    // NewsData.io rate limit: ~1 req/sec on free tier
    await sleep(1500);
  }

  // ── Flush Redis ─────────────────────────────────────────────────────────────
  if (redisClient) {
    try {
      portfolio.stocks      = stocks;
      portfolio.lastUpdated = new Date().toISOString();
      await redisClient.set('portfolio', JSON.stringify(portfolio));
      logger.info(`\n→ Redis flushed (${updatedCount} stocks updated)`);
      await redisClient.quit();
    } catch (e) {
      logger.warn('Redis flush failed (non-fatal)');
    }
  }

  logger.info('\n╔════════════════════════════════════════════════════════════╗');
  logger.info(`║  NEWS UPDATE COMPLETE — Slot ${runSlot} logged to Supabase          ║`);
  logger.info('╚════════════════════════════════════════════════════════════╝');
  process.exit(0);
}

updateNewsOnly().catch(err => {
  logger.error('FATAL:', err);
  process.exit(1);
});
