/**
 * Add Stock to Portfolio
 * POST /api/portfolio/add
 */

const Database = require('better-sqlite3');
const path = require('path');

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { symbol, name, quantity, average_price, type, region, sector } = req.body;

    if (!symbol || !quantity || !average_price) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const dbPath = path.join(process.cwd(), 'data', 'stocks.db');
    const db = new Database(dbPath);

    const result = db.prepare(`
      INSERT INTO portfolio (symbol, name, quantity, average_price, type, region, sector)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      symbol.toUpperCase(),
      name || symbol,
      parseFloat(quantity),
      parseFloat(average_price),
      type || 'Stock',
      region || 'Global',
      sector || ''
    );

    db.close();

    res.status(200).json({
      status: 'success',
      message: 'Stock added successfully',
      id: result.lastInsertRowid
    });

  } catch (error) {
    console.error('Add stock error:', error);
    res.status(500).json({ error: error.message });
  }
}
