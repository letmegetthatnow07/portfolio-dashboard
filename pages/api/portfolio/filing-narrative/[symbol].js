// pages/api/portfolio/filing-narrative/[symbol].js
// Returns the most recent 10-K/10-Q Gemini narrative for a stock.
// Stored by filing-narrative.js under Redis key: filing_narrative_{SYMBOL}
// Called by DetailPanel when expanding a stock row.

import { createClient } from 'redis';

let redisClient = null;
async function getRedisClient() {
  if (!redisClient) {
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', err => console.error('Redis error:', err));
    await redisClient.connect();
  }
  return redisClient;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { symbol } = req.query;
  if (!symbol || typeof symbol !== 'string') {
    return res.status(400).json({ error: 'Symbol is required' });
  }

  const clean = symbol.trim().toUpperCase();

  res.setHeader('Cache-Control', 'no-store');

  try {
    const client = await getRedisClient();
    const raw = await client.get(`filing_narrative_${clean}`).catch(() => null);

    if (!raw) {
      return res.status(204).end();
    }

    let narrative;
    try {
      narrative = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: 'Malformed filing narrative data in cache' });
    }

    return res.status(200).json({
      status:    'success',
      symbol:    clean,
      narrative,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error(`[filing-narrative API] ${clean}: ${error.message}`);
    return res.status(500).json({
      error:   'Failed to retrieve filing narrative',
      message: error.message,
    });
  }
}
