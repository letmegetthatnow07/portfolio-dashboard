export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { symbol, name, type, region, sector, quantity, average_price } = req.body;

    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ error: 'Symbol is required' });
    }

    const cleanSymbol = symbol.trim().toUpperCase();

    if (cleanSymbol.length === 0 || cleanSymbol.length > 10) {
      return res.status(400).json({ error: 'Symbol must be 1-10 characters' });
    }

    // Try to use Vercel KV first
    let portfolio = { stocks: [], lastUpdated: null };
    
    try {
      const { kv } = await import('@vercel/kv');
      
      try {
        const stored = await kv.get('portfolio');
        if (stored) {
          portfolio = stored;
        }
      } catch (kvError) {
        console.warn('KV read failed, using empty portfolio:', kvError.message);
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

      portfolio.stocks.push(newStock);
      portfolio.lastUpdated = new Date().toISOString();

      // Save to KV
      try {
        await kv.set('portfolio', portfolio);
      } catch (kvError) {
        console.warn('KV write failed:', kvError.message);
        // Continue anyway - KV might be connecting
      }

      return res.status(201).json({
        status: 'success',
        message: `Stock ${cleanSymbol} added successfully`,
        stock: newStock,
        timestamp: new Date().toISOString()
      });

    } catch (importError) {
      console.error('Failed to import KV:', importError.message);
      return res.status(500).json({
        error: 'Database not configured',
        message: 'KV storage not available'
      });
    }

  } catch (error) {
    console.error('Add stock error:', error);
    return res.status(500).json({
      error: 'Failed to add stock',
      message: error.message
    });
  }
}
