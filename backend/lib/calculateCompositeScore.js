/**
 * Composite Score Calculator
 * Combines 6 data sources into final 0-10 score
 * Determines BUY/SELL/HOLD signals
 */

const logger = require('./logger');

function calculateCompositeScore(stock) {
  try {
    // Validate inputs
    if (!stock || typeof stock !== 'object') {
      logger.warn('Invalid stock data');
      return null;
    }

    // ========== COMPONENT 1: Analyst Ratings (25%) ==========
    let ratingScore = 5;
    if (stock.ratings) {
      const total = (stock.ratings.strong_buy || 0) +
                    (stock.ratings.buy || 0) +
                    (stock.ratings.hold || 0) +
                    (stock.ratings.sell || 0) +
                    (stock.ratings.strong_sell || 0);

      if (total > 0) {
        ratingScore = (
          (stock.ratings.strong_buy || 0) * 5 +
          (stock.ratings.buy || 0) * 4 +
          (stock.ratings.hold || 0) * 3 +
          (stock.ratings.sell || 0) * 2 +
          (stock.ratings.strong_sell || 0) * 1
        ) / total;
      }
    }
    const ratingWeight = (ratingScore / 5) * 0.25;

    // ========== COMPONENT 2: Stock Grades (15%) ==========
    let gradeScore = 5;
    if (stock.grades && stock.grades[0]) {
      const gradeMap = {
        'A+': 5, 'A': 4.7, 'A-': 4.3,
        'B+': 4, 'B': 3.7, 'B-': 3.3,
        'C+': 3, 'C': 2.7, 'C-': 2.3,
        'D+': 2, 'D': 1.7, 'D-': 1.3,
        'F': 0
      };
      gradeScore = gradeMap[stock.grades[0].grade] || 5;
    }
    const gradeWeight = (gradeScore / 5) * 0.15;

    // ========== COMPONENT 3: News Sentiment (20%) ==========
    let sentimentScore = 5;
    if (stock.news && Array.isArray(stock.news) && stock.news.length > 0) {
      const sentiments = stock.news
        .map(n => n.sentiment?.score || 0)
        .slice(0, 10);
      const avgSentiment = sentiments.reduce((a, b) => a + b, 0) / sentiments.length;
      sentimentScore = ((avgSentiment + 1) / 2) * 10;
    }
    const sentimentWeight = (Math.max(0, Math.min(10, sentimentScore)) / 10) * 0.20;

    // ========== COMPONENT 4: Technical Indicators (20%) ==========
    let technicalScore = 5;
    if (stock.technicals) {
      technicalScore = calculateTechnicalScore(stock.technicals);
    }
    const technicalWeight = (technicalScore / 10) * 0.20;

    // ========== COMPONENT 5: Insider Transactions (10%) ==========
    let insiderScore = 5;
    if (stock.insider && Array.isArray(stock.insider)) {
      const buys = stock.insider.filter(t => t.type === 'Buy').length;
      const sells = stock.insider.filter(t => t.type === 'Sell').length;
      insiderScore = Math.min(10, 1 + (buys / Math.max(1, sells)) * 2);
    }
    const insiderWeight = (insiderScore / 10) * 0.10;

    // ========== COMPONENT 6: Filing Health (10%) ==========
    let filingScore = 5;
    if (stock.filing && stock.filing.health_score) {
      filingScore = stock.filing.health_score;
    }
    const filingWeight = (filingScore / 10) * 0.10;

    // ========== COMPOSITE SCORE ==========
    const compositeScore = (ratingWeight + gradeWeight + sentimentWeight + 
                           technicalWeight + insiderWeight + filingWeight) * 10;

    // ========== CONFIDENCE LEVEL ==========
    let dataPoints = 0;
    if (stock.ratings) dataPoints++;
    if (stock.grades) dataPoints++;
    if (stock.news && stock.news.length > 0) dataPoints++;
    if (stock.technicals) dataPoints++;
    if (stock.insider && stock.insider.length > 0) dataPoints++;
    if (stock.filing) dataPoints++;
    const confidence = (dataPoints / 6) * 100;

    // ========== DETERMINE SIGNAL ==========
    let signal = 'HOLD';
    if (compositeScore >= 9) signal = 'STRONG_BUY';
    else if (compositeScore >= 7.5) signal = 'BUY';
    else if (compositeScore >= 6.5) signal = 'HOLD';
    else if (compositeScore >= 5) signal = 'REDUCE';
    else signal = 'SELL';

    // ========== RETURN COMPLETE SCORE ==========
    return {
      symbol: stock.symbol,
      date: new Date().toISOString().split('T')[0],
      
      // Component scores
      components: {
        analyst_rating: Math.round(ratingScore * 10) / 10,
        stock_grade: Math.round(gradeScore * 10) / 10,
        news_sentiment: Math.round(sentimentScore * 10) / 10,
        technical: Math.round(technicalScore * 10) / 10,
        insider: Math.round(insiderScore * 10) / 10,
        filing_health: Math.round(filingScore * 10) / 10
      },
      
      // Weighted contributions
      weights: {
        analyst_rating: ratingWeight,
        stock_grade: gradeWeight,
        news_sentiment: sentimentWeight,
        technical: technicalWeight,
        insider: insiderWeight,
        filing: filingWeight
      },
      
      // Final score
      composite_score: Math.round(compositeScore * 10) / 10,
      confidence: Math.round(confidence),
      signal: signal,
      
      // Additional info
      analyst_price_target: stock.priceTarget || null,
      current_price: stock.currentPrice || null,
      upside_downside: stock.upsideDownside || null,
      
      metadata: {
        calculated_at: new Date(),
        data_sources: dataPoints
      }
    };

  } catch (error) {
    logger.error('Error calculating composite score', error);
    return null;
  }
}

function calculateTechnicalScore(technicals) {
  let score = 5;

  if (technicals.rsi) {
    if (technicals.rsi < 30) score += 1.5; // Oversold
    if (technicals.rsi > 70) score -= 1.5; // Overbought
  }

  if (technicals.price && technicals.ma200) {
    if (technicals.price > technicals.ma200) score += 1; // Uptrend
    if (technicals.price < technicals.ma200) score -= 1; // Downtrend
  }

  return Math.max(0, Math.min(10, score));
}

module.exports = calculateCompositeScore;
