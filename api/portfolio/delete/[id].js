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
  const { id } = req.query;

  try {
    if (req.method !== 'DELETE') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!id) {
      return res.status(400).json({ error: 'Stock ID is required' });
    }

    const client = await getRedisClient();
    let portfolio = { stocks: [] };

    try {
      const data = await client.get('portfolio');
      if (data) {
        portfolio = JSON.parse(data);
      }
    } catch (e) {
      return res.status(500).json({ error: 'Error reading portfolio' });
    }

    const stockIndex = portfolio.stocks.findIndex(s => s.id === id);
    if (stockIndex < 0) {
      return res.status(404).json({ error: 'Stock not found' });
    }

    const deletedStock = portfolio.stocks.splice(stockIndex, 1)[0];

    portfolio.lastUpdated = new Date().toISOString();
    await client.set('portfolio', JSON.stringify(portfolio));

    return res.status(200).json({
      status: 'success',
      message: `Stock ${deletedStock.symbol} deleted`,
      deletedStock,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Delete stock error:', error);
    return res.status(500).json({
      error: 'Failed to delete stock',
      message: error.message
    });
  }
}
