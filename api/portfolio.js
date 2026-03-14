/**
 * Portfolio API Endpoint
 * GET /api/portfolio - Returns portfolio with scores
 */

const getPortfolioWithScores = require('../backend/lib/getPortfolioWithScores');

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const portfolio = getPortfolioWithScores();

    // Calculate stats
    const stats = {
      totalStocks: portfolio.length,
      strongBuys: portfolio.filter(p => p.signal === 'STRONG_BUY').length,
      buys: portfolio.filter(p => p.signal === 'BUY').length,
      holds: portfolio.filter(p => p.signal === 'HOLD').length,
      reduces: portfolio.filter(p => p.signal === 'REDUCE').length,
      sells: portfolio.filter(p => p.signal === 'SELL').length,
      averageScore: portfolio.length > 0 
        ? (portfolio.reduce((sum, p) => sum + (p.latest_score || 0), 0) / portfolio.length).toFixed(2)
        : 0
    };

    res.status(200).json({
      status: 'success',
      timestamp: new Date().toISOString(),
      stats: stats,
      portfolio: portfolio
    });

  } catch (error) {
    console.error('Portfolio API error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch portfolio',
      message: error.message 
    });
  }
}
