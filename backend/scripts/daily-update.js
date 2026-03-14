#!/usr/bin/env node

/**
 * Daily Market Data Update Script - COMPLETE VERSION
 * Runs every weekday at 10 PM UTC (5 PM ET)
 * Fetches, analyzes, calculates scores, stores data
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Import all modules
const logger = require('../lib/logger');
const dedupeCache = require('../lib/deduplicationCache');
const validator = require('../lib/validateAndNormalize');
const fetcher = require('../lib/fetchFinance');
const newsAnalyzer = require('../lib/advancedNewsAnalyzer');
const filingParser = require('../lib/parseQuarterlyFiling');
const form4Fetcher = require('../lib/fetchForm4');
const calculateCompositeScore = require('../lib/calculateCompositeScore');
const initDatabase = require('../lib/initDatabase');

// Portfolio stocks
const STOCKS = [
  'SPMO', 'SMH', 'TPL', 'VRT', 'MU', 'MELI', 'AVNV', 'BWXT',
  'GEV', 'FTAI', 'SHLD', 'SCCO', 'KTOS', 'RKLB', 'AGX', 'ASTS',
  'CRWD', 'LLY'
];

// ============================================
// MAIN UPDATE FUNCTION
// ============================================

async function updateMarketData() {
  const startTime = Date.now();
  
  try {
    logger.info('');
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║       DAILY MARKET DATA UPDATE - STARTED                   ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    logger.info(`📅 Date: ${new Date().toISOString()}`);
    logger.info(`📊 Stocks to update: ${STOCKS.length}`);
    logger.info('');

    // Initialize database
    logger.info('INITIALIZING DATABASE...');
    const db = initDatabase();
    logger.info('✓ Database ready\n');

    // ============================================
    // STEP 1: Fetch Prices & Technicals
    // ============================================
    logger.info('STEP 1/8: Fetching prices and technical indicators...');
    const priceData = await fetcher.fetchPricesAndTechnicals(STOCKS);
    if (priceData) {
      logger.info(`✓ Prices fetched for ${Object.keys(priceData).length} stocks\n`);
    } else {
      logger.info('⚠ No new prices (cached or failed)\n');
    }

    // ============================================
    // STEP 2: Fetch Analyst Ratings
    // ============================================
    logger.info('STEP 2/8: Fetching analyst ratings from Finnhub...');
    const ratingData = await fetcher.fetchAnalystRatings(STOCKS);
    if (ratingData) {
      logger.info(`✓ Ratings fetched for ${Object.keys(ratingData).length} stocks\n`);
    } else {
      logger.info('⚠ No new ratings (cached or failed)\n');
    }

    // ============================================
    // STEP 3: Fetch News
    // ============================================
    logger.info('STEP 3/8: Fetching news from newsdata.io...');
    const newsData = await fetcher.fetchNews(STOCKS);
    if (newsData) {
      let newsCount = 0;
      for (const symbol in newsData) {
        newsCount += newsData[symbol].length;
      }
      logger.info(`✓ Fetched ${newsCount} news articles\n`);
    } else {
      logger.info('⚠ No new news (cached or failed)\n');
    }

    // ============================================
    // STEP 4: Analyze News (8-Layer)
    // ============================================
    logger.info('STEP 4/8: Analyzing news with 8-layer understanding...');
    const analyzedNews = {};
    if (newsData) {
      for (const symbol in newsData) {
        analyzedNews[symbol] = newsAnalyzer.analyzeNews(newsData[symbol], symbol);
        logger.debug(`  - ${symbol}: Analyzed ${analyzedNews[symbol].length} articles`);
      }
      logger.info(`✓ News analysis complete\n`);
    } else {
      logger.info('⚠ No news to analyze\n');
    }

    // ============================================
    // STEP 5: Fetch Stock Grades & Price Targets
    // ============================================
    logger.info('STEP 5/8: Fetching stock grades from FMP...');
    const gradeData = await fetcher.fetchStockGrades(STOCKS);
    if (gradeData) {
      logger.info(`✓ Grades fetched for ${Object.keys(gradeData).length} stocks\n`);
    } else {
      logger.info('⚠ No new grades (cached or failed)\n');
    }

    // ============================================
    // STEP 6: Fetch Quarterly Filings
    // ============================================
    logger.info('STEP 6/8: Fetching quarterly filings from SEC-API.io...');
    const filingData = await fetcher.fetchQuarterlyFilings(STOCKS);
    if (filingData) {
      logger.info(`✓ Filings fetched for ${Object.keys(filingData).length} stocks\n`);
    } else {
      logger.info('⚠ No new filings (cached or failed)\n');
    }

    // ============================================
    // STEP 7: Parse Filings & Get Insider Data
    // ============================================
    logger.info('STEP 7/8: Parsing filings and fetching insider transactions...');
    const parsedFilings = {};
    const insiderData = {};
    
    for (const symbol of STOCKS) {
      if (filingData && filingData[symbol]) {
        parsedFilings[symbol] = await filingParser.parseFilings(symbol, filingData[symbol]);
      }
      insiderData[symbol] = await form4Fetcher.getLatestForm4Filings(symbol);
    }
    logger.info('✓ Filing and insider data processed\n');

    // ============================================
    // STEP 8: Calculate Composite Scores
    // ============================================
    logger.info('STEP 8/8: Calculating composite scores (0-10 scale)...');
    const scores = {};
    const today = new Date().toISOString().split('T')[0];

    for (const symbol of STOCKS) {
      const stockData = {
        symbol: symbol,
        ratings: ratingData && ratingData[symbol] ? ratingData[symbol] : null,
        grades: gradeData && gradeData[symbol] ? gradeData[symbol] : null,
        news: analyzedNews[symbol] ? analyzedNews[symbol] : [],
        technicals: priceData && priceData[symbol] ? priceData[symbol] : null,
        filing: parsedFilings[symbol] ? parsedFilings[symbol] : null,
        insider: insiderData[symbol] ? insiderData[symbol] : null,
        currentPrice: priceData && priceData[symbol]?.prices?.price || null,
        priceTarget: gradeData && gradeData[symbol]?.priceTarget || null
      };

      const score = calculateCompositeScore(stockData);
      if (score) {
        scores[symbol] = score;
        
        // Store in database
        try {
          db.prepare(`
            INSERT OR REPLACE INTO metric_scores (
              symbol, date, 
              analyst_rating_score, stock_grade_score, news_sentiment_score,
              technical_score, insider_score, filing_health_score,
              composite_score, composite_confidence, primary_signal,
              analyst_price_target, current_price, upside_downside_percent
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            symbol, today,
            score.components.analyst_rating || 0,
            score.components.stock_grade || 0,
            score.components.news_sentiment || 0,
            score.components.technical || 0,
            score.components.insider || 0,
            score.components.filing_health || 0,
            score.composite_score,
            score.confidence,
            score.signal,
            score.analyst_price_target,
            score.current_price,
            score.upside_downside
          );
        } catch (dbError) {
          logger.warn(`Failed to store score for ${symbol}: ${dbError.message}`);
        }

        logger.debug(`  ${symbol}: ${score.composite_score}/10 → ${score.signal}`);
      }
    }
    logger.info(`✓ Calculated scores for ${Object.keys(scores).length} stocks\n`);

    // ============================================
    // SUMMARY & STATISTICS
    // ============================================
    logger.info('');
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║                    PORTFOLIO SUMMARY                        ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');

    const signals = {
      STRONG_BUY: [],
      BUY: [],
      HOLD: [],
      REDUCE: [],
      SELL: [],
      STRONG_SELL: []
    };

    for (const symbol in scores) {
      const score = scores[symbol];
      if (signals[score.signal]) {
        signals[score.signal].push(symbol);
      }
    }

    logger.info('');
    logger.info('SIGNAL DISTRIBUTION:');
    logger.info(`  🚀 STRONG_BUY:  ${signals.STRONG_BUY.length} ${signals.STRONG_BUY.length > 0 ? '(' + signals.STRONG_BUY.join(', ') + ')' : ''}`);
    logger.info(`  ✅ BUY:         ${signals.BUY.length} ${signals.BUY.length > 0 ? '(' + signals.BUY.join(', ') + ')' : ''}`);
    logger.info(`  ⏸️  HOLD:        ${signals.HOLD.length} ${signals.HOLD.length > 0 ? '(' + signals.HOLD.join(', ') + ')' : ''}`);
    logger.info(`  ⚠️  REDUCE:      ${signals.REDUCE.length} ${signals.REDUCE.length > 0 ? '(' + signals.REDUCE.join(', ') + ')' : ''}`);
    logger.info(`  ❌ SELL:        ${signals.SELL.length} ${signals.SELL.length > 0 ? '(' + signals.SELL.join(', ') + ')' : ''}`);

    logger.info('');
    logger.info('TOP 5 STRONGEST BUYS:');
    const topBuys = Object.values(scores)
      .sort((a, b) => b.composite_score - a.composite_score)
      .slice(0, 5);
    
    topBuys.forEach((score, i) => {
      logger.info(`  ${i + 1}. ${score.symbol}: ${score.composite_score}/10 (${score.signal})`);
    });

    logger.info('');
    logger.info('TOP 5 WEAKEST PERFORMERS:');
    const topSells = Object.values(scores)
      .sort((a, b) => a.composite_score - b.composite_score)
      .slice(0, 5);
    
    topSells.forEach((score, i) => {
      logger.info(`  ${i + 1}. ${score.symbol}: ${score.composite_score}/10 (${score.signal})`);
    });

    // ============================================
    // CLEANUP
    // ============================================
    logger.info('');
    logger.info('CLEANUP:');
    dedupeCache.cleanup();
    const cacheStats = dedupeCache.getStats();
    logger.info(`  Cache cleaned (${cacheStats.totalCached} items remaining)`);

    // Close database
    db.close();
    logger.info('  Database closed');

    // ============================================
    // COMPLETION
    // ============================================
    const duration = (Date.now() - startTime) / 1000;
    logger.info('');
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║           ✅ DAILY UPDATE COMPLETED SUCCESSFULLY            ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    logger.info(`⏱️  Duration: ${duration.toFixed(2)} seconds`);
    logger.info(`🕐 Finished: ${new Date().toISOString()}`);
    logger.info('');

    process.exit(0);

  } catch (error) {
    logger.error('FATAL ERROR DURING UPDATE', error);
    logger.info('');
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║                  ❌ UPDATE FAILED                           ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    logger.error(error.message);
    logger.info('');
    process.exit(1);
  }
}

// Run update
updateMarketData();
