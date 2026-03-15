import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const { id } = req.query;

  try {
    if (req.method !== 'DELETE') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!id) {
      return res.status(400).json({ error: 'Stock ID is required' });
    }

    // Initialize data
    const dataDir = path.join(process.cwd(), 'data');
    const dataFile = path.join(dataDir, 'portfolio-data.json');

    if (!fs.existsSync(dataFile)) {
      return res.status(404).json({ error: 'Portfolio not found' });
    }

    // Read portfolio
    let portfolio = { stocks: [] };
    try {
      const data = fs.readFileSync(dataFile, 'utf8');
      portfolio = JSON.parse(data);
    } catch (e) {
      return res.status(500).json({ error: 'Error reading portfolio' });
    }

    // Find stock to delete
    const stockIndex = portfolio.stocks.findIndex(s => s.id === id);
    if (stockIndex < 0) {
      return res.status(404).json({ error: 'Stock not found' });
    }

    const deletedStock = portfolio.stocks.splice(stockIndex, 1)[0];

    // Write back
    portfolio.lastUpdated = new Date().toISOString();
    fs.writeFileSync(dataFile, JSON.stringify(portfolio, null, 2));

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
