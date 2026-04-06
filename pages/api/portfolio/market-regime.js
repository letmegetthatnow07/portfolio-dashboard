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

// GET /api/portfolio/market-regime
// Returns the SPY-based market regime (NORMAL / STRESSED / BEAR)
// Written once per EOD run by daily-update.js
// Dashboard uses this to apply regime-aware position sizing caps
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const client = await getRedisClient();
    const raw = await client.get('market_regime');
    if (!raw) return res.status(200).json({ regime: 'NORMAL', spy21d: 0, date: null });
    return res.status(200).json(JSON.parse(raw));
  } catch (err) {
    console.error('Market regime fetch error:', err);
    return res.status(200).json({ regime: 'NORMAL', spy21d: 0, date: null });
  }
}
