#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { createClient } = require('redis');

// Pearson Correlation Math Formula
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
  console.log("Starting Pearson Correlation Engine...");

  const csvPath = path.resolve(__dirname, '../data/historical_prices.csv');
  if (!fs.existsSync(csvPath)) {
    console.error("Error: historical_prices.csv not found in backend/data/");
    process.exit(1);
  }

  // 1. Read and Parse the CSV
  const csvData = fs.readFileSync(csvPath, 'utf8');
  const lines = csvData.split('\n').filter(line => line.trim().length > 0);
  
  // Skip header
  const headers = lines.shift(); 
  
  // Data structure: { "CRWD": { "2025-02-18": 150.5, ... }, "TPL": { ... } }
  const priceData = {};
  const allDates = new Set();

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

  const sortedDates = Array.from(allDates).sort();
  const tickers = Object.keys(priceData);
  
  console.log(`Found ${tickers.length} tickers across ${sortedDates.length} trading days.`);

  // 2. Align Arrays (Ensure we only compare dates where both stocks traded)
  const matrix = {};

  for (let i = 0; i < tickers.length; i++) {
    matrix[tickers[i]] = {};
    for (let j = 0; j < tickers.length; j++) {
      const t1 = tickers[i];
      const t2 = tickers[j];

      if (t1 === t2) {
        matrix[t1][t2] = 1.0; // A stock is always 100% correlated to itself
        continue;
      }

      let arr1 = [];
      let arr2 = [];

      sortedDates.forEach(date => {
        if (priceData[t1][date] !== undefined && priceData[t2][date] !== undefined) {
          arr1.push(priceData[t1][date]);
          arr2.push(priceData[t2][date]);
        }
      });

      const correlation = calculatePearson(arr1, arr2);
      matrix[t1][t2] = correlation ? parseFloat(correlation.toFixed(3)) : 0;
    }
  }

  // 3. Save to Redis
  try {
    const redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', (err) => console.error('Redis error:', err));
    await redisClient.connect();

    const correlationPayload = {
      lastUpdated: new Date().toISOString(),
      tickers: tickers,
      matrix: matrix
    };

    await redisClient.set('portfolio_correlation', JSON.stringify(correlationPayload));
    console.log("✅ Correlation Matrix successfully calculated and saved to Redis.");
    
    await redisClient.quit();
    process.exit(0);
  } catch (err) {
    console.error("Failed to save to Redis:", err);
    process.exit(1);
  }
}

runCorrelationEngine();
