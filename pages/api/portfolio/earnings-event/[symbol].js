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

// GET /api/portfolio/earnings-event/[symbol]
// Returns the most recent earnings event for a symbol if within 90-day TTL.
// Returns { event: null } if no earnings event exists.
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
    const raw = await client.get(`earnings_event_${symbol.toUpperCase()}`);

    if (!raw) {
      return res.status(200).json({ event: null });
    }

    const event = JSON.parse(raw);
    return res.status(200).json({ event });

  } catch (error) {
    console.error('Earnings event fetch error:', error);
    return res.status(200).json({ event: null }); // fail silently — non-critical
  }
}
