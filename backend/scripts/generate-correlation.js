#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { createClient: createRedisClient } = require('redis');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

const supabase = createSupabaseClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function calculatePearson(x, y) {
  const n = x.length;
  if (n === 0 || n !== y.length) return null;

  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumX2 = x.reduce((a, b) => a + b * b, 0);
  const sumY2 = y.reduce((a, b) => a + b * b, 0);
  const sumXY = x.reduce((a, b, i) => a + b * y[i], 0);

  const numerator = (n * sumXY) - (sumX * sumY);
  const denominator = Math.sqrt(((n * sumX2) - (sumX * sumX)) * ((n * sumY2) - (sumY * sumY)));

  if (denominator === 0) return 0;
  return numerator / denominator;
}

async function runCorrelationEngine() {
  console.log("Starting Rolling-Window Correlation & Optimization Engine...");

  const priceData = {};
  const allDates = new Set();

  // 1. Read Seed Data from Static CSV
  const csvPath = path.resolve(__dirname, '../data/historical_prices.csv');
  if (fs.existsSync(csvPath)) {
    const csvData = fs.readFileSync(csvPath, 'utf8');
    const lines = csvData.split('\n').filter(line => line.trim().length > 0);
    lines.shift(); // Skip header
    
    lines.forEach(line => {
      const cols = line.split(',');
      if (cols.length >= 4) {
        const ticker = cols[0].trim();
        const date = cols[2].trim();
        const price = parseFloat(cols[3].trim());
        
        if (!priceData[ticker]) priceData[ticker] = {};
        priceData[ticker][date] = price;
        allDates.add(date);
      }
    });
    console.log("Loaded static CSV seed data.");
  } else {
    console.warn("historical_prices.csv not found. Relying strictly on Supabase data.");
  }

  // 2. Fetch Live Data from Supabase (The Daily Updates)
  // We fetch up to 10,000 rows to ensure we get all recent daily closes
  const { data: liveData, error } = await supabase
    .from('daily_metrics')
    .select('date, symbol, price')
    .limit(10000);

  if (liveData && !error) {
    liveData.forEach(row => {
      if (!priceData[row.symbol]) priceData[row.symbol] = {};
      // This automatically appends new dates or overwrites CSV data with true Supabase data
      priceData[row.symbol][row.date] = parseFloat(row.price);
      allDates.add(row.date);
    });
    console.log("Merged live Supabase daily metrics.");
  }

  // 3. Enforce the 250-Day Rolling Window
  // Sort all combined dates and slice only the last 250
  const sortedDates = Array.from(allDates).sort().slice(-250);
  const tickers = Object.keys(priceData);
  const matrix = {};

  console.log(`Calculating returns matrix over rolling window: ${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}`);

  // 4. Build Matrix Using Daily Returns (% Change)
  for (let i = 0; i < tickers.length; i++) {
    matrix[tickers[i]] = {};
    for (let j = 0; j < tickers.length; j++) {
      const t1 = tickers[i], t2 = tickers[j];
      
      if (t1 === t2) {
        matrix[t1][t2] = 1.0;
        continue;
      }

      let returns1 = [];
      let returns2 = [];
      let overlappingDates = [];

      sortedDates.forEach(date => {
        if (priceData[t1][date] !== undefined && priceData[t2][date] !== undefined) {
          overlappingDates.push(date);
        }
      });

      // Calculate Day-over-Day % Returns
      for (let k = 1; k < overlappingDates.length; k++) {
        const today = overlappingDates[k];
        const yesterday = overlappingDates[k - 1];

        const p1Today = priceData[t1][today];
        const p1Yest = priceData[t1][yesterday];
        const r1 = (p1Today - p1Yest) / p1Yest;

        const p2Today = priceData[t2][today];
        const p2Yest = priceData[t2][yesterday];
        const r2 = (p2Today - p2Yest) / p2Yest;

        returns1.push(r1);
        returns2.push(r2);
      }

      const correlation = calculatePearson(returns1, returns2);
      matrix[t1][t2] = correlation ? parseFloat(correlation.toFixed(3)) : 0;
    }
  }

  // 5. CAPITAL OPTIMIZATION: Fetch Regime Stats from Supabase
  const { data: stats } = await supabase.from('regime_flags').select('*');
  const statsMap = {};
  if (stats) stats.forEach(s => statsMap[s.symbol] = s);

  const insights = [];
  
  for (let i = 0; i < tickers.length; i++) {
    for (let j = i + 1; j < tickers.length; j++) {
      const t1 = tickers[i], t2 = tickers[j];
      const corr = matrix[t1][t2];

      if (corr >= 0.65) { 
        const s1 = statsMap[t1] || { quality_score: 0, excess_return_pct: 0, regime_status: 'NORMAL' };
        const s2 = statsMap[t2] || { quality_score: 0, excess_return_pct: 0, regime_status: 'NORMAL' };
        
        let winner = t1, loser = t2, wStat = s1, lStat = s2;
        
        if (s2.excess_return_pct > s1.excess_return_pct) {
          winner = t2; loser = t1; wStat = s2; lStat = s1;
        } else if (s1.excess_return_pct === s2.excess_return_pct && s2.quality_score > s1.quality_score) {
          winner = t2; loser = t1; wStat = s2; lStat = s1;
        }

        insights.push({
          pair: [t1, t2],
          correlation: corr,
          winner,
          loser,
          winnerAlpha: wStat.excess_return_pct || 0,
          loserAlpha: lStat.excess_return_pct || 0,
          winnerQuality: wStat.quality_score || 0,
          loserQuality: lStat.quality_score || 0
        });
      }
    }
  }

  insights.sort((a, b) => b.correlation - a.correlation);

  // 6. Save to Redis
  try {
    const redisClient = createRedisClient({ url: process.env.REDIS_URL });
    await redisClient.connect();
    
    const correlationPayload = {
      lastUpdated: new Date().toISOString(),
      tickers: tickers,
      matrix: matrix,
      insights: insights 
    };

    await redisClient.set('portfolio_correlation', JSON.stringify(correlationPayload));
    console.log(`✅ Saved Rolling Returns Matrix & ${insights.length} Actionable Insights to Redis.`);
    await redisClient.quit();
    process.exit(0);
  } catch (err) {
    console.error("Failed to save to Redis:", err);
    process.exit(1);
  }
}

runCorrelationEngine();
