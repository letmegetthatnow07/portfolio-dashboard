import { createClient } from 'redis';

let redisClient = null;

async function getRedisClient() {
  if (!redisClient) {
    redisClient = createClient({
      url: process.env.REDIS_URL
    });
    
    redisClient.on('error', (err) => console.error('Redis error:', err));
    await redisClient.connect();
  }
  return redisClient;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const client = await getRedisClient();
    let portfolio = { stocks: [], lastUpdated: null };

    try {
      const data = await client.get('portfolio');
      if (data) {
        portfolio = JSON.parse(data);
      }
    } catch (e) {
      console.error('Redis read error:', e);
    }

    const stocks = portfolio.stocks || [];
    const stats = {
      totalStocks: stocks.length,
      strongBuys: stocks.filter(s => s.signal === 'STRONG_BUY').length,
      buys: stocks.filter(s => s.signal === 'BUY').length,
      holds: stocks.filter(s => s.signal === 'HOLD').length,
      reduces: stocks.filter(s => s.signal === 'REDUCE').length,
      sells: stocks.filter(s => s.signal === 'SELL').length,
      averageScore: stocks.length > 0
        ? (stocks.reduce((sum, s) => sum + (s.latest_score || 0), 0) / stocks.length).toFixed(2)
        : 0
    };

    return res.status(200).json({
      status: 'success',
      timestamp: new Date().toISOString(),
      stats,
      portfolio: stocks
    });

  } catch (error) {
    console.error('Portfolio API error:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to fetch portfolio',
      error: error.message
    });
  }
}
