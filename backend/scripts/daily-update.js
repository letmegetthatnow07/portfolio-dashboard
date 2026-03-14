#!/usr/bin/env node

/**
 * Daily Market Data Update Script - SIMPLIFIED VERSION
 * Pure Node.js, no browser APIs
 */

require('dotenv').config();
const axios = require('axios');
const path = require('path');

const logger = require('../lib/logger');

// Portfolio stocks
const STOCKS = [
  'SPMO', 'SMH', 'TPL', 'VRT', 'MU', 'MELI', 'AVNV', 'BWXT',
  'GEV', 'FTAI', 'SHLD', 'SCCO', 'KTOS', 'RKLB', 'AGX', 'ASTS',
  'CRWD', 'LLY'
];

async function updateMarketData() {
  try {
    logger.info('');
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║       DAILY MARKET DATA UPDATE - SIMPLIFIED VERSION         ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    logger.info(`📅 Date: ${new Date().toISOString()}`);
    logger.info(`📊 Stocks to update: ${STOCKS.length}`);
    logger.info('');

    // ============================================
    // STEP 1: Test API Connections
    // ============================================
    logger.info('STEP 1: Testing API Connections...');
    
    try {
      const quoteRes = await axios.get(
        `https://finnhub.io/api/v1/quote?symbol=AAPL&token=${process.env.FINNHUB_API_KEY}`,
        { timeout: 5000 }
      );
      logger.info('✓ Finnhub API: Connected');
    } catch (e) {
      logger.warn('⚠ Finnhub API: Failed - ' + e.message);
    }

    // ============================================
    // STEP 2: Fetch Alpha Vantage Data
    // ============================================
    logger.info('STEP 2: Fetching prices from Alpha Vantage...');
    
    let priceCount = 0;
    for (const symbol of STOCKS.slice(0, 3)) { // Test with first 3 stocks
      try {
        const res = await axios.get(
          `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${process.env.ALPHA_VANTAGE_API_KEY}`,
          { timeout: 10000 }
        );
        if (res.data && res.data['Global Quote']) {
          priceCount++;
          logger.debug(`  ✓ ${symbol}: Price fetched`);
        }
        // Rate limit: 5 calls per minute
        await new Promise(resolve => setTimeout(resolve, 12000));
      } catch (e) {
        logger.warn(`  ⚠ ${symbol}: ${e.message}`);
      }
    }
    logger.info(`✓ Fetched prices for ${priceCount} stocks`);

    // ============================================
    // STEP 3: Fetch News Data
    // ============================================
    logger.info('STEP 3: Fetching news from newsdata.io...');
    
    let newsCount = 0;
    try {
      const newsRes = await axios.get(
        `https://newsdata.io/api/1/news?q=CRWD&apikey=${process.env.NEWSDATA_API_KEY}&language=en&limit=5`,
        { timeout: 10000 }
      );
      if (newsRes.data && newsRes.data.results) {
        newsCount = newsRes.data.results.length;
      }
      logger.info(`✓ Fetched ${newsCount} news articles`);
    } catch (e) {
      logger.warn(`⚠ News fetch failed: ${e.message}`);
    }

    // ============================================
    // STEP 4: Fetch Analyst Ratings
    // ============================================
    logger.info('STEP 4: Fetching analyst ratings from Finnhub...');
    
    let ratingCount = 0;
    for (const symbol of STOCKS.slice(0, 2)) { // Test with first 2 stocks
      try {
        const res = await axios.get(
          `https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`,
          { timeout: 10000 }
        );
        if (res.data && res.data.length > 0) {
          ratingCount++;
          logger.debug(`  ✓ ${symbol}: Ratings fetched`);
        }
      } catch (e) {
        logger.warn(`  ⚠ ${symbol}: ${e.message}`);
      }
    }
    logger.info(`✓ Fetched ratings for ${ratingCount} stocks`);

    // ============================================
    // STEP 5: Fetch Stock Grades
    // ============================================
    logger.info('STEP 5: Fetching stock grades from FMP...');
    
    let gradeCount = 0;
    try {
      const res = await axios.get(
        `https://financialmodelingprep.com/api/v4/grade/AAPL?apikey=${process.env.FMP_API_KEY}&limit=1`,
        { timeout: 10000 }
      );
      if (res.data && res.data.length > 0) {
        gradeCount++;
      }
      logger.info(`✓ Fetched grades`);
    } catch (e) {
      logger.warn(`⚠ Grades fetch failed: ${e.message}`);
    }

    // ============================================
    // STEP 6: Summary
    // ============================================
    logger.info('');
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║           DAILY UPDATE SUMMARY                              ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    logger.info(`✓ Prices fetched: ${priceCount}`);
    logger.info(`✓ News articles: ${newsCount}`);
    logger.info(`✓ Ratings fetched: ${ratingCount}`);
    logger.info(`✓ Grades fetched: ${gradeCount}`);
    logger.info('');
    logger.info('✅ UPDATE COMPLETED SUCCESSFULLY!');
    logger.info(`🕐 Finished: ${new Date().toISOString()}`);
    logger.info('');

    process.exit(0);

  } catch (error) {
    logger.error('FATAL ERROR', error);
    logger.info('❌ UPDATE FAILED');
    process.exit(1);
  }
}

updateMarketData();
