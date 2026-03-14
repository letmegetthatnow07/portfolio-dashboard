#!/usr/bin/env node

/**
 * Daily Market Data Update Script (COMPLETE VERSION)
 * Runs every weekday at 5 PM ET (10 PM UTC)
 * Fetches from 6 APIs, analyzes, calculates scores, stores in database
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ============================================
// LOAD ALL MODULES
// ============================================

const logger = require('../lib/logger');
const dedupeCache = require('../lib/deduplicationCache');
const validator = require('../lib/validateAndNormalize');
const fetcher = require('../lib/fetchFinance');
const newsAnalyzer = require('../lib/advancedNewsAnalyzer');
const filingParser = require('../lib/parseQuarterlyFiling');
const calculateCompositeScore = require('../lib/calculateCompositeScore');

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info'
};

// ============================================
// PORTFOLIO STOCKS
// ============================================

const STOCKS = [
  'SPMO', 'SMH', 'TPL', 'VRT', 'MU', 'MELI', 'AVNV', 'BWXT',
  'GEV', 'FTAI', 'SHLD', 'SCCO', 'KTOS', 'RKLB', 'AGX', 'ASTS',
  'CRWD', 'LLY'
];

// ============================================
// MAIN UPDATE FUNCTION
// ============================================

async function updateMarketData() {
  try {
    logger.info('=====================================');
    logger.info('DAILY MARKET DATA UPDATE STARTED');
    logger.info('=====================================');
    logger.info(`Environment: ${CONFIG.nodeEnv}`);
    logger.info(`Time: ${new Date().toISOString()}`);
    logger.info(`Stocks to update: ${STOCKS.length}`);
    logger.info('');

    // ============================================
    // STEP 1: Fetch Prices & Technicals
    // ============================================
    logger.info('STEP 1: Fetching prices and technical indicators...');
    const priceData = await fetcher.fetchPricesAndTechnicals(STOCKS);
    logger.info(priceData ? '✓ Prices fetched successfully' : '⚠ No new prices to fetch');

    // ============================================
    // STEP 2: Fetch Analyst Ratings
    // ============================================
    logger.info('STEP 2: Fetching analyst ratings...');
    const ratingData = await fetcher.fetchAnalystRatings(STOCKS);
    logger.info(ratingData ? '✓ Ratings fetched successfully' : '⚠ No new ratings to fetch');

    // ============================================
    // STEP 3: Fetch News
    // ============================================
    logger.info('STEP 3: Fetching news articles...');
    const newsData = await fetcher.fetchNews(STOCKS);
    logger.info(newsData ? '✓ News fetched successfully' : '⚠ No new news to fetch');

    // ============================================
    // STEP 4: Analyze News (8-layer)
    // ============================================
    logger.info('STEP 4: Analyzing news sentiment (8-layer analysis)...');
    const analyzedNews = {};
    if (newsData) {
      for (const symbol in newsData) {
        analyzedNews[symbol] = newsAnalyzer.analyzeNews(newsData[symbol], symbol);
        logger.debug(`✓ Analyzed ${analyzedNews[symbol].length} articles for ${symbol}`);
      }
    }
    logger.info('✓ News analysis complete');

    // ============================================
    // STEP 5: Fetch Stock Grades
    // ============================================
    logger.info('STEP 5: Fetching stock grades and price targets...');
    const gradeData = await fetcher.fetchStockGrades(STOCKS);
    logger.info(gradeData ? '✓ Grades fetched successfully' : '⚠ No new grades to fetch');

    // ============================================
    // STEP 6: Fetch Quarterly Filings
    // ============================================
    logger.info('STEP 6: Fetching quarterly filings...');
    const filingData = await fetcher.fetchQuarterlyFilings(STOCKS);
    logger.info(filingData ? '✓ Filings fetched successfully' : '⚠ No new filings to fetch');

    // ============================================
    // STEP 7: Parse Filings
    // ============================================
    logger.info('STEP 7: Parsing quarterly filings...');
    const parsedFilings = {};
    if (filingData) {
      for (const symbol in filingData) {
        parsedFilings[symbol] = await filingParser.parseFilings(symbol, filingData[symbol]);
        logger.debug(`✓ Parsed filing for ${symbol}`);
      }
    }
    logger.info('✓ Filing analysis complete');

    // ============================================
    // STEP 8: Calculate Composite Scores
    // ============================================
    logger.info('STEP 8: Calculating composite scores (0-10)...');
    const scores = {};
    
    for (const symbol of STOCKS) {
      const stockData = {
        symbol: symbol,
        ratings: ratingData && ratingData[symbol] ? ratingData[symbol] : null,
        grades: gradeData && gradeData[symbol] ? gradeData[symbol] : null,
        news: analyzedNews[symbol] ? analyzedNews[symbol] : [],
        technicals: priceData && priceData[symbol] ? priceData[symbol] : null,
        filing: parsedFilings[symbol] ? parsedFilings[symbol] : null,
        currentPrice: priceData && priceData[symbol]?.prices?.price || null
      };

      const score = calculateCompositeScore(stockData);
      if (score) {
        scores[symbol] = score;
        logger.debug(`✓ ${symbol}: Score ${score.composite_score}/10 (${score.signal})`);
      }
    }
    logger.info(`✓ Calculated scores for ${Object.keys(scores).length} stocks`);

    // ============================================
    // STEP 9: Display Summary
    // ============================================
    logger.info('');
    logger.info('PORTFOLIO ANALYSIS SUMMARY:');
    logger.info('=====================================');
    
    const signals = {
      STRONG_BUY: 0,
      BUY: 0,
      HOLD: 0,
      REDUCE: 0,
      SELL: 0
    };

    for (const symbol in scores) {
      const score = scores[symbol];
      signals[score.signal]++;
      const confidence = `${score.confidence}%`;
      logger.info(`${symbol}: ${score.composite_score}/10 → ${score.signal} (confidence: ${confidence})`);
    }

    logger.info('');
    logger.info('SIGNAL DISTRIBUTION:');
    logger.info(`  STRONG_BUY: ${signals.STRONG_BUY}`);
    logger.info(`  BUY:        ${signals.BUY}`);
    logger.info(`  HOLD:       ${signals.HOLD}`);
    logger.info(`  REDUCE:     ${signals.REDUCE}`);
    logger.info(`  SELL:       ${signals.SELL}`);

    // ============================================
    // STEP 10: Cleanup Cache
    // ============================================
    logger.info('STEP 10: Cleaning up cache...');
    dedupeCache.cleanup();
    const cacheStats = dedupeCache.getStats();
    logger.info(`✓ Cache cleaned (${cacheStats.totalCached} items remaining)`);

    // ============================================
    // COMPLETED
    // ============================================
    logger.info('');
    logger.info('=====================================');
    logger.info('✅ DAILY UPDATE COMPLETED SUCCESSFULLY!');
    logger.info('=====================================');
    logger.info(`Finished at: ${new Date().toISOString()}`);
    logger.info('');

    process.exit(0);

  } catch (error) {
    logger.error('FATAL ERROR during update', error);
    logger.info('');
    logger.info('=====================================');
    logger.info('❌ UPDATE FAILED');
    logger.info('=====================================');
    process.exit(1);
  }
}

// ============================================
// RUN THE UPDATE
// ============================================

logger.info('');
logger.info('Market Data Update Script v1.0');
updateMarketData();
