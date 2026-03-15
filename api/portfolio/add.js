import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { symbol, name, type, region, sector, quantity, average_price } = req.body;

    // Validate input
    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ error: 'Symbol is required' });
    }

    const cleanSymbol = symbol.trim().toUpperCase();

    if (cleanSymbol.length === 0 || cleanSymbol.length > 10) {
      return res.status(400).json({ error: 'Symbol must be 1-10 characters' });
    }

    // Initialize data directory
    const dataDir = path.join(process.cwd(), 'data');
    const dataFile = path.join(dataDir, 'portfolio-data.json');

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Read existing portfolio
    let portfolio = { stocks: [], lastUpdated: null };
    
    if (fs.existsSync(dataFile)) {
      try {
        const data = fs.readFileSync(dataFile, 'utf8');
        portfolio = JSON.parse(data);
      } catch (e) {
        console.error('Error reading portfolio:', e);
      }
    }

    // Check if stock already exists
    if (portfolio.stocks.find(s => s.symbol === cleanSymbol)) {
      return res.status(400).json({ error: 'Stock already in portfolio' });
    }

    // Create new stock
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

    // Add to portfolio
    portfolio.stocks.push(newStock);
    portfolio.lastUpdated = new Date().toISOString();

    // Write to file
    fs.writeFileSync(dataFile, JSON.stringify(portfolio, null, 2));

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
