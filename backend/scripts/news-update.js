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

async function fetchNews(symbol) {
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
  } catch (e) { logger.warn(`News fetch failed for ${symbol}: ${e.message}`); }
  return [];
}

function getSignal(score) {
  if (score >= 8.5) return 'STRONG_BUY';
  if (score >= 7.0) return 'BUY';
  if (score >= 5.5) return 'HOLD';
  if (score >= 4.0) return 'REDUCE';
  return 'SELL';
}

async function updateNewsOnly() {
  try {
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║           INTRA-DAY NEWS CATALYST UPDATE RUN               ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');

    const client = await getRedisClient();
    const data = await client.get('portfolio');
    if (!data) process.exit(0);

    let portfolio = JSON.parse(data);
    let stocks = portfolio.stocks || [];

    for (let i = 0; i < stocks.length; i++) {
      let stock = stocks[i];
      logger.info(`Checking news for ${stock.symbol}...`);

      const rawNews = await fetchNews(stock.symbol);
      
      // If no new news, skip to save resources
      if (!rawNews || rawNews.length === 0) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }

      rawNews.forEach(n => logger.info(`  📰 ${n.headline.substring(0, 60)}...`));
      const analyzedNews = newsAnalyzer.analyzeNews(rawNews, stock.symbol);
      
      // Calculate NEW News Score
      let newsScore = 5;
      if (analyzedNews.length > 0) {
        const avgSentiment = analyzedNews.reduce((sum, item) => sum + item.sentiment.score, 0) / analyzedNews.length; 
        const avgImportance = analyzedNews.reduce((sum, item) => sum + item.importance, 0) / analyzedNews.length; 
        newsScore = 5 + (avgSentiment * 4);
        if (avgSentiment > 0) newsScore += (avgImportance / 10);
        else if (avgSentiment < 0) newsScore -= (avgImportance / 10);
        newsScore = Math.max(0, Math.min(10, newsScore));
      }

      // Merge new News Score with existing frozen scores from the Master Run
      if (stock.score_breakdown) {
        const { fund, tech, rating, insider } = stock.score_breakdown;
        
        const finalScore = (fund * 0.29) + (tech * 0.16) + (rating * 0.20) + (newsScore * 0.15) + (insider * 0.20);
        const boundedTotal = Math.max(0, Math.min(10, finalScore));

        stock.latest_score = Math.round(boundedTotal * 10) / 10;
        stock.signal = getSignal(stock.latest_score);
        stock.score_breakdown.news = newsScore; // Update the breakdown tracker
        
        stock.recent_news = rawNews.map(n => ({ headline: n.headline, url: n.url, published_at: n.published_at }));
        
        logger.info(`✓ ${stock.symbol}: Score updated to ${stock.latest_score}/10 based on new catalyst.`);
      }

      // 1.5-second pacing for NewsData.io
      await new Promise(r => setTimeout(r, 1500)); 
    }

    portfolio.stocks = stocks;
    portfolio.lastUpdated = new Date().toISOString();
    await client.set('portfolio', JSON.stringify(portfolio));
    
    logger.info(`✅ INTRA-DAY NEWS UPDATE COMPLETED.`);
    await client.quit();
    process.exit(0);

  } catch (error) {
    logger.error('FATAL ERROR', error);
    process.exit(1);
  }
}

updateNewsOnly();
