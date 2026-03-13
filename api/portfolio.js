import Database from 'better-sqlite3';
import path from 'path';

export default function handler(req, res) {
  // Open SQLite database from GitHub storage
  const dbPath = path.join(process.cwd(), 'data', 'stocks.db');
  const db = new Database(dbPath, { readonly: true });
  
  try {
    // Get portfolio with current data
    const portfolio = db.prepare(`
      SELECT 
        p.*,
        s.price,
        s.change,
        s.change_percent,
        s.composite_score,
        s.recommendation,
        s.updated_at
      FROM portfolio p
      LEFT JOIN stock_data s ON p.symbol = s.symbol
      WHERE p.active = 1
      ORDER BY p.region DESC
    `).all();
    
    // Get portfolio stats
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as count,
        SUM(quantity) as total_shares,
        MAX(updated_at) as last_update
      FROM portfolio
      WHERE active = 1
    `).get();
    
    res.status(200).json({
      success: true,
      portfolio,
      stats,
      lastUpdated: stats.last_update
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    db.close();
  }
}
