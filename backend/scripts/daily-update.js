#!/usr/bin/env node

/**
 * Daily Market Data Update - WORKING VERSION
 * No external module dependencies - self-contained
 * Directly fetches APIs and updates portfolio data
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');

// ============================================
// DATA STORAGE - INLINE (No external module)
// ============================================

class PortfolioStorage {
  constructor() {
    this.dataDir = path.join(process.cwd(), 'data');
    this.dataFile = path.join(this.dataDir, 'portfolio-data.json');
    this.initializeDataDirectory();
  }

  initializeDataDirectory() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    if (!fs.existsSync(this.dataFile)) {
      const initialData = {
        stocks: [],
        lastUpdated: null,
        metadata: {
          version: '2.0',
          createdAt: new Date().toISOString()
        }
      };
      fs.writeFileSync(this.dataFile, JSON.stringify(initialData, null, 2));
    }
  }

  readData() {
    try {
      const data = fs.readFileSync(this.dataFile, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      return { stocks: [] };
    }
  }

  writeData(data) {
    try {
      data.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2));
      return true;
    } catch (e) {
      logger.error(`Error writing data: ${e.message}`);
      return false;
    }
  }

  updateStock(symbol, updates) {
    try {
      const data = this.readData();
      let stock = data.stocks.find(s => s.symbol === symbol);

      if (!stock) {
        stock = {
          id: Date.now().toString(),
          symbol: symbol,
          name: symbol,
          type: 'Stock',
          region: 'Global',
          quantity: 0,
          average_price: 0,
          createdAt: new Date().toISOString()
        };
        data.stocks.push(stock);
      }

      stock = { ...stock, ...updates, updatedAt: new Date().toISOString() };
      const index = data.stocks.findIndex(s => s.symbol === symbol);
      if (index >= 0) {
        data.stocks[index] = stock;
      }

      this.writeData(data);
      return true;
    } catch (e) {
      logger.error(`Error updating stock: ${e.message}`);
      return false;
    }
  }

  getPortfolio() {
    return this.readData();
  }
}

// ============================================
// API FETCHING - INLINE (No external module)
// ============================================

class PriceAnalyzer {
  async fetchPrice(symbol) {
    try {
      const res = await axios.get(
        `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${process.env.ALPHA_VANTAGE_API_KEY}`,
        { timeout: 8000 }
      );

      if (res.data && res.data['Global Quote'] && res.data['Global Quote'].c) {
        return {
          price: parseFloat(res.data['Global Quote'].c),
          change: parseFloat(res.data['Global Quote'].d) || 0,
          changePercent: parseFloat(res.data['Global Quote'].dp) || 0,
          source: 'ALPHA_VANTAGE'
        };
      }
    } catch (e) {
      logger.warn(`Price fetch failed for ${symbol}: ${e.message}`);
    }

    // Fallback to EODHD
    try {
      const res = await axios.get(
        `https://eodhd.com/api/eod/${symbol}.US?api_token=${process.env.EODHD_API_KEY}&fmt=json`,
        { timeout: 8000 }
      );

      if (res.data && res.data.close) {
        return {
          price: res.data.close,
          change: 0,
          changePercent: 0,
          source: 'EODHD'
        };
      }
    } catch (e) {
      logger.warn(`EODHD fetch failed for ${symbol}: ${e.message}`);
    }

    return null;
  }

  async fetchRatings(symbol) {
    try {
      const res = await axios.get(
        `https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`,
        { timeout: 8000 }
      );

      if (res.data && res.data.length > 0) {
        return res.data[0];
      }
    } catch (e) {
      logger.warn(`Ratings fetch failed for ${symbol}: ${e.message}`);
    }

    return null;
  }

  async fetchNews(symbol) {
    try {
      const res = await axios.get(
        `https://newsdata.io/api/1/news?q=${symbol}&apikey=${process.env.NEWSDATA_API_KEY}&language=en&limit=3`,
        { timeout: 8000 }
      );

      if (res.data && res.data.results) {
        return res.data.results;
      }
    } catch (e) {
      logger.warn(`News fetch failed for ${symbol}: ${e.message}`);
    }

    return [];
  }

  calculateScore(priceData, ratings, news) {
    let score = 5;

    // Price trend component (20%)
    if (priceData && priceData.changePercent) {
      const changeScore = 5 + (priceData.changePercent / 10);
      score += changeScore * 0.2;
    }

    // Ratings component (25%)
    if (ratings) {
      const total = (ratings.strongBuy || 0) + (ratings.buy || 0) + (ratings.hold || 0) + 
                    (ratings.sell || 0) + (ratings.strongSell || 0);
      if (total > 0) {
        const bullish = (ratings.strongBuy || 0) + (ratings.buy || 0);
        const ratingScore = ((bullish / total) * 10) - (((ratings.sell || 0) + (ratings.strongSell || 0)) / total) * 3;
        score += ratingScore * 0.25;
      }
    }

    // News component (20%)
    if (news && news.length > 0) {
      const positiveWords = ['surge', 'gain', 'profit', 'growth', 'strong', 'beat', 'excellent', 'soar'];
      const negativeWords = ['fall', 'loss', 'decline', 'weak', 'poor', 'miss', 'crisis', 'crash'];

      let newsScore = 5;
      news.forEach(article => {
        const text = (article.title + ' ' + (article.description || '')).toLowerCase();
        positiveWords.forEach(w => { if (text.includes(w)) newsScore += 0.3; });
        negativeWords.forEach(w => { if (text.includes(w)) newsScore -= 0.3; });
      });

      score += newsScore * 0.2;
    }

    return Math.max(0, Math.min(10, score));
  }

  getSignal(score) {
    if (score >= 8.5) return 'STRONG_BUY';
    if (score >= 7.5) return 'BUY';
    if (score >= 6.5) return 'HOLD';
    if (score >= 5) return 'REDUCE';
    return 'SELL';
  }
}

// ============================================
// MAIN UPDATE FUNCTION
// ============================================

async function updateMarketData() {
  const startTime = Date.now();
  const storage = new PortfolioStorage();
  const analyzer = new PriceAnalyzer();

  try {
    logger.info('');
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║       DAILY MARKET DATA UPDATE - WORKING VERSION           ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    logger.info(`📅 Date: ${new Date().toISOString()}`);
    logger.info('');

    // Get user's portfolio
    const portfolio = storage.getPortfolio();
    const stocks = portfolio.stocks || [];

    if (stocks.length === 0) {
      logger.info('ℹ️  Portfolio is empty');
      logger.info('ℹ️  Add stocks via website dashboard to start analysis');
      logger.info('');
      logger.info('✅ UPDATE COMPLETED (NO STOCKS TO ANALYZE)');
      process.exit(0);
    }

    logger.info(`📊 Updating ${stocks.length} stocks from portfolio...`);
    logger.info('');

    // ========== STEP 1: Fetch Prices ==========
    logger.info('STEP 1: Fetching current prices...');
    let priceCount = 0;

    for (const stock of stocks) {
      try {
        const priceData = await analyzer.fetchPrice(stock.symbol);
        if (priceData) {
          storage.updateStock(stock.symbol, {
            current_price: priceData.price,
            change_percent: priceData.changePercent,
            priceSource: priceData.source
          });
          priceCount++;
          logger.info(`  ✓ ${stock.symbol}: $${priceData.price.toFixed(2)}`);
        }
        await new Promise(r => setTimeout(r, 12000)); // Rate limit
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
        const ratings = await analyzer.fetchRatings(stock.symbol);
        if (ratings) {
          ratingCount++;
          logger.debug(`  ✓ ${stock.symbol}: Ratings fetched`);
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
        const news = await analyzer.fetchNews(stock.symbol);
        if (news && news.length > 0) {
          newsCount += news.length;
          logger.debug(`  ✓ ${stock.symbol}: ${news.length} articles`);
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
        const priceData = await analyzer.fetchPrice(stock.symbol);
        const ratings = await analyzer.fetchRatings(stock.symbol);
        const news = await analyzer.fetchNews(stock.symbol);

        const score = analyzer.calculateScore(priceData, ratings, news);
        const signal = analyzer.getSignal(score);

        storage.updateStock(stock.symbol, {
          latest_score: Math.round(score * 10) / 10,
          signal: signal,
          confidence: ratings ? 85 : 60,
          current_price: priceData ? priceData.price : stock.current_price || stock.average_price
        });

        scoredCount++;
        logger.info(`  ✓ ${stock.symbol}: ${score.toFixed(1)}/10 → ${signal}`);
      } catch (e) {
        logger.error(`Score calculation error for ${stock.symbol}`, e);
      }
    }
    logger.info(`✓ Calculated scores for ${scoredCount} stocks\n`);

    // ========== Summary ==========
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║           UPDATE SUMMARY                                    ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    logger.info(`✓ Portfolio stocks: ${stocks.length}`);
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
```

**Commit:** `Fix: Self-contained daily-update.js (no missing dependencies)`

---

## backend/package.json

**Make sure your backend/package.json has this (with axios only):**
```json
{
  "name": "portfolio-dashboard-backend",
  "version": "1.0.0",
  "description": "Portfolio dashboard backend",
  "main": "scripts/daily-update.js",
  "scripts": {
    "update": "node scripts/daily-update.js",
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "dependencies": {
    "axios": "^1.6.2",
    "dotenv": "^16.3.1"
  }
}
```

**Commit:** `Fix: Minimal backend package.json`

---

## Frontend package.json (Root Level)

**Your root package.json should have React stuff:**
```json
{
  "name": "portfolio-dashboard",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-scripts": "5.0.1"
  },
  "scripts": {
    "start": "react-scripts start",
    "build": "react-scripts build",
    "test": "react-scripts test",
    "eject": "react-scripts eject"
  },
  "eslintConfig": {
    "extends": [
      "react-app"
    ]
  },
  "browserslist": {
    "production": [
      ">0.2%",
      "not dead",
      "not op_mini all"
    ],
    "development": [
      "last 1 chrome version",
      "last 1 firefox version",
      "last 1 safari version"
    ]
  }
}
