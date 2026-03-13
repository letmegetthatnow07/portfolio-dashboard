function calculateMetrics(data) {
  // Composite Score (same as before)
  const institutionalScore = (data.institutionalRating || 3) / 5 * 10;
  const expertScore = (data.analystRating || 3) / 5 * 10;
  const newsScore = calculateNewsSentiment(data.news) * 10;
  const technicalScore = (data.rsi || 50) / 100 * 10;
  
  // NEW WEIGHTS (as you requested)
  // Institutions 40%, Experts 30%, News 20%, Technical 10%
  const compositeScore = (
    (institutionalScore * 0.40) +
    (expertScore * 0.30) +
    (newsScore * 0.20) +
    (technicalScore * 0.10)
  ).toFixed(1);
  
  // Recommendation logic
  const recommendation = getRecommendation(compositeScore, data);
  
  return {
    price: data.price,
    change: data.change,
    changePercent: data.changePercent,
    rsi: data.rsi,
    ma20: data.movingAvg20,
    ma50: data.movingAvg50,
    ma200: data.movingAvg200,
    pe: data.pe,
    earningsGrowth: data.earningsGrowth,
    dividendYield: data.dividendYield,
    volatility: data.volatility,
    
    // Form 4
    recentInsiderBuying: data.form4?.isBuying || false,
    
    // Scores
    institutionalScore,
    expertScore,
    newsScore,
    technicalScore,
    compositeScore,
    recommendation
  };
}

function calculateNewsSentiment(news) {
  if (!news || news.length === 0) return 0.5;
  
  const positive = news.filter(n => 
    n.headline.toLowerCase().includes('surge') ||
    n.headline.toLowerCase().includes('rally') ||
    n.headline.toLowerCase().includes('beat') ||
    n.headline.toLowerCase().includes('profit') ||
    n.headline.toLowerCase().includes('gain')
  ).length;
  
  return (positive / news.length) || 0.5;
}

function getRecommendation(score, data) {
  const s = parseFloat(score);
  
  if (s >= 8.5) return 'STRONG BUY';
  if (s >= 7.5) return 'BUY';
  if (s >= 6.5) return 'HOLD';
  if (s >= 5.5) return 'REDUCE (Trim 20-30%)';
  return 'EXIT (Sell)';
}

module.exports = calculateMetrics;
