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

// GET /api/portfolio/filing-narrative/[symbol]
// Returns the most recent 10-K/10-Q narrative analysis for a symbol.
// No TTL — always returns the latest filing analysis until replaced by the next one.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'Symbol is required' });
  }

  try {
    const client = await getRedisClient();
    const raw = await client.get(`filing_narrative_${symbol.toUpperCase()}`);

    if (!raw) {
      return res.status(200).json({ narrative: null });
    }

    const narrative = JSON.parse(raw);
    return res.status(200).json({ narrative });

  } catch (error) {
    console.error('Filing narrative fetch error:', error);
    return res.status(200).json({ narrative: null }); // fail silently
  }
}
