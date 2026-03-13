const Database = require('better-sqlite3');
const fetchFinance = require('../lib/fetchFinance');
const fetchForm4 = require('../lib/fetchForm4');
const calculateMetrics = require('../lib/calculateMetrics');
const fs = require('fs');

const db = new Database('./data/stocks.db');

async function updateAllStocks() {
  console.log(`Starting daily update: ${new Date().toISOString()}`);
  
  // Get list of stocks to track (from database)
  const stocks = db.prepare('SELECT symbol FROM portfolio WHERE active = 1').all();
  
  const apiLogs = {
    timestamp: new Date().toISOString(),
    totalCalls: 0,
    apiUsage: {
      finnhub: 0,
      yfinance: 0,
      secEdgar: 0,
      newsapi: 0
    },
    errors: []
  };
  
  for (const stock of stocks) {
    try {
      console.log(`Updating ${stock.symbol}...`);
      
      // Fetch from all APIs
      const finnhubData = await fetchFinance.getFinnhubData(stock.symbol);
      apiLogs.apiUsage.finnhub++;
      
      const yfinanceData = await fetchFinance.getYfinanceData(stock.symbol);
      apiLogs.apiUsage.yfinance++;
      
      const form4Data = await fetchForm4.getLatestFilings(stock.symbol);
      apiLogs.apiUsage.secEdgar++;
      
      // Combine all data
      const allData = {
        ...finnhubData,
        ...yfinanceData,
        form4: form4Data
      };
      
      // Calculate all metrics and scores
      const metrics = calculateMetrics(allData);
      
      // Store in database with timestamp
      db.prepare(`
        INSERT OR REPLACE INTO stock_data (
          symbol, price, change, analyst_rating, institutional_ownership,
          rsi, moving_avg_20, moving_avg_50, moving_avg_200,
          pe_ratio, earnings_growth, dividend_yield,
          composite_score, recommendation, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        stock.symbol,
        metrics.price,
        metrics.change,
        metrics.analystRating,
        metrics.institutionalOwnership,
        metrics.rsi,
        metrics.ma20,
        metrics.ma50,
        metrics.ma200,
        metrics.pe,
        metrics.earningsGrowth,
        metrics.dividendYield,
        metrics.compositeScore,
        metrics.recommendation,
        new Date().toISOString()
      );
      
      apiLogs.totalCalls += 3;
      
    } catch (error) {
      console.error(`Error updating ${stock.symbol}:`, error);
      apiLogs.errors.push({
        symbol: stock.symbol,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }
  
  // Log API usage
  fs.writeFileSync('./data/apiLogs.json', JSON.stringify(apiLogs, null, 2));
  
  console.log(`Update complete. API calls: ${apiLogs.totalCalls}`);
  console.log(`Finnhub: ${apiLogs.apiUsage.finnhub}/500`);
  console.log(`Yfinance: ${apiLogs.apiUsage.yfinance} (unlimited)`);
  console.log(`SEC EDGAR: ${apiLogs.apiUsage.secEdgar} (unlimited)`);
}

// Run the update
updateAllStocks().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
