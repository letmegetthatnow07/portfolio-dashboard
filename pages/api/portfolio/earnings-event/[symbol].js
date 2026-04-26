// pages/api/portfolio/earnings-event/[symbol].js
// Returns the most recent earnings analysis for a stock (stored by earnings-event.js)
// Redis key: earnings_event_{SYMBOL}  TTL: 90 days
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

  // CORS for local dev
  res.setHeader('Cache-Control', 'no-store');

  try {
    const client = await getRedisClient();
    const raw = await client.get(`earnings_event_${clean}`).catch(() => null);

    if (!raw) {
      // 204 No Content — endpoint works but no earnings event found yet.
      // Dashboard shows nothing rather than an error.
      return res.status(204).end();
    }

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: 'Malformed earnings event data in cache' });
    }

    // Safety: if Gemini analysis failed the event still exists but gemini=null
    // Dashboard handles this gracefully — shows filing date/form without analysis.
    return res.status(200).json({
      status:    'success',
      symbol:    clean,
      event,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error(`[earnings-event API] ${clean}: ${error.message}`);
    return res.status(500).json({
      error:   'Failed to retrieve earnings event',
      message: error.message,
    });
  }
}
