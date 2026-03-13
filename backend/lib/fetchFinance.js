const axios = require('axios');
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

const fetchFinance = {
  // FINNHUB: Analyst ratings + News + Fundamentals
  async getFinnhubData(symbol) {
    try {
      // Quote data (price, change)
      const quoteRes = await axios.get(
        `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`
      );
      
      // Analyst ratings (FRESH DATA - key for institutional tracking)
      const ratingsRes = await axios.get(
        `https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${FINNHUB_KEY}`
      );
      
      // Company profile (fundamentals)
      const profileRes = await axios.get(
        `https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${FINNHUB_KEY}`
      );
      
      // Earnings (for growth tracking)
      const earningsRes = await axios.get(
        `https://finnhub.io/api/v1/stock/earnings?symbol=${symbol}&token=${FINNHUB_KEY}`
      );
      
      // News (for sentiment)
      const newsRes = await axios.get(
        `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=2026-03-01&to=2026-03-13&limit=5&token=${FINNHUB_KEY}`
      );
      
      return {
        price: quoteRes.data.c,
        change: quoteRes.data.d,
        changePercent: quoteRes.data.dp,
        high: quoteRes.data.h,
        low: quoteRes.data.l,
        
        // Analyst ratings (FRESH - max 30 days old)
        analystRating: ratingsRes.data?.[0] ? calculateRating(ratingsRes.data[0]) : 3,
        institutionalOwnership: profileRes.data.finnhubIndustry || 'N/A',
        
        // Fundamentals
        pe: profileRes.data.pe || null,
        marketCap: profileRes.data.marketCapitalization || null,
        
        // Growth
        earningsGrowth: earningsRes.data?.[0]?.epsEstimate || null,
        dividendYield: profileRes.data.dividendYield || 0,
        
        // News for sentiment
        news: newsRes.data || []
      };
    } catch (error) {
      console.error(`Finnhub error for ${symbol}:`, error.message);
      return null;
    }
  },

  // YFINANCE: Real prices + Technical Indicators
  async getYfinanceData(symbol) {
    try {
      // Using yfinance package (install: npm install yfinance)
      const yahooFinance = require('yahoo-finance2').default;
      
      // Get last 200 days (for all moving averages)
      const data = await yahooFinance.historical(symbol, {
        period1: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
        period2: new Date(),
        interval: '1d'
      });
      
      // Calculate technical indicators
      const closes = data.map(d => d.close);
      const rsi = calculateRSI(closes);
      const ma20 = calculateMA(closes, 20);
      const ma50 = calculateMA(closes, 50);
      const ma200 = calculateMA(closes, 200);
      const volatility = calculateVolatility(closes);
      
      return {
        rsi,
        movingAvg20: ma20,
        movingAvg50: ma50,
        movingAvg200: ma200,
        volatility,
        priceHistory: closes.slice(-20) // Last 20 days for chart
      };
    } catch (error) {
      console.error(`Yfinance error for ${symbol}:`, error.message);
      return null;
    }
  }
};

// Helper: Calculate analyst rating from Finnhub data
function calculateRating(ratings) {
  const total = (ratings.strongBuy || 0) + (ratings.buy || 0) + 
                (ratings.hold || 0) + (ratings.sell || 0) + (ratings.strongSell || 0);
  
  if (total === 0) return 3;
  
  const bullish = (ratings.strongBuy || 0) + (ratings.buy || 0);
  return (bullish / total) * 5; // 0-5 scale
}

// Helper: Calculate RSI
function calculateRSI(closes, period = 14) {
  let gains = 0, losses = 0;
  
  for (let i = 1; i < period; i++) {
    const diff = closes[closes.length - period + i] - closes[closes.length - period + i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  
  return Math.round(rsi);
}

// Helper: Calculate Moving Average
function calculateMA(closes, period) {
  const sum = closes.slice(-period).reduce((a, b) => a + b, 0);
  return sum / period;
}

// Helper: Calculate Volatility (Standard Deviation)
function calculateVolatility(closes, period = 20) {
  const recent = closes.slice(-period);
  const mean = recent.reduce((a, b) => a + b) / period;
  const squareDiffs = recent.map(x => Math.pow(x - mean, 2));
  const variance = squareDiffs.reduce((a, b) => a + b) / period;
  return Math.sqrt(variance).toFixed(2);
}

module.exports = fetchFinance;
