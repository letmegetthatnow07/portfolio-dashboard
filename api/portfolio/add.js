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
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { symbol, name, type, region, sector, quantity, average_price } = req.body;

    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ error: 'Symbol is required' });
    }

    const cleanSymbol = symbol.trim().toUpperCase();

    if (cleanSymbol.length === 0 || cleanSymbol.length > 10) {
      return res.status(400).json({ error: 'Symbol must be 1-10 characters' });
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

    if (portfolio.stocks.find(s => s.symbol === cleanSymbol)) {
      return res.status(400).json({ error: 'Stock already in portfolio' });
    }

    const newStock = {
      id: Date.now().toString(),
      symbol: cleanSymbol,
      name: name || cleanSymbol,
      type: type || 'Stock',
      region: region || 'Global',
      sector: sector || '',
      quantity: quantity ? parseFloat(quantity) : 0,
      average_price: average_price ? parseFloat(average_price) : 0,
      current_price: 0,
      change_percent: 0,
      latest_score: 5,
      signal: 'HOLD',
      confidence: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    portfolio.stocks.push(newStock);
    portfolio.lastUpdated = new Date().toISOString();

    await client.set('portfolio', JSON.stringify(portfolio));

    return res.status(201).json({
      status: 'success',
      message: `Stock ${cleanSymbol} added successfully`,
      stock: newStock,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Add stock error:', error);
    return res.status(500).json({
      error: 'Failed to add stock',
      message: error.message
    });
  }
}
