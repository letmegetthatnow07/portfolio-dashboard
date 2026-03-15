#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); 

const axios = require('axios');
const logger = require('../lib/logger');
const newsAnalyzer = require('../lib/advancedNewsAnalyzer'); 
const { createClient } = require('redis');

let redisClient = null;

async function getRedisClient() {
  if (!redisClient) {
    redisClient = createClient({ url: process.env.REDIS_URL });
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
          quantity: 0,
          average_price: 0,
          createdAt: new Date().toISOString()
        };
        data.stocks.push(stock);
      }

      stock = { ...stock, ...updates, updatedAt: new Date().toISOString() };
      const index = data.stocks.findIndex(s => s.symbol === symbol);
      if (index >= 0) data.stocks[index] = stock;

      await this.writeData(data);
      return true;
    } catch (e) {
      return false;
    }
  }

  async getPortfolio() {
    return await this.readData();
  }
}

class PriceAnalyzer {
  
  // 1. PRICE: Alpha Vantage (Primary)
  async fetchPrice(symbol) {
    try {
      const res = await axios.get(
        `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${process.env.ALPHA_VANTAGE_API_KEY}`,
        { timeout: 8000 }
      );
      if (res.data && res.data['Global Quote'] && res.data['Global Quote']['05. price']) {
        return {
          price: parseFloat(res.data['Global Quote']['05. price']),
          changePercent: parseFloat(res.data['Global Quote']['10. change percent'].replace('%','')) || 0,
        };
      }
    } catch (e) {
      logger.warn(`Price fetch failed for ${symbol}: ${e.message}`);
    }
    return null;
  }

  // 2. FUNDAMENTALS: FMP (The Crown Jewel)
  async fetchFundamentals(symbol) {
    try {
      const metricsRes = await axios.get(`https://financialmodelingprep.com/api/v3/key-metrics-ttm/${symbol}?apikey=${process.env.FMP_API_KEY}`, { timeout: 8000 });
      const ratiosRes = await axios.get(`https://financialmodelingprep.com/api/v3/financial-ratios-ttm/${symbol}?apikey=${process.env.FMP_API_KEY}`, { timeout: 8000 });

      const metrics = metricsRes.data && metricsRes.data.length > 0 ? metricsRes.data[0] : null;
      const ratios = ratiosRes.data && ratiosRes.data.length > 0 ? ratiosRes.data[0] : null;

      if (metrics || ratios) {
        return {
          roic: metrics ? (metrics.roicTTM || 0) : 0,
          fcfYield: metrics ? (metrics.freeCashFlowYieldTTM || 0) : 0,
          debtToEquity: ratios ? (ratios.debtEquityRatioTTM || 0) : 0
        };
      }
    } catch (e) {
      logger.warn(`Fundamentals fetch failed for ${symbol}: ${e.message}`);
    }
    return null; // Will return null for ETFs naturally
  }

  // 3. TECHNICALS: EODHD (Load Balancing AV)
  async fetchTechnicals(symbol) {
    try {
      const rsiRes = await axios.get(`https://eodhd.com/api/technical/${symbol}.US?function=rsi&period=14&order=d&fmt=json&api_token=${process.env.EODHD_API_KEY}`, { timeout: 8000 });
      const smaRes = await axios.get(`https://eodhd.com/api/technical/${symbol}.US?function=sma&period=200&order=d&fmt=json&api_token=${process.env.EODHD_API_KEY}`, { timeout: 8000 });

      let currentRsi = (rsiRes.data && rsiRes.data.length > 0) ? rsiRes.data[0].rsi : null;
      let currentSma = (smaRes.data && smaRes.data.length > 0) ? smaRes.data[0].sma : null;

      if (currentRsi !== null && currentSma !== null) {
        return { rsi: currentRsi, sma200: currentSma };
      }
    } catch (e) {
      logger.warn(`Technicals fetch failed for ${symbol}: ${e.message}`);
    }
    return null;
  }

  // 4. RATINGS: Finnhub
  async fetchRatings(symbol) {
    try {
      const res = await axios.get(`https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`, { timeout: 8000 });
      if (res.data && res.data.length > 0) return res.data[0];
    } catch (e) {
      logger.warn(`Ratings fetch failed for ${symbol}: ${e.message}`);
    }
    return null;
  }

  // 5. NEWS: NewsData.io
  async fetchNews(symbol) {
    try {
      const res = await axios.get(`https://newsdata.io/api/1/latest?apikey=${process.env.NEWSDATA_API_KEY}&q=${symbol} stock&language=en`, { timeout: 8000 });
      if (res.data && res.data.results && res.data.results.length > 0) {
        return res.data.results.slice(0, 3).map(article => ({
          headline: article.title || '',
          description: article.description || article.content || '',
          url: article.link || '',
          source: article.source_id || 'NewsData',
          published_at: article.pubDate || new Date().toISOString()
        }));
      }
    } catch (e) {
      logger.warn(`News fetch failed for ${symbol}: ${e.message}`);
    }
    return [];
  }
  
  calculateScore(priceData, fundamentals, technicals, ratings, analyzedNews) {
    let fundScore = 5;
    let techScore = 5;
    let ratingScore = 5;
    let newsScore = 5;

    // --- 1. FUNDAMENTALS (29% Weight) ---
    if (fundamentals) {
      // ROIC (>20% = 10, <5% = 0)
      let roicS = Math.max(0, Math.min(10, ((fundamentals.roic - 0.05) / 0.15) * 10));
      // FCF Yield (>5% = 10, <0% = 0)
      let fcfS = Math.max(0, Math.min(10, (fundamentals.fcfYield / 0.05) * 10));
      // Debt to Equity (0 = 10, >2.0 = 0)
      let deS = Math.max(0, Math.min(10, 10 - ((fundamentals.debtToEquity / 2.0) * 10)));
      
      if (fundamentals.debtToEquity < 0) deS = 10; // Cash rich
      
      fundScore = (roicS * 0.40) + (fcfS * 0.30) + (deS * 0.30);
    }

    // --- 2. TECHNICALS (16% Weight) ---
    if (technicals && priceData && priceData.price) {
      // Trend: Price vs 200 SMA
      let trendS = 5;
      if (technicals.sma200 > 0) {
        const diff = (priceData.price - technicals.sma200) / technicals.sma200;
        trendS = 5 + ((diff / 0.05) * 5); // +5% above SMA = 10, at SMA = 5
      }
      trendS = Math.max(0, Math.min(10, trendS));

      // Momentum: 14-Day RSI
      let rsiS = 5;
      const rsi = technicals.rsi;
      if (rsi >= 45 && rsi <= 65) rsiS = 10; // Goldilocks
      else if (rsi < 35) rsiS = 8; // Oversold Value
      else if (rsi >= 35 && rsi < 45) rsiS = 9; 
      else if (rsi > 65 && rsi <= 80) rsiS = 10 - (((rsi - 65) / 15) * 8); // Scales down as it gets overbought
      else if (rsi > 80) rsiS = 2; // Dangerously overextended

      techScore = (trendS * 0.50) + (rsiS * 0.50);
    }

    // --- 3. ANALYSTS (20% Weight) ---
    if (ratings) {
      const total = (ratings.strongBuy || 0) + (ratings.buy || 0) + (ratings.hold || 0) + (ratings.sell || 0) + (ratings.strongSell || 0);
      if (total > 0) {
        const bullish = (ratings.strongBuy || 0) + (ratings.buy || 0);
        const bearish = (ratings.sell || 0) + (ratings.strongSell || 0);
        ratingScore = ((bullish / total) * 10) - ((bearish / total) * 5);
        ratingScore = Math.max(0, Math.min(10, ratingScore));
      }
    }

    // --- 4. NEWS & NLP (15% Weight) ---
    if (analyzedNews && analyzedNews.length > 0) {
      const avgSentiment = analyzedNews.reduce((sum, item) => sum + item.sentiment.score, 0) / analyzedNews.length; 
      const avgImportance = analyzedNews.reduce((sum, item) => sum + item.importance, 0) / analyzedNews.length; 

      newsScore = 5 + (avgSentiment * 4);
      if (avgSentiment > 0) newsScore += (avgImportance / 10);
      else if (avgSentiment < 0) newsScore -= (avgImportance / 10);
      
      newsScore = Math.max(0, Math.min(10, newsScore));
    }

    // --- FINAL TRUE WEIGHTED AVERAGE ---
    // Total utilized weight is 80% (0.80) because 20% is reserved for Phase 2 SEC Insider tracking. 
    // We multiply by 1.25 to normalize the score accurately out of 10.
    
    const finalScore = (
      (fundScore * 0.29) +
      (techScore * 0.16) +
      (ratingScore * 0.20) +
      (newsScore * 0.15)
    ) * 1.25;

    return Math.max(0, Math.min(10, finalScore));
  }

  getSignal(score) {
    if (score >= 8.5) return 'STRONG_BUY';
    if (score >= 7.0) return 'BUY';
    if (score >= 5.5) return 'HOLD';
    if (score >= 4.0) return 'REDUCE';
    return 'SELL';
  }
}

async function updateMarketData() {
  const startTime = Date.now();
  const storage = new PortfolioStorage();
  const analyzer = new PriceAnalyzer();

  try {
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║        PHASE 1 MULTI-FACTOR MODEL (22% CAGR AUDIT)         ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    
    const portfolio = await storage.getPortfolio();
    const stocks = portfolio.stocks || [];

    if (stocks.length === 0) process.exit(0);

    for (const stock of stocks) {
      try {
        logger.info(`Analyzing ${stock.symbol}...`);
        
        // Parallel fetching to prevent timeouts and speed up GitHub Actions
        const [priceData, fundamentals, technicals, ratings, rawNews] = await Promise.all([
          analyzer.fetchPrice(stock.symbol),
          analyzer.fetchFundamentals(stock.symbol),
          analyzer.fetchTechnicals(stock.symbol),
          analyzer.fetchRatings(stock.symbol),
          analyzer.fetchNews(stock.symbol)
        ]);
        
        const analyzedNews = newsAnalyzer.analyzeNews(rawNews, stock.symbol);
        const score = analyzer.calculateScore(priceData, fundamentals, technicals, ratings, analyzedNews);
        const signal = analyzer.getSignal(score);

        const updates = {
          latest_score: Math.round(score * 10) / 10,
          signal: signal,
          current_price: priceData ? priceData.price : stock.current_price,
          change_percent: priceData ? priceData.changePercent : stock.change_percent,
        };

        if (updates.current_price && stock.quantity) {
          updates.total_value = updates.current_price * stock.quantity;
        }

        if (rawNews.length > 0) {
          updates.recent_news = rawNews.map(n => ({
            headline: n.headline, url: n.url, published_at: n.published_at
          }));
        }

        await storage.updateStock(stock.symbol, updates);
        logger.info(`✓ ${stock.symbol}: Score ${score.toFixed(1)}/10 → ${signal}`);
        
        // Polite 1-second delay so we don't trip concurrent rate limits
        await new Promise(r => setTimeout(r, 1000)); 
      } catch (e) {
        logger.error(`Error updating ${stock.symbol}`, e);
      }
    }

    logger.info(`✅ UPDATE COMPLETED: ${stocks.length} Assets Analyzed.`);
    const client = await getRedisClient();
    await client.quit();
    process.exit(0);

  } catch (error) {
    logger.error('FATAL ERROR', error);
    process.exit(1);
  }
}

updateMarketData();
