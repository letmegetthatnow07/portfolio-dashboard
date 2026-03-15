import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const { id } = req.query;

  try {
    if (req.method !== 'DELETE') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!id) {
      return res.status(400).json({ error: 'Stock ID is required' });
    }

    // Get portfolio from KV
    let portfolio = { stocks: [] };
    try {
      const stored = await kv.get('portfolio');
      if (stored) {
        portfolio = stored;
      }
    } catch (e) {
      return res.status(500).json({ error: 'Error reading portfolio' });
    }

    // Find stock to delete
    const stockIndex = portfolio.stocks.findIndex(s => s.id === id);
    if (stockIndex < 0) {
      return res.status(404).json({ error: 'Stock not found' });
    }

    const deletedStock = portfolio.stocks.splice(stockIndex, 1)[0];

    // Save to KV
    portfolio.lastUpdated = new Date().toISOString();
    await kv.set('portfolio', portfolio);

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
