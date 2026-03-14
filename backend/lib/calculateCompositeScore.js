/**
 * Composite Score Calculator - COMPLETE VERSION
 * Combines all 6 data sources into final 0-10 decision score
 * Professional weighting: Ratings(25%) + Grades(15%) + Sentiment(20%) + Technical(20%) + Insider(10%) + Filing(10%)
 */

const logger = require('./logger');

/**
 * Main composite score calculation function
 * @param {Object} stock - Stock data object with all components
 * @returns {Object} Complete score breakdown
 */
function calculateCompositeScore(stock) {
  try {
    // Validate input
    if (!stock || typeof stock !== 'object' || !stock.symbol) {
      logger.warn('Invalid stock data for composite scoring');
      return null;
    }

    // ========== COMPONENT 1: ANALYST RATINGS (25%) ==========
    let ratingScore = 5; // Default neutral
    
    if (stock.ratings && typeof stock.ratings === 'object') {
      const total = (stock.ratings.strong_buy || 0) +
                    (stock.ratings.buy || 0) +
                    (stock.ratings.hold || 0) +
                    (stock.ratings.sell || 0) +
                    (stock.ratings.strong_sell || 0);

      if (total > 0) {
        // Weight: Strong Buy=5, Buy=4, Hold=3, Sell=2, Strong Sell=1
        ratingScore = (
          (stock.ratings.strong_buy || 0) * 5 +
          (stock.ratings.buy || 0) * 4 +
          (stock.ratings.hold || 0) * 3 +
          (stock.ratings.sell || 0) * 2 +
          (stock.ratings.strong_sell || 0) * 1
        ) / total;
      }
    }
    
    const ratingComponent = (ratingScore / 5) * 0.25; // Normalize to 0-10, apply 25% weight

    // ========== COMPONENT 2: STOCK GRADES (15%) ==========
    let gradeScore = 5; // Default neutral
    
    if (stock.grades && Array.isArray(stock.grades) && stock.grades.length > 0) {
      // Convert letter grades to numeric (A+=5, A=4.7, ... F=0)
      const gradeMap = {
        'A+': 5, 'A': 4.7, 'A-': 4.3,
        'B+': 4, 'B': 3.7, 'B-': 3.3,
        'C+': 3, 'C': 2.7, 'C-': 2.3,
        'D+': 2, 'D': 1.7, 'D-': 1.3,
        'F': 0
      };
      
      const grade = stock.grades[0].grade;
      gradeScore = gradeMap[grade] || 5;
    }
    
    const gradeComponent = (gradeScore / 5) * 0.15; // Normalize, apply 15% weight

    // ========== COMPONENT 3: NEWS SENTIMENT (20%) ==========
    let sentimentScore = 5; // Default neutral
    
    if (stock.news && Array.isArray(stock.news) && stock.news.length > 0) {
      // Average sentiment from recent news articles
      const sentiments = stock.news
        .filter(n => n.sentiment && typeof n.sentiment.score === 'number')
        .map(n => n.sentiment.score)
        .slice(0, 10); // Use last 10 articles
      
      if (sentiments.length > 0) {
        const avgSentiment = sentiments.reduce((a, b) => a + b, 0) / sentiments.length;
        // Convert -1 to +1 sentiment to 0-10 scale
        sentimentScore = ((avgSentiment + 1) / 2) * 10;
      }
    }
    
    const sentimentComponent = (Math.max(0, Math.min(10, sentimentScore)) / 10) * 0.20; // Clamp 0-10, apply 20% weight

    // ========== COMPONENT 4: TECHNICAL INDICATORS (20%) ==========
    let technicalScore = 5; // Default neutral
    
    if (stock.technicals && typeof stock.technicals === 'object') {
      technicalScore = calculateTechnicalScore(stock.technicals);
    }
    
    const technicalComponent = (Math.max(0, Math.min(10, technicalScore)) / 10) * 0.20; // Apply 20% weight

    // ========== COMPONENT 5: INSIDER TRANSACTIONS (10%) ==========
    let insiderScore = 5; // Default neutral
    
    if (stock.insider && typeof stock.insider === 'object') {
      insiderScore = calculateInsiderScore(stock.insider);
    }
    
    const insiderComponent = (Math.max(0, Math.min(10, insiderScore)) / 10) * 0.10; // Apply 10% weight

    // ========== COMPONENT 6: FILING HEALTH (10%) ==========
    let filingScore = 5; // Default neutral
    
    if (stock.filing && stock.filing.health_score) {
      filingScore = Math.max(0, Math.min(10, stock.filing.health_score));
    }
    
    const filingComponent = (filingScore / 10) * 0.10; // Apply 10% weight

    // ========== CALCULATE COMPOSITE SCORE ==========
    const compositeScore = (ratingComponent + gradeComponent + sentimentComponent + 
                           technicalComponent + insiderComponent + filingComponent) * 10;

    // ========== CALCULATE CONFIDENCE ==========
    let dataPoints = 0;
    if (stock.ratings) dataPoints++;
    if (stock.grades) dataPoints++;
    if (stock.news && stock.news.length > 0) dataPoints++;
    if (stock.technicals) dataPoints++;
    if (stock.insider) dataPoints++;
    if (stock.filing) dataPoints++;
    
    const confidence = (dataPoints / 6) * 100;

    // ========== DETERMINE SIGNAL ==========
    let signal = 'HOLD';
    if (compositeScore >= 9) signal = 'STRONG_BUY';
    else if (compositeScore >= 7.5) signal = 'BUY';
    else if (compositeScore >= 6.5) signal = 'HOLD';
    else if (compositeScore >= 5) signal = 'REDUCE';
    else signal = 'SELL';

    // ========== CALCULATE UPSIDE/DOWNSIDE ==========
    let upsideDownside = null;
    if (stock.priceTarget && stock.currentPrice && stock.currentPrice > 0) {
      upsideDownside = ((stock.priceTarget - stock.currentPrice) / stock.currentPrice) * 100;
    }

    // ========== RETURN COMPLETE SCORE OBJECT ==========
    return {
      symbol: stock.symbol,
      date: new Date().toISOString().split('T')[0],
      
      // Individual component scores (0-10)
      components: {
        analyst_rating: Math.round(ratingScore * 10) / 10,
        stock_grade: Math.round(gradeScore * 10) / 10,
        news_sentiment: Math.round(sentimentScore * 10) / 10,
        technical: Math.round(technicalScore * 10) / 10,
        insider: Math.round(insiderScore * 10) / 10,
        filing_health: Math.round(filingScore * 10) / 10
      },
      
      // Weighted contributions to final score
      weights: {
        analyst_rating: Math.round(ratingComponent * 100) / 100,
        stock_grade: Math.round(gradeComponent * 100) / 100,
        news_sentiment: Math.round(sentimentComponent * 100) / 100,
        technical: Math.round(technicalComponent * 100) / 100,
        insider: Math.round(insiderComponent * 100) / 100,
        filing_health: Math.round(filingComponent * 100) / 100
      },
      
      // Final score and signal
      composite_score: Math.round(compositeScore * 10) / 10,
      confidence: Math.round(confidence),
      signal: signal,
      
      // Valuation data
      analyst_price_target: stock.priceTarget || null,
      current_price: stock.currentPrice || null,
      upside_downside: upsideDownside ? Math.round(upsideDownside * 10) / 10 : null,
      
      // Metadata
      metadata: {
        calculated_at: new Date(),
        data_sources_used: dataPoints,
        calculation_method: 'Professional weighted composite (6 components)'
      }
    };

  } catch (error) {
    logger.error(`Error calculating composite score for ${stock?.symbol}`, error);
    return null;
  }
}

/**
 * Calculate technical score from RSI, moving averages, and Bollinger Bands
 */
function calculateTechnicalScore(technicals) {
  let score = 5; // Start neutral

  // RSI Analysis (Relative Strength Index)
  if (technicals.rsi) {
    if (technicals.rsi < 30) {
      score += 1.5; // Oversold = buying opportunity
    } else if (technicals.rsi > 70) {
      score -= 1.5; // Overbought = selling pressure
    }
  }

  // Moving Average Analysis
  if (technicals.price && technicals.ma200) {
    if (technicals.price > technicals.ma200) {
      score += 1; // Above 200-day MA = uptrend
      
      if (technicals.ma20 && technicals.price > technicals.ma20) {
        score += 0.5; // Golden cross pattern
      }
    } else if (technicals.price < technicals.ma200) {
      score -= 1; // Below 200-day MA = downtrend
    }
  }

  // Volatility Analysis
  if (technicals.volatility) {
    if (technicals.volatility > 0.3) {
      score -= 0.5; // High volatility = risk
    } else if (technicals.volatility < 0.15) {
      score += 0.5; // Low volatility = stability
    }
  }

  // Clamp score to 0-10 range
  return Math.max(0, Math.min(10, score));
}

/**
 * Calculate insider sentiment from Form 4 transactions
 */
function calculateInsiderScore(insiderData) {
  let score = 5; // Default neutral

  if (!insiderData) return score;

  // Analyze transaction pattern
  if (insiderData.isBuying && !insiderData.isSelling) {
    if (insiderData.transactionCount > 1) {
      score = 8; // Multiple insider buys = very bullish
    } else {
      score = 7; // Single insider buy = bullish
    }
  } else if (insiderData.isSelling && !insiderData.isBuying) {
    if (insiderData.transactionCount > 1) {
      score = 2; // Multiple insider sells = bearish
    } else {
      score = 3; // Single insider sell = somewhat bearish
    }
  } else if (insiderData.isBuying && insiderData.isSelling) {
    score = 5; // Mixed activity = neutral
  }

  return Math.max(0, Math.min(10, score));
}

module.exports = calculateCompositeScore;
