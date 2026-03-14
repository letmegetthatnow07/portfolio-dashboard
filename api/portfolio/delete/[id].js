/**
 * Delete Stock from Portfolio
 * DELETE /api/portfolio/delete/[id]
 * Professional deletion with proper error handling
 */

const dataStorage = require('../../backend/lib/dataStorage');

export default function handler(req, res) {
  const { id } = req.query;

  // Validate method
  if (req.method !== 'DELETE') {
    return res.status(405).json({ 
      error: 'Method not allowed',
      allowed: ['DELETE']
    });
  }

  try {
    // Validate ID
    if (!id) {
      return res.status(400).json({ error: 'Stock ID is required' });
    }

    // Delete from storage
    const result = dataStorage.deleteStock(id);

    if (!result.success) {
      return res.status(404).json({ 
        error: 'Stock not found',
        message: result.error
      });
    }

    return res.status(200).json({
      status: 'success',
      message: `Stock ${result.stock.symbol} deleted successfully`,
      deletedStock: {
        symbol: result.stock.symbol,
        name: result.stock.name,
        id: result.stock.id
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Delete stock error:', error);
    return res.status(500).json({ 
      error: 'Failed to delete stock',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
}
