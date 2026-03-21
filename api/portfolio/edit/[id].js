import { createClient } from 'redis';

let redisClient = null;

async function getRedisClient() {
  if (!redisClient) {
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', err => console.error('Redis error:', err));
    await redisClient.connect();
  }
  return redisClient;
}

export default async function handler(req, res) {
  const { id } = req.query;

  if (req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!id) {
    return res.status(400).json({ error: 'Stock ID is required' });
  }

  try {
    const client = await getRedisClient();

    // ── Read portfolio ───────────────────────────────────────────────────────
    let portfolio = { stocks: [] };
    try {
      const data = await client.get('portfolio');
      if (data) portfolio = JSON.parse(data);
    } catch (e) {
      return res.status(500).json({ error: 'Error reading portfolio' });
    }

    const stockIndex = portfolio.stocks.findIndex(s => s.id === id);
    if (stockIndex < 0) {
      return res.status(404).json({ error: 'Stock not found' });
    }

    const stock = portfolio.stocks[stockIndex];

    // ── Validate and apply editable fields ───────────────────────────────────
    // Only fields the user can meaningfully change from the dashboard are accepted.
    // Symbol is never editable (it defines the instrument).
    // instrument_type_raw and auto-detected fields are preserved.
    const {
      name,
      quantity,
      average_price,
      sector,
      region,
    } = req.body;

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Name must be a non-empty string' });
      }
      stock.name = name.trim();
    }

    if (quantity !== undefined) {
      const qty = parseFloat(quantity);
      if (isNaN(qty) || qty < 0) {
        return res.status(400).json({ error: 'Quantity must be a non-negative number' });
      }
      stock.quantity = qty;
    }

    if (average_price !== undefined) {
      const px = parseFloat(average_price);
      if (isNaN(px) || px < 0) {
        return res.status(400).json({ error: 'Average price must be a non-negative number' });
      }
      stock.average_price = px;
    }

    if (sector !== undefined) {
      stock.sector = typeof sector === 'string' ? sector.trim() : '';
    }

    if (region !== undefined) {
      const VALID_REGIONS = new Set(['Global', 'US', 'Europe', 'Asia', 'EM']);
      stock.region = VALID_REGIONS.has(region) ? region : 'Global';
    }

    // ── instrument_type is NOT editable via edit ──────────────────────────────
    // The type (ETF/Stock) is auto-detected at add time via Finnhub profile2.
    // Allowing free edits here could cause ETFs to be processed as stocks.
    // If a misclassification occurred, delete and re-add the instrument.
    // We explicitly ignore any `type` field passed in req.body.

    stock.updatedAt = new Date().toISOString();
    portfolio.lastUpdated = new Date().toISOString();

    await client.set('portfolio', JSON.stringify(portfolio));

    return res.status(200).json({
      status:  'success',
      message: `${stock.symbol} updated`,
      stock,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Edit stock error:', error);
    return res.status(500).json({
      error:   'Failed to update stock',
      message: error.message,
    });
  }
}
