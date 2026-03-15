#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); 

const axios = require('axios');
const logger = require('../lib/logger');
// Require your new 8-layer analyzer
const newsAnalyzer = require('../lib/advancedNewsAnalyzer'); 
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

      if (res.data && res.data['Global Quote'] && res.data['Global Quote']['05. price']) {
        return {
          price: parseFloat(res.data['Global Quote']['05. price']),
          change: parseFloat(res.data['Global Quote']['09. change']) || 0,
          changePercent: parseFloat(res.data['Global Quote']['10. change percent']) || 0,
          source: 'ALPHA_VANTAGE'
        };
      }
    } catch (e) {
      logger.warn(`Alpha Vantage price fetch failed for ${symbol}: ${e.message}`);
    }
    return null;
  }

  async fetchRatings(symbol) {
    try {
      const res = await axios.get(
        `https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`,
        { timeout: 8000 }
      );
      if (res.data && res.data.length > 0) return res.data[0];
    } catch (e) {
      logger.warn(`Ratings fetch failed for ${symbol}: ${e.message}`);
    }
    return null;
  }

  async fetchNews(symbol) {
    try {
      const res = await axios.get(
        `https://newsdata.io/api/1/latest?apikey=${process.env.NEWSDATA_API_KEY}&q=${symbol} stock&language=en`,
        { timeout: 8000 }
      );

      if (res.data && res.data.results && res.data.results.length > 0) {
        // Map NewsData.io output to match exactly what your AdvancedNewsAnalyzer expects
        return res.data.results.slice(0, 3).map(article => ({
          headline: article.title || '',
          description: article.description || article.content || '',
          url: article.link || '',
          source: article.source_id || 'NewsData',
          published_at: article.pubDate || new Date().toISOString()
        }));
      }
    } catch (e) {
      logger.warn(`NewsData.io fetch failed for ${symbol}: ${e.message}`);
    }
    return [];
  }
  
  calculateScore(priceData, ratings, analyzedNews) {
    let score = 5;

    // 1. Price Trend
    if (priceData && priceData.changePercent) {
      const changeScore = 5 + (priceData.changePercent / 10);
      score += changeScore * 0.2;
    }

    // 2. Analyst Ratings
    if (ratings) {
      const total = (ratings.strongBuy || 0) + (ratings.buy || 0) + (ratings.hold || 0) + 
                    (ratings.sell || 0) + (ratings.strongSell || 0);
      if (total > 0) {
        const bullish = (ratings.strongBuy || 0) + (ratings.buy || 0);
        const ratingScore = ((bullish / total) * 10) - (((ratings.sell || 0) + (ratings.strongSell || 0)) / total) * 3;
        score += ratingScore * 0.25;
      }
    }

    // 3. Advanced News Sentiment (Integrating your 8-layer NLP)
    if (analyzedNews && analyzedNews.length > 0) {
      // Get the average NLP sentiment score (which is -1 to 1 in your analyzer)
      const totalSentiment = analyzedNews.reduce((sum, item) => sum + item.sentiment.score, 0);
      const avgSentiment = totalSentiment / analyzedNews.length;
      
      // Map the -1 to 1 sentiment scale to a 0 to 10 scale for the composite score
      const newsScore = (avgSentiment + 1) * 5; 
      
      // Boost score if Importance is high and age is recent
      const avgImportance = analyzedNews.reduce((sum, item) => sum + item.importance, 0) / analyzedNews.length;
      const importanceBoost = (avgImportance / 10) * 1.5; 

      score += (newsScore * 0.2) + importanceBoost;
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
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║        DAILY MARKET DATA UPDATE - PRODUCTION VERSION       ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    
    const portfolio = await storage.getPortfolio();
    const stocks = portfolio.stocks || [];

    if (stocks.length === 0) process.exit(0);

    let priceCount = 0, ratingCount = 0, newsCount = 0;

    for (const stock of stocks) {
      try {
        // Fetch raw data
        const priceData = await analyzer.fetchPrice(stock.symbol);
        const ratings = await analyzer.fetchRatings(stock.symbol);
        const rawNews = await analyzer.fetchNews(stock.symbol);
        
        // Pass raw news into your 8-layer analyzer
        const analyzedNews = newsAnalyzer.analyzeNews(rawNews, stock.symbol);
        
        // Calculate the score
        const score = analyzer.calculateScore(priceData, ratings, analyzedNews);
        const signal = analyzer.getSignal(score);

        // Prepare updates for Redis
        const updates = {
          latest_score: Math.round(score * 10) / 10,
          signal: signal,
          confidence: ratings ? 85 : 60,
          current_price: priceData ? priceData.price : stock.current_price,
          change_percent: priceData ? priceData.changePercent : stock.change_percent,
        };

        // Calculate Total Value based on frontend quantity
        if (updates.current_price && stock.quantity) {
          updates.total_value = updates.current_price * stock.quantity;
        } else {
          updates.total_value = 0; 
        }

        // Store the top 3 headlines and links so the frontend can display them
        if (rawNews.length > 0) {
          updates.recent_news = rawNews.map(n => ({
            headline: n.headline,
            url: n.url,
            published_at: n.published_at
          }));
          newsCount += rawNews.length;
        }

        await storage.updateStock(stock.symbol, updates);
        
        if (priceData) priceCount++;
        if (ratings) ratingCount++;
        
        logger.info(`✓ ${stock.symbol}: Score ${score.toFixed(1)}/10 → ${signal} | Value: $${(updates.total_value || 0).toFixed(2)}`);
        
        await new Promise(r => setTimeout(r, 1500)); // Rate limit protection
      } catch (e) {
        logger.error(`Error updating ${stock.symbol}`, e);
      }
    }

    logger.info(`✅ UPDATE COMPLETED: ${stocks.length} Stocks Analyzed.`);
    const client = await getRedisClient();
    await client.quit();
    process.exit(0);

  } catch (error) {
    logger.error('FATAL ERROR', error);
    process.exit(1);
  }
}

updateMarketData();
