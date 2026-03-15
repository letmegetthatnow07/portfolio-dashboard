#!/usr/bin/env node

require('dotenv').config();
const axios = require('axios');
const logger = require('../lib/logger');
const { createClient } = require('redis');

let redisClient = null;

async function getRedisClient() {
  if (!redisClient) {
    redisClient = createClient({
      url: process.env.REDIS_URL
    });
    
    redisClient.on('error', (err) => logger.error('Redis error:', err));
    await redisClient.connect();
  }
  return redisClient;
}

class PortfolioStorage {
  async readData() {
    try {
      const client = await getRedisClient();
      const data = await client.get('portfolio');
      return data ? JSON.parse(data) : { stocks: [] };
    } catch (e) {
      logger.error(`Error reading from Redis: ${e.message}`);
      return { stocks: [] };
    }
  }

  async writeData(data) {
    try {
      const client = await getRedisClient();
      data.lastUpdated = new Date().toISOString();
      await client.set('portfolio', JSON.stringify(data));
      return true;
    } catch (e) {
      logger.error(`Error writing to Redis: ${e.message}`);
      return false;
    }
  }

  async updateStock(symbol, updates) {
    try {
      const data = await this.readData();
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

      await this.writeData(data);
      return true;
    } catch (e) {
      logger.error(`Error updating stock: ${e.message}`);
      return false;
    }
  }

  async getPortfolio() {
    return await this.readData();
  }
}

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

    if (priceData && priceData.changePercent) {
      const changeScore = 5 + (priceData.changePercent / 10);
      score += changeScore * 0.2;
    }

    if (ratings) {
      const total = (ratings.strongBuy || 0) + (ratings.buy || 0) + (ratings.hold || 0) + 
                    (ratings.sell || 0) + (ratings.strongSell || 0);
      if (total > 0) {
        const bullish = (ratings.strongBuy || 0) + (ratings.buy || 0);
        const ratingScore = ((bullish / total) * 10) - (((ratings.sell || 0) + (ratings.strongSell || 0)) / total) * 3;
        score += ratingScore * 0.25;
      }
    }

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

async function updateMarketData() {
  const startTime = Date.now();
  const storage = new PortfolioStorage();
  const analyzer = new PriceAnalyzer();

  try {
    logger.info('');
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║       DAILY MARKET DATA UPDATE - PRODUCTION VERSION        ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    logger.info(`📅 Date: ${new Date().toISOString()}`);
    logger.info('');

    const portfolio = await storage.getPortfolio();
    const stocks = portfolio.stocks || [];

    if (stocks.length === 0) {
      logger.info('ℹ️  Portfolio is empty');
      logger.info('ℹ️  Add stocks via website dashboard to start analysis');
      logger.info('');
      logger.info('✅ UPDATE COMPLETED (NO STOCKS TO ANALYZE)');
      
      const client = await getRedisClient();
      await client.quit();
      process.exit(0);
    }

    logger.info(`📊 Updating ${stocks.length} stocks from portfolio...`);
    logger.info('');

    logger.info('STEP 1: Fetching current prices...');
    let priceCount = 0;

    for (const stock of stocks) {
      try {
        const priceData = await analyzer.fetchPrice(stock.symbol);
        if (priceData) {
          await storage.updateStock(stock.symbol, {
            current_price: priceData.price,
            change_percent: priceData.changePercent,
