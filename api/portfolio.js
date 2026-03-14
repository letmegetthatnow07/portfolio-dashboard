/**
 * GET /api/portfolio
 * Returns all user's stocks with scores
 */

const dataStorage = require('../backend/lib/dataStorage');

export default function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const portfolio = dataStorage.getPortfolioWithScores();
    return res.status(200).json(portfolio);
  } catch (error) {
    console.error('Portfolio API error:', error);
    return res.status(500).json({
      error: 'Failed to fetch portfolio',
      message: error.message
    });
  }
}
