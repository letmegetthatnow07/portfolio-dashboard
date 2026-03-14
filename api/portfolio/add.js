/**
 * Add New Stock to Portfolio
 * POST /api/portfolio/add
 * Professional creation with validation
 */

const dataStorage = require('../../backend/lib/dataStorage');

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      error: 'Method not allowed',
      allowed: ['POST']
    });
  }

  try {
    const { symbol, name, type, region, sector, quantity, average_price } = req.body;

    // Professional validation
    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ error: 'Symbol is required and must be a string' });
    }

    const cleanSymbol = symbol.trim().toUpperCase();

    if (cleanSymbol.length === 0 || cleanSymbol.length > 10) {
      return res.status(400).json({ error: 'Symbol must be 1-10 characters' });
    }

    if (type && !['Stock', 'ETF', 'Fund', 'Crypto'].includes(type)) {
      return res.status(400).json({ error: 'Invalid stock type' });
    }

    if (region && !['Global', 'US', 'India', 'Europe', 'Asia'].includes(region)) {
      return res.status(400).json({ error: 'Invalid region' });
    }

    if (quantity !== undefined && (isNaN(quantity) || quantity < 0)) {
      return res.status(400).json({ error: 'Quantity must be non-negative' });
    }

    if (average_price !== undefined && (isNaN(average_price) || average_price < 0)) {
      return res.status(400).json({ error: 'Average price must be non-negative' });
    }

    // Add stock
    const result = dataStorage.addStock(cleanSymbol, {
      name: name || cleanSymbol,
      type: type || 'Stock',
      region: region || 'Global',
      sector: sector || '',
      quantity: quantity ? parseFloat(quantity) : 0,
      average_price: average_price ? parseFloat(average_price) : 0
    });

    if (!result.success) {
      return res.status(400).json({ 
        error: 'Failed to add stock',
        message: result.error
      });
    }

    return res.status(201).json({
      status: 'success',
      message: `Stock ${cleanSymbol} added successfully`,
      stock: result.stock,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Add stock error:', error);
    return res.status(500).json({ 
      error: 'Failed to add stock',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
}
