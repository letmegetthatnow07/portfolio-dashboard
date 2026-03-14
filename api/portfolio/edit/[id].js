/**
 * Edit Stock in Portfolio
 * PUT /api/portfolio/edit/[id]
 * Properly validates and updates stock with professional error handling
 */

const dataStorage = require('../../backend/lib/dataStorage');

export default function handler(req, res) {
  const { id } = req.query;

  // Validate method
  if (req.method !== 'PUT') {
    return res.status(405).json({ 
      error: 'Method not allowed',
      allowed: ['PUT']
    });
  }

  try {
    // Validate request body
    const { quantity, average_price, type, region, sector, name, current_price } = req.body;

    // Professional validation
    if (!id) {
      return res.status(400).json({ error: 'Stock ID is required' });
    }

    if (quantity !== undefined && (isNaN(quantity) || quantity < 0)) {
      return res.status(400).json({ error: 'Quantity must be a non-negative number' });
    }

    if (average_price !== undefined && (isNaN(average_price) || average_price < 0)) {
      return res.status(400).json({ error: 'Average price must be a non-negative number' });
    }

    if (type && !['Stock', 'ETF', 'Fund', 'Crypto'].includes(type)) {
      return res.status(400).json({ error: 'Invalid stock type' });
    }

    if (region && !['Global', 'US', 'India', 'Europe', 'Asia'].includes(region)) {
      return res.status(400).json({ error: 'Invalid region' });
    }

    // Build update object (only include provided fields)
    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (quantity !== undefined) updates.quantity = parseFloat(quantity);
    if (average_price !== undefined) updates.average_price = parseFloat(average_price);
    if (current_price !== undefined) updates.current_price = parseFloat(current_price);
    if (type !== undefined) updates.type = type;
    if (region !== undefined) updates.region = region;
    if (sector !== undefined) updates.sector = sector.trim();

    // Update in storage
    const result = dataStorage.updateStock(id, updates);

    if (!result.success) {
      return res.status(404).json({ 
        error: 'Stock not found',
        message: result.error
      });
    }

    return res.status(200).json({
      status: 'success',
      message: `Stock ${result.stock.symbol} updated successfully`,
      stock: result.stock,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Edit stock error:', error);
    return res.status(500).json({ 
      error: 'Failed to update stock',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
}
