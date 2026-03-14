/**
 * Edit Stock in Portfolio
 * PUT /api/portfolio/edit/[id]
 */

const Database = require('better-sqlite3');
const path = require('path');

export default function handler(req, res) {
  const { id } = req.query;

  if (req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { quantity, average_price, type, region, sector } = req.body;

    const dbPath = path.join(process.cwd(), 'data', 'stocks.db');
    const db = new Database(dbPath);

    db.prepare(`
      UPDATE portfolio 
      SET quantity = ?, average_price = ?, type = ?, region = ?, sector = ?
      WHERE id = ?
    `).run(
      parseFloat(quantity),
      parseFloat(average_price),
      type,
      region,
      sector,
      parseInt(id)
    );

    db.close();

    res.status(200).json({
      status: 'success',
      message: 'Stock updated successfully'
    });

  } catch (error) {
    console.error('Edit stock error:', error);
    res.status(500).json({ error: error.message });
  }
}
