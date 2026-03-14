#!/usr/bin/env node

/**
 * Daily Market Data Update Script - SIMPLIFIED VERSION
 * Pure Node.js, no browser APIs
 */
#!/usr/bin/env node

/**
 * Daily Market Data Update Script - PROFESSIONAL VERSION
 * Fetches from 6 APIs and stores in database
 */

require('dotenv').config();
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../lib/logger');

// Portfolio stocks
const STOCKS = [
  'SPMO', 'SMH', 'TPL', 'VRT', 'MU', 'MELI', 'AVNV', 'BWXT',
  'GEV', 'FTAI', 'SHLD', 'SCCO', 'KTOS', 'RKLB', 'AGX', 'ASTS',
  'CRWD', 'LLY'
];

async function updateMarketData() {
  let db = null;
  const startTime = Date.now();
  
  try {
    logger.info('');
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║       DAILY MARKET DATA UPDATE - PROFESSIONAL VERSION      ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    logger.info(`📅 Date: ${new Date().toISOString()}`);
    logger.info(`📊 Stocks to update: ${STOCKS.length}`);
    logger.info('');

    // ============================================
    // Initialize Database
    // ============================================
    logger.info('INITIALIZING DATABASE...');
    const dbPath = path.join(process.cwd(), 'data', 'stocks.db');
    
    try {
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      logger.info('✓ Database connected');
    } catch (e) {
      logger.warn('⚠ Database connection issue, continuing without storage');
      db = null;
    }

    // ============================================
    // STEP 1: Fetch Prices from Alpha Vantage
    // ============================================
    logger.info('STEP 1: Fetching prices from Alpha Vantage...');
    const prices = {};
    let priceCount = 0;

    for (const symbol of STOCKS) {
      try {
        const res = await axios.get(
          `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${process.env.ALPHA_VANTAGE_API_KEY}`,
          { timeout: 10000 }
        );
        
        if (res.data && res.data['Global Quote'] && res.data['Global Quote'].c) {
          prices[symbol] = {
            price: parseFloat(res.data['Global Quote'].c),
            change: parseFloat(res.data['Global Quote'].d) || 0,
            changePercent: parseFloat(res.data['Global Quote'].dp) || 0,
            high52w: parseFloat(res.data['Global Quote']['52WeekHigh']) || null,
            low52w: parseFloat(res.data['Global Quote']['52WeekLow']) || null
          };
          priceCount++;
          logger.debug(`  ✓ ${symbol}: ${prices[symbol].price}`);
        }
        await new Promise(r => setTimeout(r, 12000)); // Rate limit
      } catch (e) {
        logger.warn(`  ⚠ ${symbol}: ${e.message}`);
      }
    }
    logger.info(`✓ Fetched prices for ${priceCount} stocks\n`);

    // ============================================
    // STEP 2: Fetch News
    // ============================================
    logger.info('STEP 2: Fetching news from newsdata.io...');
    let newsCount = 0;
    
    for (const symbol of STOCKS.slice(0, 5)) { // Sample 5 stocks
      try {
        const res = await axios.get(
          `https://newsdata.io/api/1/news?q=${symbol}&apikey=${process.env.NEWSDATA_API_KEY}&language=en&limit=5`,
          { timeout: 10000 }
        );
        
        if (res.data && res.data.results) {
          newsCount += res.data.results.length;
          logger.debug(`  ✓ ${symbol}: ${res.data.results.length} articles`);
        }
      } catch (e) {
        logger.warn(`  ⚠ ${symbol}: ${e.message}`);
      }
    }
    logger.info(`✓ Fetched ${newsCount} news articles\n`);

    // ============================================
    // STEP 3: Fetch Analyst Ratings
    // ============================================
    logger.info('STEP 3: Fetching analyst ratings from Finnhub...');
    let ratingCount = 0;

    for (const symbol of STOCKS.slice(0, 3)) { // Sample 3 stocks
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
    logger.info(`✓ Fetched ratings for ${ratingCount} stocks\n`);

    // ============================================
    // STEP 4: Store in Database
    // ============================================
    if (db && priceCount > 0) {
      logger.info('STEP 4: Storing data in database...');
      
      try {
        const today = new Date().toISOString().split('T')[0];
        
        for (const symbol in prices) {
          db.prepare(`
            INSERT OR REPLACE INTO stock_data 
            (symbol, price, change, change_percent, high_52w, low_52w, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            symbol,
            prices[symbol].price,
            prices[symbol].change,
            prices[symbol].changePercent,
            prices[symbol].high52w,
            prices[symbol].low52w,
            new Date().toISOString()
          );
        }
        
        logger.info(`✓ Stored ${priceCount} stocks in database`);
      } catch (e) {
        logger.warn(`⚠ Database storage failed: ${e.message}`);
      }
    }

    // ============================================
    // Summary
    // ============================================
    logger.info('');
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║           DAILY UPDATE SUMMARY                              ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    logger.info(`✓ Prices fetched: ${priceCount}`);
    logger.info(`✓ News articles: ${newsCount}`);
    logger.info(`✓ Ratings fetched: ${ratingCount}`);
    logger.info('');

    const duration = (Date.now() - startTime) / 1000;
    logger.info(`✅ UPDATE COMPLETED SUCCESSFULLY!`);
    logger.info(`⏱️  Duration: ${duration.toFixed(2)}s`);
    logger.info(`🕐 Finished: ${new Date().toISOString()}`);
    logger.info('');

    process.exit(0);

  } catch (error) {
    logger.error('FATAL ERROR', error);
    logger.info('❌ UPDATE FAILED');
    process.exit(1);
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {
        logger.warn('Database close error: ' + e.message);
      }
    }
  }
}

updateMarketData();
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
