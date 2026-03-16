#!/usr/bin/env node
'use strict';

/**
 * PORTFOLIO REGIME ANALYSIS ENGINE
 * 
 * Architecture:
 *   - Supabase  → permanent time-series history (daily_metrics, regime_flags, fundamentals)
 *   - Redis     → frontend cache (optional, graceful fallback if unavailable)
 *   - CSV       → local backup log
 * 
 * Array convention throughout: index 0 = OLDEST, index N-1 = MOST RECENT (today)
 * All history arrays are sorted oldest→newest before being passed to quantEngine.
 */

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const axios     = require('axios');
const logger    = require('../lib/logger');
const newsAnalyzer = require('../lib/advancedNewsAnalyzer');
const quantEngine  = require('../lib/quant-engine');

const { createClient: createRedisClient }    = require('redis');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const SLEEP_BETWEEN_STOCKS_MS = 15000; // respect API rate limits
const TODAY = new Date().toISOString().split('T')[0];

const VALID_SIGNALS = [
  'STRONG_BUY', 'BUY', 'HOLD', 'WATCH',
  'TRIM_25', 'SELL', 'SPRING_CANDIDATE', 'SPRING_CONFIRMED', 'ADD',
  'HOLD_NOISE', 'NORMAL', 'INSUFFICIENT_DATA'
];

// ─── CLIENTS ──────────────────────────────────────────────────────────────────

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

let redisClient = null;

/**
 * Returns a connected Redis client, or null if Redis is unavailable.
 * All callers must handle null gracefully — Redis is optional.
 */
async function getRedisClient() {
  if (redisClient) return redisClient;
  try {
    const client = createRedisClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => logger.warn('Redis error (non-fatal):', err.message));
    await client.connect();
    redisClient = client;
    return redisClient;
  } catch (e) {
    logger.warn('Redis unavailable — frontend cache disabled. Supabase is primary store.');
    return null;
  }
}

// ─── STORAGE (Redis + Supabase) ───────────────────────────────────────────────

class PortfolioStorage {

  async readData() {
    const client = await getRedisClient();
    if (!client) return { stocks: [] };
    try {
      const data = await client.get('portfolio');
      return data ? JSON.parse(data) : { stocks: [] };
    } catch (e) {
      logger.warn('Redis read failed, returning empty portfolio');
      return { stocks: [] };
    }
  }

  async writeData(data) {
    const client = await getRedisClient();
    if (!client) return false;
    try {
      data.lastUpdated = new Date().toISOString();
      await client.set('portfolio', JSON.stringify(data));
      return true;
    } catch (e) {
      logger.warn('Redis write failed (non-fatal)');
      return false;
    }
  }

  async updateStock(symbol, updates) {
    try {
      const data = await this.readData();
      let stock = data.stocks.find(s => s.symbol === symbol);

      if (!stock) {
        stock = {
          id: Date.now().toString(), symbol,
          name: symbol, quantity: 0, average_price: 0,
          createdAt: new Date().toISOString()
        };
        data.stocks.push(stock);
      }

      const idx = data.stocks.findIndex(s => s.symbol === symbol);
      data.stocks[idx] = { ...stock, ...updates, updatedAt: new Date().toISOString() };
      await this.writeData(data);
      return true;
    } catch (e) {
      logger.warn(`Redis updateStock failed for ${symbol} (non-fatal)`);
      return false;
    }
  }

  async getPortfolio() {
    return await this.readData();
  }
}

// ─── PRICE ANALYZER ───────────────────────────────────────────────────────────

class PriceAnalyzer {

  // ── fetchPrice: Finnhub → FMP fallback ──────────────────────────────────────
  async fetchPrice(symbol) {
    try {
      const res = await axios.get(
        `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`,
        { timeout: 8000 }
      );
      if (res.data?.c > 0) {
        return { price: res.data.c, changePercent: res.data.dp || 0 };
      }
    } catch (e) {
      logger.warn(`Finnhub price failed for ${symbol}, trying FMP...`);
    }

    try {
      const res = await axios.get(
        `https://financialmodelingprep.com/api/v3/quote/${symbol}?apikey=${process.env.FMP_API_KEY}`,
        { timeout: 8000 }
      );
      if (res.data?.length > 0) {
        return { price: res.data[0].price, changePercent: res.data[0].changesPercentage || 0 };
      }
    } catch (e) {
      logger.error(`All price fetches failed for ${symbol}`);
    }
    return null;
  }

  // ── fetchFundamentals: Finnhub metrics ──────────────────────────────────────
  async fetchFundamentals(symbol) {
    try {
      const res = await axios.get(
        `https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${process.env.FINNHUB_API_KEY}`,
        { timeout: 8000 }
      );
      if (res.data?.metric) {
        const m = res.data.metric;
        return {
          roic:          (m.roicTTM   || m.roiAnnual              || 0) / 100,
          fcfMargin:     (m.freeCashFlowMarginTTM || m.operatingMarginTTM || 0) / 100,
          debtToEquity:  m['longTermDebt/equityAnnual'] || m['totalDebt/totalEquityAnnual'] || 0
        };
      }
    } catch (e) { /* fall through */ }
    return null;
  }

  // ── fetchTechnicals: Polygon (one call, returns everything) ─────────────────
  //
  // Returns:
  //   rsi            → 14-day RSI scalar (for score calculation)
  //   sma200         → 200-day SMA (for trend score)
  //   currentVolume  → today's volume
  //   historyDesc    → [{c, v, rsi}, ...] newest→oldest  (for Spring 3-day check)
  //   historyAsc     → [{c, v, rsi}, ...] oldest→newest  (for beta & quant engine)
  //   spyPrice       → only populated when symbol === 'SPY'
  //
  // RSI is computed per-day using Wilder's smoothing method so that
  // historyAsc[i].rsi is the actual RSI on that calendar day.
  // The Spring signal checks day.rsi independently for each of the 3 days.
  //
  async fetchTechnicals(symbol) {
    try {
      const end   = new Date();
      const start = new Date();
      start.setFullYear(start.getFullYear() - 1);

      const res = await axios.get(
        `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day` +
        `/${start.toISOString().split('T')[0]}/${end.toISOString().split('T')[0]}` +
        `?adjusted=true&sort=asc&limit=300&apiKey=${process.env.POLYGON_API_KEY}`,
        { timeout: 8000 }
      );

      if (!res.data?.results?.length) return null;

      // ── Sort ascending (oldest→newest). Polygon returns asc with sort=asc,
      //    but we enforce it here to be defensive.
      const historyAscRaw = [...res.data.results].sort((a, b) => a.t - b.t);

      // ── SMA-200 (use last 200 closes in ascending array)
      const period200 = Math.min(200, historyAscRaw.length);
      const sma200    = historyAscRaw
        .slice(-period200)
        .reduce((acc, d) => acc + d.c, 0) / period200;

      // ── Rolling 14-day RSI using Wilder's smoothing
      //    Requires at least 15 data points.
      const rsiSeries = this._computeRollingRSI(historyAscRaw, 14);

      // ── Attach per-day RSI to each bar
      const historyAsc = historyAscRaw.map((d, i) => ({
        c:   d.c,
        v:   d.v,
        t:   d.t,
        rsi: rsiSeries[i] ?? 50   // 50 is neutral default before RSI has enough data
      }));

      const historyDesc    = [...historyAsc].reverse();
      const todayRsi       = historyAsc[historyAsc.length - 1].rsi;
      const currentVolume  = historyDesc[0].v;

      return { rsi: todayRsi, sma200, currentVolume, historyAsc, historyDesc };

    } catch (e) {
      logger.warn(`fetchTechnicals failed for ${symbol}: ${e.message}`);
      return null;
    }
  }

  /**
   * Wilder's smoothed RSI for a full price series.
   * Returns an array of the same length as priceData.
   * Values before index 14 are null (insufficient data).
   * 
   * @param {Array<{c: number}>} priceData - oldest→newest
   * @param {number} period - default 14
   * @returns {Array<number|null>}
   */
  _computeRollingRSI(priceData, period = 14) {
    const rsi = new Array(priceData.length).fill(null);
    if (priceData.length < period + 1) return rsi;

    // Seed: simple average of first `period` gains and losses
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const diff = priceData[i].c - priceData[i - 1].c;
      if (diff > 0) avgGain += diff;
      else          avgLoss += Math.abs(diff);
    }
    avgGain /= period;
    avgLoss /= period;

    const calcRsi = (g, l) => l === 0 ? 100 : 100 - (100 / (1 + g / l));
    rsi[period] = calcRsi(avgGain, avgLoss);

    // Wilder's smoothing for the rest of the series
    for (let i = period + 1; i < priceData.length; i++) {
      const diff = priceData[i].c - priceData[i - 1].c;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      rsi[i] = calcRsi(avgGain, avgLoss);
    }

    return rsi;
  }

  // ── fetchRatings: analyst consensus ─────────────────────────────────────────
  async fetchRatings(symbol) {
    try {
      const res = await axios.get(
        `https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`,
        { timeout: 8000 }
      );
      if (res.data?.length > 0) return res.data[0];
    } catch (e) { /* fall through */ }
    return null;
  }

  // ── fetchNews ────────────────────────────────────────────────────────────────
  async fetchNews(symbol) {
    try {
      const res = await axios.get(
        `https://newsdata.io/api/1/latest?apikey=${process.env.NEWSDATA_API_KEY}&q=${symbol} stock&language=en`,
        { timeout: 8000 }
      );
      if (res.data?.results?.length > 0) {
        return res.data.results.slice(0, 3).map(a => ({
          headline:     a.title       || '',
          description:  a.description || a.content || '',
          url:          a.link        || '',
          source:       a.source_id   || 'NewsData',
          published_at: a.pubDate     || new Date().toISOString()
        }));
      }
    } catch (e) { /* fall through */ }
    return [];
  }

  // ── fetchInsider: sec-api.io → Finnhub MSPR fallback ────────────────────────
  async fetchInsider(symbol) {
    // Primary: sec-api.io
    try {
      const payload = {
        query: `issuer.tradingSymbol:${symbol}`,
        from: '0', size: '50',
        sort: [{ transactionDate: 'desc' }]
      };
      const res = await axios.post(
        `https://api.sec-api.io/insider-trading?token=${process.env.SEC_API_KEY}`,
        payload, { timeout: 8000 }
      );
      const trades = res.data.transactions || (Array.isArray(res.data) ? res.data : []);

      if (trades.length > 0) {
        let totalBought = 0, totalSold = 0;
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        trades.forEach(trade => {
          const tradeDate = new Date(trade.transactionDate || trade.filingDate);
          const shares    = parseFloat(trade.shares || trade.securitiesTransacted || 0);
          const price     = parseFloat(trade.pricePerShare || trade.price || 0);
          const code      = trade.transactionCode || trade.code;

          if (tradeDate >= sixMonthsAgo && shares > 0 && price > 0) {
            const value = shares * price;
            if (code === 'P' || code === 'P - Purchase') totalBought += value;
            if (code === 'S' || code === 'S - Sale')     totalSold   += value;
          }
        });
        return { bought: totalBought, sold: totalSold };
      }
    } catch (e) { /* try fallback */ }

    // Fallback: Finnhub MSPR (Monthly Share Purchase Ratio)
    try {
      const startStr = new Date(new Date().setMonth(new Date().getMonth() - 6))
        .toISOString().split('T')[0];
      const endStr = new Date().toISOString().split('T')[0];

      const res = await axios.get(
        `https://finnhub.io/api/v1/stock/insider-sentiment?symbol=${symbol}&from=${startStr}&to=${endStr}&token=${process.env.FINNHUB_API_KEY}`,
        { timeout: 8000 }
      );
      if (res.data?.data?.length > 0) {
        const avgMspr = res.data.data.reduce((sum, m) => sum + m.mspr, 0) / res.data.data.length;
        if (avgMspr > 0) return { bought: avgMspr * 1_000_000, sold: 0 };
        if (avgMspr < 0) return { bought: 0, sold: Math.abs(avgMspr) * 1_000_000 };
      }
    } catch (e) { /* fall through */ }

    return null;
  }

  // ── calculateScore ───────────────────────────────────────────────────────────
  //
  // capexException (boolean): if true, FCF score gets a +3 boost to prevent
  // a false sell signal caused by strategic investment cycles.
  //
  calculateScore(priceData, fundamentals, technicals, ratings, analyzedNews, insiderData, capexException = false) {
    let fundScore = 5, techScore = 5, ratingScore = 5, newsScore = 5, insiderScore = 5;

    // ── Fundamental score (ROIC + FCF Margin + Debt/Equity)
    if (fundamentals) {
      let roicS = Math.max(0, Math.min(10, ((fundamentals.roic - 0.05) / 0.15) * 10));
      let fcfS  = Math.max(0, Math.min(10, (fundamentals.fcfMargin / 0.05) * 10));
      let deS   = fundamentals.debtToEquity < 0
        ? 10  // net cash position → perfect score
        : Math.max(0, Math.min(10, 10 - ((fundamentals.debtToEquity / 2.0) * 10)));

      // Capex Exception: forgive FCF penalty for strategic investment
      if (capexException) fcfS = Math.min(10, fcfS + 3.0);

      fundScore = (roicS * 0.40) + (fcfS * 0.30) + (deS * 0.30);
    }

    // ── Technical score (SMA-200 trend + RSI zone)
    if (technicals && priceData?.price) {
      let trendS = 5;
      if (technicals.sma200 > 0) {
        const diff = (priceData.price - technicals.sma200) / technicals.sma200;
        trendS = Math.max(0, Math.min(10, 5 + ((diff / 0.05) * 5)));
      }

      const rsi = technicals.rsi;
      let rsiS = 5;
      if      (rsi >= 45 && rsi <= 65) rsiS = 10;
      else if (rsi < 35)               rsiS = 8;   // oversold = opportunity for long-term
      else if (rsi >= 35 && rsi < 45)  rsiS = 9;
      else if (rsi > 65 && rsi <= 80)  rsiS = 10 - (((rsi - 65) / 15) * 8);
      else if (rsi > 80)               rsiS = 2;

      techScore = (trendS * 0.50) + (rsiS * 0.50);
    }

    // ── Analyst rating score
    if (ratings) {
      const total = (ratings.strongBuy || 0) + (ratings.buy || 0) + (ratings.hold || 0)
                  + (ratings.sell || 0) + (ratings.strongSell || 0);
      if (total > 0) {
        const bullish = (ratings.strongBuy || 0) + (ratings.buy || 0);
        const bearish = (ratings.sell || 0) + (ratings.strongSell || 0);
        ratingScore = Math.max(0, Math.min(10, ((bullish / total) * 10) - ((bearish / total) * 5)));
      }
    }

    // ── News sentiment score
    if (analyzedNews?.length > 0) {
      const avgSentiment  = analyzedNews.reduce((s, i) => s + i.sentiment.score, 0) / analyzedNews.length;
      const avgImportance = analyzedNews.reduce((s, i) => s + i.importance,      0) / analyzedNews.length;
      newsScore = 5 + (avgSentiment * 4);
      newsScore += avgSentiment > 0 ? (avgImportance / 10) : -(avgImportance / 10);
      newsScore = Math.max(0, Math.min(10, newsScore));
    }

    // ── Insider activity score
    if (insiderData) {
      const { bought, sold } = insiderData;
      if      (bought > 0 && sold === 0)  insiderScore = 10;
      else if (bought > sold * 2)         insiderScore = 9;
      else if (bought > sold)             insiderScore = 7;
      else if (sold > bought * 5)         insiderScore = 2;
      else if (sold > bought * 2)         insiderScore = 3;
      else if (sold > bought)             insiderScore = 4;
    }

    // ── Weighted composite (sums to 1.00)
    const finalScore = (fundScore   * 0.29)
                     + (techScore   * 0.16)
                     + (ratingScore * 0.20)
                     + (newsScore   * 0.15)
                     + (insiderScore * 0.20);

    return {
      total:    Math.max(0, Math.min(10, finalScore)),
      fund:     fundScore,
      tech:     techScore,
      rating:   ratingScore,
      news:     newsScore,
      insider:  insiderScore
    };
  }

  // ── getSignal: score → BUY/HOLD/SELL label (used by old frontend, kept for compatibility)
  getSignal(score) {
    if (score >= 8.5) return 'STRONG_BUY';
    if (score >= 7.0) return 'BUY';
    if (score >= 5.5) return 'HOLD';
    if (score >= 4.0) return 'REDUCE';
    return 'SELL';
  }
}

// ─── SUPABASE WRITERS ─────────────────────────────────────────────────────────

/**
 * Write one row to daily_metrics (immutable history).
 * Uses upsert on (symbol, date) so re-runs don't duplicate.
 */
async function writeSupabaseDailyMetrics(symbol, scoreObj, priceData, technicals, spyPrice, regimeStatus) {
  // Sanitise signal: if regimeStatus is not in the allowed list, fall back to HOLD
  const safeSignal = VALID_SIGNALS.includes(regimeStatus) ? regimeStatus : 'HOLD';

  const { error } = await supabase.from('daily_metrics').upsert({
    date:           TODAY,
    symbol,
    price:          priceData?.price         ?? 0,
    spy_price:      spyPrice                 ?? 0,
    volume:         technicals?.currentVolume ?? 0,
    total_score:    scoreObj.total,
    fund_score:     scoreObj.fund,
    tech_score:     scoreObj.tech,
    analyst_score:  scoreObj.rating,
    news_score:     scoreObj.news,
    insider_score:  scoreObj.insider,
    signal:         safeSignal
  }, { onConflict: 'symbol,date' });

  if (error) logger.error(`Supabase daily_metrics write failed for ${symbol}:`, error.message);
}

/**
 * Write one row to regime_flags (time-series, one per symbol per day).
 * Uses upsert on (symbol, date) — safe to re-run.
 */
async function writeSupabaseRegimeFlags({
  symbol, w1, w2, w3, w4,
  beta, excessReturn, regimeStatus, action,
  springDays, capexException, qualityScore, rsi
}) {
  const { error } = await supabase.from('regime_flags').upsert({
    date:               TODAY,
    symbol,
    w1_signal:          w1             ?? false,
    w2_confirmed:       w2             ?? false,
    w3_confirmed:       w3             ?? false,
    w4_confirmed:       w4             ?? false,
    beta_63d:           beta           ?? 1.0,
    excess_return_pct:  excessReturn   ?? 0,
    regime_status:      regimeStatus   ?? 'MARKET_NOISE',
    action:             action         ?? 'HOLD',
    spring_days:        springDays     ?? 0,
    capex_exception:    capexException ?? false,
    quality_score:      qualityScore   ?? null,
    rsi_14:             rsi            ?? null,
    last_updated:       new Date().toISOString()
  }, { onConflict: 'symbol,date' });

  if (error) logger.error(`Supabase regime_flags write failed for ${symbol}:`, error.message);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function ensureCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(
      csvPath,
      'Date,Symbol,Final_Score,Regime,Action,Price,SpyPrice,Fundamentals,Technicals,Analysts,News,Insiders,Beta,ExcessReturn,W1,W2,W3,W4,SpringDays,CapexException\n'
    );
  }
}

function appendCsvRow(csvPath, symbol, scoreObj, priceData, spyPrice, regimeStatus, action, beta, excessReturn, w1, w2, w3, w4, springDays, capexException) {
  const line = [
    TODAY, symbol,
    scoreObj.total.toFixed(2), regimeStatus, action,
    priceData?.price ?? 0, spyPrice ?? 0,
    scoreObj.fund.toFixed(2), scoreObj.tech.toFixed(2),
    scoreObj.rating.toFixed(2), scoreObj.news.toFixed(2), scoreObj.insider.toFixed(2),
    (beta ?? 1).toFixed(4), (excessReturn ?? 0).toFixed(4),
    w1 ? 1 : 0, w2 ? 1 : 0, w3 ? 1 : 0, w4 ? 1 : 0,
    springDays ?? 0, capexException ? 1 : 0
  ].join(',') + '\n';
  fs.appendFileSync(csvPath, line);
}

/**
 * Compute 21-day window return for a history array (oldest→newest).
 * Returns percentage: e.g. 5.2 means +5.2%
 */
function compute21dReturn(historyAsc) {
  if (!historyAsc || historyAsc.length < 22) return 0;
  const recent = historyAsc[historyAsc.length - 1].c;
  const prior  = historyAsc[historyAsc.length - 22].c;
  return ((recent - prior) / prior) * 100;
}

/**
 * Get previous spring_days from regime_flags for 3-day persistence tracking.
 * Returns 0 if yesterday wasn't a spring candidate/confirmed day.
 */
async function getPreviousSpringDays(symbol) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yDate = yesterday.toISOString().split('T')[0];

  const { data } = await supabase
    .from('regime_flags')
    .select('spring_days, action')
    .eq('symbol', symbol)
    .lte('date', yDate)
    .order('date', { ascending: false })
    .limit(1);

  if (!data?.length) return 0;
  const prev = data[0];
  const wasSpring = ['SPRING_CANDIDATE', 'SPRING_CONFIRMED'].includes(prev.action);
  return wasSpring ? (prev.spring_days ?? 0) : 0;
}

// ─── MAIN PIPELINE ────────────────────────────────────────────────────────────

async function updateMarketData() {
  const storage  = new PortfolioStorage();
  const analyzer = new PriceAnalyzer();

  const dataDir = path.resolve(__dirname, '../data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const csvPath = path.join(dataDir, 'score_history.csv');
  ensureCsv(csvPath);

  try {
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║     PORTFOLIO REGIME ANALYSIS ENGINE — Daily Run           ║');
    logger.info(`║     Date: ${TODAY}                                   ║`);
    logger.info('╚════════════════════════════════════════════════════════════╝');

    const portfolio = await storage.getPortfolio();
    const stocks    = portfolio.stocks || [];
    if (stocks.length === 0) {
      logger.warn('No stocks in portfolio. Add stocks first.');
      process.exit(0);
    }

    // ── Fetch SPY once: used for beta & excess return for all stocks ──────────
    logger.info('\n→ Fetching SPY benchmark data...');
    const spyTechnicals = await analyzer.fetchTechnicals('SPY');

    if (!spyTechnicals) {
      logger.error('SPY data fetch failed. Cannot compute beta or regime. Aborting.');
      process.exit(1);
    }

    // 21-day return for SPY (matches our regime window)
    const spyReturn21d = compute21dReturn(spyTechnicals.historyAsc);
    const spyPrice     = spyTechnicals.historyDesc[0].c;

    logger.info(`  SPY 21d return: ${spyReturn21d.toFixed(2)}% | Price: $${spyPrice}`);

    // ── Total portfolio value for position weight calculation ─────────────────
    const totalPortfolioValue = stocks.reduce(
      (sum, s) => sum + ((s.current_price || 0) * (s.quantity || 0)), 0
    );

    // ── Per-stock loop ─────────────────────────────────────────────────────────
    for (const stock of stocks) {
      try {
        logger.info(`\n${'─'.repeat(60)}`);
        logger.info(`Analyzing: ${stock.symbol}`);

        // Parallel fetch — all data sources at once
        const [
          priceData, fundamentals, technicals,
          ratings, rawNews, insiderData, secCapex
        ] = await Promise.all([
          analyzer.fetchPrice(stock.symbol),
          analyzer.fetchFundamentals(stock.symbol),
          analyzer.fetchTechnicals(stock.symbol),
          analyzer.fetchRatings(stock.symbol),
          analyzer.fetchNews(stock.symbol),
          analyzer.fetchInsider(stock.symbol),
          quantEngine.fetchSECCashFlow(stock.symbol)
        ]);

        // ── Capex exception from SEC data
        const capexException = secCapex?.capexException ?? false;
        if (capexException) {
          logger.info(`  ⚠️  CAPEX EXCEPTION: Strategic investment detected. FCF penalty forgiven.`);
        }

        // ── Score calculation (pass capexException so FCF gets boosted)
        const analyzedNews = newsAnalyzer.analyzeNews(rawNews, stock.symbol);
        const scoreObj     = analyzer.calculateScore(
          priceData, fundamentals, technicals,
          ratings, analyzedNews, insiderData, capexException
        );

        logger.info(`  📊 Scores: Fund(${scoreObj.fund.toFixed(1)}) | Tech(${scoreObj.tech.toFixed(1)}) | Analyst(${scoreObj.rating.toFixed(1)}) | News(${scoreObj.news.toFixed(1)}) | Insider(${scoreObj.insider.toFixed(1)}) | Total(${scoreObj.total.toFixed(1)})`);

        // ── Quant Engine regime analysis ──────────────────────────────────────
        let beta           = 1.0;
        let excessReturn   = 0;
        let noiseDecay     = 'INSUFFICIENT_DATA';
        let regimeStatus   = 'HOLD';
        let action         = 'HOLD';
        let springSignal   = false;
        let springDays     = 0;
        let addSignal      = false;
        let w1 = false, w2 = false, w3 = false, w4 = false;

        if (technicals && spyTechnicals) {

          // 1. Beta (63-day rolling, oldest→newest arrays)
          beta = quantEngine.calculateBeta(
            technicals.historyAsc,
            spyTechnicals.historyAsc
          );

          // 2. Excess return over 21-day window (matches W2 confirmation window)
          const stockReturn21d = compute21dReturn(technicals.historyAsc);
          excessReturn = quantEngine.calculateExcessReturn(
            stockReturn21d, beta, spyReturn21d
          );

          // 3. Regime classification
          noiseDecay = quantEngine.classifyRegime(excessReturn);

          // 4. Load 252-day fundamental history from Supabase
          //    Array comes back DESC from Supabase → reverse to oldest→newest
          const { data: supData, error: supError } = await supabase
            .from('daily_metrics')
            .select('fund_score, date')
            .eq('symbol', stock.symbol)
            .order('date', { ascending: false })
            .limit(252);

          if (supError) logger.warn(`Supabase history fetch failed for ${stock.symbol}: ${supError.message}`);

          // Reverse so index 0 = oldest (required by quant engine convention)
          const history252d = (supData || []).reverse();

          // 5. W1→W4 fractal decay cascade
          //    evaluateFractalDecay returns 'SELL'|'TRIM_25'|'WATCH'|'HOLD'|'HOLD_NOISE'
          regimeStatus = quantEngine.evaluateFractalDecay(history252d, noiseDecay);

          // Extract individual window flags for Supabase storage
          // (quant engine computes them internally; we re-derive for logging)
          w1 = history252d.length >= 7  ? quantEngine._w1Trigger(history252d.slice(-7))  : false;
          w2 = history252d.length >= 21 ? quantEngine._w2Trigger(history252d.slice(-21)) : false;
          w3 = history252d.length >= 63 ? quantEngine._w3Trigger(history252d.slice(-63)) : false;
          w4 = history252d.length >= 252 ? quantEngine._w4Trigger(history252d)            : false;

          // 6. Spring signal (requires per-day RSI in history — now fixed)
          const history20d        = technicals.historyAsc.slice(-20);
          const prevSpringDays    = await getPreviousSpringDays(stock.symbol);
          const excessReturn7d    = compute21dReturn(technicals.historyAsc.slice(-8)); // 7-day version

          springSignal = quantEngine.evaluateSpring(history20d, scoreObj.fund, excessReturn7d);

          if (springSignal) {
            springDays = prevSpringDays + 1;
            action     = springDays >= 3 ? 'SPRING_CONFIRMED' : 'SPRING_CANDIDATE';
          } else {
            springDays = 0; // reset — spring must be consecutive
            action     = regimeStatus; // cascade verdict is the action
          }

          // 7. ADD signal (quality trending up + outperforming + not overbought)
          const currentWeight = totalPortfolioValue > 0
            ? ((priceData?.price ?? 0) * (stock.quantity ?? 0)) / totalPortfolioValue
            : 0;

          addSignal = quantEngine.evaluateAdd(
            history252d.slice(-63),
            excessReturn,
            technicals.rsi,
            currentWeight
          );

          // ADD overrides HOLD if all conditions met (but NOT if cascade says TRIM/SELL)
          if (addSignal && !['TRIM_25', 'SELL'].includes(action)) {
            action = 'ADD';
          }
        }

        logger.info(`  🧠 Regime: ${noiseDecay} | Action: ${action} | Beta: ${beta.toFixed(2)} | Excess21d: ${excessReturn.toFixed(2)}%`);
        logger.info(`  📈 Cascade: W1=${w1} W2=${w2} W3=${w3} W4=${w4} | Spring: ${springDays} days`);

        // ── Write to Supabase (permanent record) ─────────────────────────────
        await writeSupabaseDailyMetrics(
          stock.symbol, scoreObj, priceData,
          technicals, spyPrice, action
        );

        await writeSupabaseRegimeFlags({
          symbol:         stock.symbol,
          w1, w2, w3, w4,
          beta,
          excessReturn,
          regimeStatus:   noiseDecay,   // the noise/decay classification
          action,                        // the actionable signal
          springDays,
          capexException,
          qualityScore:   scoreObj.fund,
          rsi:            technicals?.rsi ?? null
        });

        // ── Update Redis frontend cache (optional, non-fatal if unavailable) ──
        const redisUpdates = {
          latest_score:   Math.round(scoreObj.total * 10) / 10,
          signal:         action,         // frontend shows regime-aware action
          classic_signal: analyzer.getSignal(scoreObj.total), // backward compat
          current_price:  priceData?.price        ?? stock.current_price,
          change_percent: priceData?.changePercent ?? stock.change_percent,
          score_breakdown: scoreObj,
          regime:          noiseDecay,
          excess_return:   excessReturn,
          spring_days:     springDays,
          w2_confirmed:    w2,
          w3_confirmed:    w3,
          capex_exception: capexException,
          ...(rawNews.length > 0 && {
            recent_news: rawNews.map(n => ({
              headline: n.headline, url: n.url, published_at: n.published_at
            }))
          }),
          ...(priceData?.price && stock.quantity && {
            total_value: priceData.price * stock.quantity
          })
        };
        await storage.updateStock(stock.symbol, redisUpdates);

        // ── Append to CSV backup ──────────────────────────────────────────────
        appendCsvRow(
          csvPath, stock.symbol, scoreObj, priceData, spyPrice,
          noiseDecay, action, beta, excessReturn,
          w1, w2, w3, w4, springDays, capexException
        );

        logger.info(`  ✅ ${stock.symbol} complete → Action: ${action}`);

      } catch (e) {
        logger.error(`Error processing ${stock.symbol}:`, e.message);
        // Continue with next stock — don't abort entire run for one failure
      }

      // Rate limit: Finnhub free tier = 60 req/min; Polygon free = 5 req/min
      await sleep(SLEEP_BETWEEN_STOCKS_MS);
    }

    logger.info('\n╔════════════════════════════════════════════════════════════╗');
    logger.info('║           REGIME AUDIT COMPLETED SUCCESSFULLY              ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');

    // Clean up Redis connection
    const client = await getRedisClient();
    if (client) await client.quit();

    process.exit(0);

  } catch (error) {
    logger.error('FATAL ERROR in updateMarketData:', error);
    const client = await getRedisClient();
    if (client) await client.quit().catch(() => {});
    process.exit(1);
  }
}

updateMarketData();

This is the code.  What do you think? Also, will this work with Polygon API and not hit ratelimit? Just answer the questions I asked  and not anything else.
