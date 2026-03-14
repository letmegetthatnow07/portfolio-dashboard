/**
 * Portfolio API Endpoint
 * GET /api/portfolio - Returns portfolio with scores
 */

const dataStorage = require('../backend/lib/dataStorage');

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const portfolioData = dataStorage.getPortfolioWithScores();
    res.status(200).json(portfolioData);
  } catch (error) {
    console.error('Portfolio API error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch portfolio',
      message: error.message 
    });
  }
}
