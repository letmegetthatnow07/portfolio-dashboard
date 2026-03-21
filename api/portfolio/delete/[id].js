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

  if (req.method !== 'DELETE') {
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

    const deletedStock = portfolio.stocks.splice(stockIndex, 1)[0];
    portfolio.lastUpdated = new Date().toISOString();

    // ── Save updated portfolio ────────────────────────────────────────────────
    await client.set('portfolio', JSON.stringify(portfolio));

    // ── Mark correlation matrix stale ─────────────────────────────────────────
    // The correlation engine reads from historical_prices.csv + Supabase,
    // which still contain the deleted ticker's history. We set a stale flag
    // so the UI can show "matrix may be stale — recalculate" instead of
    // showing a matrix that includes the deleted stock.
    // The flag is cleared when generate-correlation.js next runs successfully.
    try {
      const existing = await client.get('portfolio_correlation');
      if (existing) {
        const matrix = JSON.parse(existing);
        matrix.stale = true;
        matrix.staleReason = `${deletedStock.symbol} was removed from portfolio`;
        matrix.staleSince  = new Date().toISOString();
        await client.set('portfolio_correlation', JSON.stringify(matrix));
      }
    } catch (e) {
      // Non-fatal — stale flag is cosmetic, not functional
      console.warn('Could not mark correlation matrix stale:', e.message);
    }

    // ── Also clean up the deleted stock's Redis key if it exists ─────────────
    // Some implementations store per-stock data separately
    try {
      await client.del(`stock:${deletedStock.symbol}`);
    } catch (e) { /* non-fatal */ }

    return res.status(200).json({
      status:  'success',
      message: `${deletedStock.symbol} removed from portfolio`,
      deletedStock,
      note:    'Correlation matrix will update on next scheduled recalculation.',
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Delete stock error:', error);
    return res.status(500).json({
      error:   'Failed to delete stock',
      message: error.message,
    });
  }
}
