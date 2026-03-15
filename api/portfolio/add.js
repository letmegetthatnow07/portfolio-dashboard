import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  try {
    console.log('Add stock request received:', req.method, req.body);

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { symbol, name, type, region, sector, quantity, average_price } = req.body;

    console.log('Request data:', { symbol, name, type, region, sector });

    // Validate symbol
    if (!symbol) {
      return res.status(400).json({ 
        error: 'Symbol is required',
        received: req.body 
      });
    }

    if (typeof symbol !== 'string') {
      return res.status(400).json({ error: 'Symbol must be a string' });
    }

    const cleanSymbol = symbol.trim().toUpperCase();

    if (cleanSymbol.length === 0) {
      return res.status(400).json({ error: 'Symbol cannot be empty' });
    }

    if (cleanSymbol.length > 10) {
      return res.status(400).json({ error: 'Symbol must be 10 characters or less' });
    }

    console.log('Cleaned symbol:', cleanSymbol);

    // Get portfolio from KV
    let portfolio = { stocks: [], lastUpdated: null };
    
    try {
      const stored = await kv.get('portfolio');
      if (stored) {
        portfolio = stored;
        console.log('Retrieved portfolio with', portfolio.stocks.length, 'stocks');
      } else {
        console.log('No portfolio found in KV, starting fresh');
      }
    } catch (kvError) {
      console.error('KV read error:', kvError.message);
      // Continue with empty portfolio if KV fails
    }

    // Check for duplicates
    if (portfolio.stocks && portfolio.stocks.find(s => s.symbol === cleanSymbol)) {
      return res.status(400).json({ error: `Stock ${cleanSymbol} already in portfolio` });
    }

    // Create new stock
    const newStock = {
      id: Date.now().toString(),
      symbol: cleanSymbol,
      name: (name || cleanSymbol).trim(),
      type: type || 'Stock',
      region: region || 'Global',
      sector: (sector || '').trim(),
      quantity: quantity ? parseFloat(quantity) || 0 : 0,
      average_price: average_price ? parseFloat(average_price) || 0 : 0,
      current_price: 0,
      change_percent: 0,
      latest_score: 5,
      signal: 'HOLD',
      confidence: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    console.log('Created new stock:', newStock);

    // Add to portfolio
    if (!portfolio.stocks) {
      portfolio.stocks = [];
    }
    portfolio.stocks.push(newStock);
    portfolio.lastUpdated = new Date().toISOString();

    // Save to KV
    try {
      await kv.set('portfolio', portfolio);
      console.log('Successfully saved portfolio to KV');
    } catch (kvError) {
      console.error('KV write error:', kvError.message);
      return res.status(500).json({
        error: 'Failed to save to database',
        message: kvError.message
      });
    }

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
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
