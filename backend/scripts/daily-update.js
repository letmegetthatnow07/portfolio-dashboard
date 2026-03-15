#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); 

const axios = require('axios');
const logger = require('../lib/logger');
const newsAnalyzer = require('../lib/advancedNewsAnalyzer'); 
const { createClient } = require('redis');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
    } catch (e) { return { stocks: [] }; }
  }

  async writeData(data) {
    try {
      const client = await getRedisClient();
      data.lastUpdated = new Date().toISOString();
      await client.set('portfolio', JSON.stringify(data));
      return true;
    } catch (e) { return false; }
  }

  async updateStock(symbol, updates) {
    try {
      const data = await this.readData();
      let stock = data.stocks.find(s => s.symbol === symbol);

      if (!stock) {
        stock = { id: Date.now().toString(), symbol, name: symbol, quantity: 0, average_price: 0, createdAt: new Date().toISOString() };
        data.stocks.push(stock);
      }

      stock = { ...stock, ...updates, updatedAt: new Date().toISOString() };
      const index = data.stocks.findIndex(s => s.symbol === symbol);
      if (index >= 0) data.stocks[index] = stock;

      await this.writeData(data);
      return true;
    } catch (e) { return false; }
  }

  async getPortfolio() {
    return await this.readData();
  }
}

class PriceAnalyzer {
  
  async fetchPrice(symbol) {
    try {
      const res = await axios.get(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`, { timeout: 8000 });
      if (res.data && res.data.c && res.data.c > 0) return { price: res.data.c, changePercent: res.data.dp || 0 };
    } catch (e) { logger.warn(`Finnhub price failed for ${symbol}. Trying FMP backup...`); }

    try {
      const res = await axios.get(`https://financialmodelingprep.com/api/v3/quote/${symbol}?apikey=${process.env.FMP_API_KEY}`, { timeout: 8000 });
      if (res.data && res.data.length > 0) return { price: res.data[0].price, changePercent: res.data[0].changesPercentage || 0 };
    } catch (e) { logger.error(`All price fetches failed for ${symbol}`); }
    return null;
  }

  async fetchFundamentals(symbol) {
    try {
      const res = await axios.get(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${process.env.FINNHUB_API_KEY}`, { timeout: 8000 });
      if (res.data && res.data.metric) {
        const m = res.data.metric;
        return {
          roic: (m.roicTTM || m.roiAnnual || 0) / 100, 
          fcfMargin: (m.freeCashFlowMarginTTM || m.operatingMarginTTM || 0) / 100,
          debtToEquity: m['longTermDebt/equityAnnual'] || m['totalDebt/totalEquityAnnual'] || 0
        };
      }
    } catch (e) {}
    return null;
  }

  async fetchTechnicals(symbol) {
    try {
      const end = new Date();
      const start = new Date();
      start.setFullYear(start.getFullYear() - 1);
      
      const endStr = end.toISOString().split('T')[0];
      const startStr = start.toISOString().split('T')[0];

      const res = await axios.get(`https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${startStr}/${endStr}?adjusted=true&sort=desc&limit=250&apiKey=${process.env.POLYGON_API_KEY}`, { timeout: 8000 });
      
      if (res.data && res.data.results && res.data.results.length > 0) {
        const history = res.data.results; 
        const period = Math.min(200, history.length);
        const sum200 = history.slice(0, period).reduce((acc, val) => acc + val.c, 0);
        const sma200 = sum200 / period;

        let rsi = 50;
        if (history.length >= 15) {
          let gains = 0, losses = 0;
          for (let i = 14; i > 0; i--) {
            let diff = history[i-1].c - history[i].c; 
            if (diff > 0) gains += diff;
            else losses -= diff;
          }
          let avgGain = gains / 14;
          let avgLoss = losses / 14;
          if (avgLoss === 0) rsi = 100;
          else rsi = 100 - (100 / (1 + (avgGain / avgLoss)));
        }
        return { rsi, sma200 };
      }
    } catch (e) {}
    return null;
  }

  async fetchRatings(symbol) {
    try {
      const res = await axios.get(`https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`, { timeout: 8000 });
      if (res.data && res.data.length > 0) return res.data[0];
    } catch (e) {}
    return null;
  }

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
    } catch (e) {}
    return [];
  }

  async fetchInsider(symbol) {
    try {
      const payload = { query: `issuer.tradingSymbol:${symbol}`, from: "0", size: "50", sort: [{ "transactionDate": "desc" }] };
      const res = await axios.post(`https://api.sec-api.io/insider-trading?token=${process.env.SEC_API_KEY}`, payload, { timeout: 8000 });
      const trades = res.data.transactions || (Array.isArray(res.data) ? res.data : []);

      if (trades && trades.length > 0) {
        let totalBought = 0; let totalSold = 0;
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        trades.forEach(trade => {
          const tradeDate = new Date(trade.transactionDate || trade.filingDate);
          const shares = parseFloat(trade.shares || trade.securitiesTransacted || 0);
          const price = parseFloat(trade.pricePerShare || trade.price || 0);
          const code = trade.transactionCode || trade.code;

          if (tradeDate >= sixMonthsAgo && shares > 0 && price > 0) {
            const value = shares * price;
            if (code === 'P' || code === 'P - Purchase') totalBought += value;
            if (code === 'S' || code === 'S - Sale') totalSold += value;
          }
        });
        return { bought: totalBought, sold: totalSold };
      }
    } catch (e) {}

    try {
      const startStr = new Date(new Date().setMonth(new Date().getMonth() - 6)).toISOString().split('T')[0];
      const endStr = new Date().toISOString().split('T')[0];
      const res = await axios.get(`https://finnhub.io/api/v1/stock/insider-sentiment?symbol=${symbol}&from=${startStr}&to=${endStr}&token=${process.env.FINNHUB_API_KEY}`, { timeout: 8000 });
      if (res.data && res.data.data && res.data.data.length > 0) {
        let mspbr = 0; 
        res.data.data.forEach(month => { mspbr += month.mspr; });
        const avgMspr = mspbr / res.data.data.length;
        if (avgMspr > 0) return { bought: avgMspr * 1000000, sold: 0 };
        if (avgMspr < 0) return { bought: 0, sold: Math.abs(avgMspr) * 1000000 };
      }
    } catch (e) {}
    
    return null;
  }
  
  calculateScore(priceData, fundamentals, technicals, ratings, analyzedNews, insiderData) {
    let fundScore = 5; let techScore = 5; let ratingScore = 5; let newsScore = 5; let insiderScore = 5;

    if (fundamentals) {
      let roicS = Math.max(0, Math.min(10, ((fundamentals.roic - 0.05) / 0.15) * 10));
      let fcfS = Math.max(0, Math.min(10, (fundamentals.fcfMargin / 0.05) * 10));
      let deS = Math.max(0, Math.min(10, 10 - ((fundamentals.debtToEquity / 2.0) * 10)));
      if (fundamentals.debtToEquity < 0) deS = 10; 
      fundScore = (roicS * 0.40) + (fcfS * 0.30) + (deS * 0.30);
    }

    if (technicals && priceData && priceData.price) {
      let trendS = 5;
      if (technicals.sma200 > 0) {
        const diff = (priceData.price - technicals.sma200) / technicals.sma200;
        trendS = 5 + ((diff / 0.05) * 5); 
      }
      trendS = Math.max(0, Math.min(10, trendS));
      let rsiS = 5;
      const rsi = technicals.rsi;
      if (rsi >= 45 && rsi <= 65) rsiS = 10; 
      else if (rsi < 35) rsiS = 8; 
      else if (rsi >= 35 && rsi < 45) rsiS = 9; 
      else if (rsi > 65 && rsi <= 80) rsiS = 10 - (((rsi - 65) / 15) * 8); 
      else if (rsi > 80) rsiS = 2; 
      techScore = (trendS * 0.50) + (rsiS * 0.50);
    }

    if (ratings) {
      const total = (ratings.strongBuy || 0) + (ratings.buy || 0) + (ratings.hold || 0) + (ratings.sell || 0) + (ratings.strongSell || 0);
      if (total > 0) {
        const bullish = (ratings.strongBuy || 0) + (ratings.buy || 0);
        const bearish = (ratings.sell || 0) + (ratings.strongSell || 0);
        ratingScore = Math.max(0, Math.min(10, ((bullish / total) * 10) - ((bearish / total) * 5)));
      }
    }

    if (analyzedNews && analyzedNews.length > 0) {
      const avgSentiment = analyzedNews.reduce((sum, item) => sum + item.sentiment.score, 0) / analyzedNews.length; 
      const avgImportance = analyzedNews.reduce((sum, item) => sum + item.importance, 0) / analyzedNews.length; 
      newsScore = 5 + (avgSentiment * 4);
      if (avgSentiment > 0) newsScore += (avgImportance / 10);
      else if (avgSentiment < 0) newsScore -= (avgImportance / 10);
      newsScore = Math.max(0, Math.min(10, newsScore));
    }

    if (insiderData) {
      const { bought, sold } = insiderData;
      if (bought > 0 && sold === 0) insiderScore = 10; 
      else if (bought > sold * 2) insiderScore = 9; 
      else if (bought > sold) insiderScore = 7; 
      else if (sold > bought * 5) insiderScore = 2; 
      else if (sold > bought * 2) insiderScore = 3; 
      else if (sold > bought) insiderScore = 4; 
    }

    const finalScore = (fundScore * 0.29) + (techScore * 0.16) + (ratingScore * 0.20) + (newsScore * 0.15) + (insiderScore * 0.20);
    const boundedTotal = Math.max(0, Math.min(10, finalScore));

    return { total: boundedTotal, fund: fundScore, tech: techScore, rating: ratingScore, news: newsScore, insider: insiderScore };
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
  const storage = new PortfolioStorage();
  const analyzer = new PriceAnalyzer();

  // Ensure CSV data directory exists
  const dataDir = path.resolve(__dirname, '../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const csvPath = path.join(dataDir, 'score_history.csv');
  
  // Write Excel headers if file is brand new
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, 'Date,Symbol,Final_Score,Signal,Price,Total_Value,Fundamentals,Technicals,Analysts,News,Insiders\n');
  }

  try {
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║        PHASE 2 MULTI-FACTOR MODEL + EXCEL TRACKER          ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');
    
    const portfolio = await storage.getPortfolio();
    const stocks = portfolio.stocks || [];

    if (stocks.length === 0) process.exit(0);

    for (const stock of stocks) {
      try {
        logger.info(`Analyzing ${stock.symbol}...`);
        
        const [priceData, fundamentals, technicals, ratings, rawNews, insiderData] = await Promise.all([
          analyzer.fetchPrice(stock.symbol),
          analyzer.fetchFundamentals(stock.symbol),
          analyzer.fetchTechnicals(stock.symbol),
          analyzer.fetchRatings(stock.symbol),
          analyzer.fetchNews(stock.symbol),
          analyzer.fetchInsider(stock.symbol)
        ]);

        const analyzedNews = newsAnalyzer.analyzeNews(rawNews, stock.symbol);
        const scoreObj = analyzer.calculateScore(priceData, fundamentals, technicals, ratings, analyzedNews, insiderData);
        const score = scoreObj.total;
        const signal = analyzer.getSignal(score);

        logger.info(`  📊 Breakdown: Fund(${scoreObj.fund.toFixed(1)}) | Tech(${scoreObj.tech.toFixed(1)}) | Analyst(${scoreObj.rating.toFixed(1)}) | News(${scoreObj.news.toFixed(1)}) | Insider(${scoreObj.insider.toFixed(1)})`);

        const updates = {
          latest_score: Math.round(score * 10) / 10,
          signal: signal,
          current_price: priceData ? priceData.price : stock.current_price,
          change_percent: priceData ? priceData.changePercent : stock.change_percent,
          score_breakdown: scoreObj // Saved for the future 6-hour News Engine
        };

        if (updates.current_price && stock.quantity) {
          updates.total_value = updates.current_price * stock.quantity;
        }

        if (rawNews.length > 0) {
          updates.recent_news = rawNews.map(n => ({ headline: n.headline, url: n.url, published_at: n.published_at }));
        }

        await storage.updateStock(stock.symbol, updates);
        
        // Write today's results to the Excel-compatible CSV file
        const today = new Date().toISOString().split('T')[0];
        const csvLine = `${today},${stock.symbol},${score.toFixed(2)},${signal},${updates.current_price || 0},${updates.total_value || 0},${scoreObj.fund.toFixed(2)},${scoreObj.tech.toFixed(2)},${scoreObj.rating.toFixed(2)},${scoreObj.news.toFixed(2)},${scoreObj.insider.toFixed(2)}\n`;
        fs.appendFileSync(csvPath, csvLine);

        logger.info(`✓ ${stock.symbol}: Final Score ${score.toFixed(1)}/10 → ${signal}\n`);
        
        await sleep(13000); 
      } catch (e) { logger.error(`Error updating ${stock.symbol}`, e); }
    }

    logger.info(`✅ UPDATE AND CSV EXPORT COMPLETED.`);
    const client = await getRedisClient();
    await client.quit();
    process.exit(0);
  } catch (error) {
    logger.error('FATAL ERROR', error);
    process.exit(1);
  }
}

updateMarketData();
