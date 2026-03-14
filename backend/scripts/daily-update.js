#!/usr/bin/env node

/**
 * Daily Market Data Update - CLEAN VERSION
 * - Updates ONLY user-added stocks
 * - Uses historical data as reference, NOT as filler
 * - Real API analysis
 * - NO dummy data injected
 */

require('dotenv').config();
const logger = require('../lib/logger');
const dataStorage = require('../lib/dataStorage');
const apiClient = require('../lib/apiClient');
const compositeScorer = require('../lib/compositeScorer');

async function updateMarketData() {
  const startTime = Date.now();

  try {
    logger.info('');
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║       DAILY MARKET DATA UPDATE - PRODUCTION VERSION        ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    logger.info(`📅 Date: ${new Date().toISOString()}`);
    logger.info('');

    // Get user's portfolio (only user-added stocks)
    const portfolioData = dataStorage.readData();
    const stocks = portfolioData.stocks || [];

    if (stocks.length === 0) {
      logger.info('ℹ️  Portfolio is empty');
      logger.info('ℹ️  Add stocks via dashboard to start analysis');
      logger.info('ℹ️  Historical data is available for reference');
      logger.info('');
      logger.info('✅ UPDATE COMPLETED (NO STOCKS TO ANALYZE)');
      process.exit(0);
    }

    logger.info(`📊 Updating ${stocks.length} stocks from your portfolio...`);
    logger.info('');

    // ========== STEP 1: Fetch Prices ==========
    logger.info('STEP 1: Fetching current prices...');
    let priceCount = 0;

    for (const stock of stocks) {
      try {
        const priceData = await apiClient.fetchPrice(stock.symbol);
        if (priceData) {
          stock.priceData = priceData;
          stock.current_price = priceData.price;
          stock.change_percent = priceData.changePercent;
          priceCount++;
          logger.debug(`  ✓ ${stock.symbol}: $${priceData.price}`);
        }
      } catch (e) {
        logger.warn(`  ⚠ ${stock.symbol}: ${e.message}`);
      }
    }
    logger.info(`✓ Fetched prices for ${priceCount}/${stocks.length} stocks\n`);

    // ========== STEP 2: Fetch Ratings ==========
    logger.info('STEP 2: Fetching analyst ratings...');
    let ratingCount = 0;

    for (const stock of stocks) {
      try {
        const ratings = await apiClient.fetchRatings(stock.symbol);
        if (ratings) {
          stock.ratings = ratings;
          ratingCount++;
        }
      } catch (e) {
        logger.warn(`  ⚠ ${stock.symbol}: ${e.message}`);
      }
    }
    logger.info(`✓ Fetched ratings for ${ratingCount} stocks\n`);

    // ========== STEP 3: Fetch News ==========
    logger.info('STEP 3: Fetching news...');
    let newsCount = 0;

    for (const stock of stocks) {
      try {
        const news = await apiClient.fetchNews(stock.symbol);
        if (news && news.length > 0) {
          stock.news = news;
          newsCount += news.length;
        }
      } catch (e) {
        logger.warn(`  ⚠ ${stock.symbol}: ${e.message}`);
      }
    }
    logger.info(`✓ Fetched ${newsCount} news articles\n`);

    // ========== STEP 4: Calculate Scores ==========
    logger.info('STEP 4: Calculating composite scores...');
    let scoredCount = 0;

    for (const stock of stocks) {
      try {
        const scoreResult = compositeScorer.calculateScore(stock);
        
        if (scoreResult) {
          const result = dataStorage.updateStock(stock.id, {
            latest_score: scoreResult.score,
            signal: scoreResult.signal,
            confidence: scoreResult.confidence,
            current_price: stock.current_price || stock.average_price,
            change_percent: stock.change_percent || 0
          });

          if (result.success) {
            scoredCount++;
            logger.debug(`  ✓ ${stock.symbol}: ${scoreResult.score.toFixed(1)}/10 → ${scoreResult.signal}`);
          }
        }
      } catch (e) {
        logger.error(`Score calculation error for ${stock.symbol}`, e);
      }
    }
    logger.info(`✓ Calculated scores for ${scoredCount} stocks\n`);

    // ========== Summary ==========
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║           UPDATE SUMMARY                                    ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    logger.info(`✓ Portfolio stocks analyzed: ${stocks.length}`);
    logger.info(`✓ Prices updated: ${priceCount}`);
    logger.info(`✓ Ratings fetched: ${ratingCount}`);
    logger.info(`✓ News articles: ${newsCount}`);
    logger.info(`✓ Scores calculated: ${scoredCount}`);
    logger.info('');

    const duration = (Date.now() - startTime) / 1000;
    logger.info(`✅ UPDATE COMPLETED SUCCESSFULLY!`);
    logger.info(`⏱️  Duration: ${duration.toFixed(2)}s`);
    logger.info(`🕐 Finished: ${new Date().toISOString()}`);
    logger.info('');

    process.exit(0);

  } catch (error) {
    logger.error('FATAL ERROR', error);
    process.exit(1);
  }
}

updateMarketData();
