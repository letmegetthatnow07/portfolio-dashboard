// pages/api/portfolio/earnings-event/[symbol].js
//
// Returns the most recent earnings event analysis for a stock.
// Redis key: earnings_event_{SYMBOL}  TTL: 90 days (written by earnings-event.js)
//
// Response shape:
//   200 — { symbol, geminiSummary, eps_beat, revenue_beat, guidance_direction,
//            thesis_confirms, thesis_risks, quarter, year, estimates, gemini }
//   204 — no earnings event yet (stock hasn't reported — not an error)
//   500 — Redis failure

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
    const raw = await client.get(`earnings_event_${clean}`).catch(() => null);

    if (!raw) {
      // 204 = no data yet, not an error. EarningsCard shows "no earnings event yet".
      return res.status(204).end();
    }

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: 'Malformed earnings event data in cache' });
    }

    // Normalise: surface gemini fields at top level for EarningsCard direct access.
    // Raw payload from earnings-event.js:
    // { symbol, date, quarter, year, estimates, pressRelease,
    //   gemini: { summary, eps_beat, revenue_beat, guidance_direction,
    //             thesis_confirms, thesis_risks, management_confidence } }
    const g = event.gemini ?? {};
    return res.status(200).json({
      status:                'success',
      symbol:                clean,
      geminiSummary:         g.summary                 ?? null,
      eps_beat:              g.eps_beat                ?? null,
      revenue_beat:          g.revenue_beat             ?? null,
      guidance_direction:    g.guidance_direction       ?? null,
      thesis_confirms:       g.thesis_confirms          ?? [],
      thesis_risks:          g.thesis_risks             ?? [],
      management_confidence: g.management_confidence    ?? null,
      quarter:               event.quarter              ?? null,
      year:                  event.year                 ?? null,
      estimates:             event.estimates            ?? {},
      pressRelease:          event.pressRelease         ?? null,
      processedAt:           event.processedAt          ?? null,
      gemini:                g,
    });

  } catch (err) {
    console.error(`[earnings-event API] ${clean}: ${err.message}`);
    return res.status(500).json({ error: 'Failed to retrieve earnings event', message: err.message });
  }
}
