/**
 * POST /api/portfolio/add
 * Adds new stock to portfolio
 * Body: { symbol, name, type, region, quantity, average_price }
 */

const dataStorage = require('../../backend/lib/dataStorage');

export default function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { symbol, name, type, region, quantity, average_price } = req.body;

    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required' });
    }

    const result = dataStorage.addStock(symbol, {
      name: name || symbol,
      type: type || 'Stock',
      region: region || 'Global',
      quantity: quantity || 0,
      average_price: average_price || 0
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    return res.status(201).json({
      success: true,
      message: `Stock ${symbol} added`,
      stock: result.stock
    });
  } catch (error) {
    console.error('Add stock error:', error);
    return res.status(500).json({
      error: 'Failed to add stock',
      message: error.message
    });
  }
}
