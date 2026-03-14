/**
 * Get Portfolio with Latest Scores
 * Fetches portfolio + latest composite scores from database
 */

const Database = require('better-sqlite3');
const path = require('path');

function getPortfolioWithScores() {
  try {
    const dbPath = path.join(__dirname, '../../data/stocks.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // Get portfolio with latest scores
    const query = `
      SELECT 
        p.symbol,
        p.name,
        p.type,
        p.region,
        p.quantity,
        p.average_price,
        p.sector,
        sd.price as current_price,
        sd.change,
        sd.change_percent,
        sd.composite_score,
        sd.recommendation,
        ms.composite_score as latest_score,
        ms.composite_confidence as confidence,
        ms.primary_signal as signal,
        ms.analyst_price_target,
        ms.upside_downside_percent,
        ms.analyst_rating_score,
        ms.news_sentiment_score,
        ms.technical_score,
        ms.insider_score,
        ms.filing_health_score,
        ms.date as score_date
      FROM portfolio p
      LEFT JOIN stock_data sd ON p.symbol = sd.symbol
      LEFT JOIN (
        SELECT * FROM metric_scores 
        WHERE date = (SELECT MAX(date) FROM metric_scores)
      ) ms ON p.symbol = ms.symbol
      WHERE p.active = 1
      ORDER BY 
        CASE 
          WHEN ms.primary_signal = 'STRONG_BUY' THEN 1
          WHEN ms.primary_signal = 'BUY' THEN 2
          WHEN ms.primary_signal = 'HOLD' THEN 3
          WHEN ms.primary_signal = 'REDUCE' THEN 4
          ELSE 5
        END,
        ms.composite_score DESC
    `;

    const portfolio = db.prepare(query).all();
    db.close();

    return portfolio;
  } catch (error) {
    console.error('Error fetching portfolio with scores:', error.message);
    return [];
  }
}

module.exports = getPortfolioWithScores;
