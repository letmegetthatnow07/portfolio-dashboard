import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  const { id } = req.query;

  try {
    if (req.method !== 'PUT') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!id) {
      return res.status(400).json({ error: 'Stock ID is required' });
    }

    const { name, quantity, average_price, current_price, type, region, sector } = req.body;

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

    // Find and update stock
    const stockIndex = portfolio.stocks.findIndex(s => s.id === id);
    if (stockIndex < 0) {
      return res.status(404).json({ error: 'Stock not found' });
    }

    const stock = portfolio.stocks[stockIndex];
    
    if (name !== undefined) stock.name = name;
    if (quantity !== undefined) stock.quantity = parseFloat(quantity);
    if (average_price !== undefined) stock.average_price = parseFloat(average_price);
    if (current_price !== undefined) stock.current_price = parseFloat(current_price);
    if (type !== undefined) stock.type = type;
    if (region !== undefined) stock.region = region;
    if (sector !== undefined) stock.sector = sector;
    
    stock.updatedAt = new Date().toISOString();

    // Write back
    portfolio.lastUpdated = new Date().toISOString();
    fs.writeFileSync(dataFile, JSON.stringify(portfolio, null, 2));

    return res.status(200).json({
      status: 'success',
      message: `Stock ${stock.symbol} updated`,
      stock,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Edit stock error:', error);
    return res.status(500).json({
      error: 'Failed to update stock',
      message: error.message
    });
  }
}
