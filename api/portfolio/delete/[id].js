/**
 * Delete Stock from Portfolio
 * DELETE /api/portfolio/delete/[id]
 */

const Database = require('better-sqlite3');
const path = require('path');

export default function handler(req, res) {
  const { id } = req.query;

  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const dbPath = path.join(process.cwd(), 'data', 'stocks.db');
    const db = new Database(dbPath);

    db.prepare('DELETE FROM portfolio WHERE id = ?').run(parseInt(id));

    db.close();

    res.status(200).json({
      status: 'success',
      message: 'Stock deleted successfully'
    });

  } catch (error) {
    console.error('Delete stock error:', error);
    res.status(500).json({ error: error.message });
  }
}
