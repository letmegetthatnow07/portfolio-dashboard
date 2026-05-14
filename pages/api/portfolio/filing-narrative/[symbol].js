// pages/api/portfolio/filing-narrative/[symbol].js
//
// Returns the most recent 10-K/10-Q Gemini narrative for a stock.
// Redis key: filing_narrative_{SYMBOL} (written by filing-narrative.js, no TTL)
//
// Response shape:
//   200 — { symbol, mda_summary, risk_factors, evidence_quotes, uncertainty_flags,
//            thesis_status, key_changes, thesis_confirms, moat_strength, form, filed, gemini }
//   204 — no narrative yet (filing-narrative.js hasn't run for this stock)
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
    const raw = await client.get(`filing_narrative_${clean}`).catch(() => null);

    if (!raw) {
      // 204 = narrative not yet generated for this stock (not an error)
      return res.status(204).end();
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: 'Malformed filing narrative data in cache' });
    }

    // Normalise: surface gemini fields at top level for FilingNarrativeCard.
    // Raw payload from filing-narrative.js:
    // { symbol, form, filed, period, gemini: { summary, thesis_risks, evidence_quotes,
    //   uncertainty_flags, thesis_status, key_changes, thesis_confirms,
    //   regulatory_moat_strength, regulatory_moat_type, ... } }
    const g = payload.gemini ?? {};
    return res.status(200).json({
      status:            'success',
      symbol:            clean,
      form:              payload.form              ?? null,
      filed:             payload.filed             ?? null,
      period:            payload.period            ?? null,
      accessionNumber:   payload.accessionNumber   ?? null,
      mdaLength:         payload.mdaLength         ?? null,
      processedAt:       payload.processedAt       ?? null,
      mda_summary:       g.summary                 ?? null,
      risk_factors:      g.thesis_risks             ?? [],
      evidence_quotes:   g.evidence_quotes          ?? [],
      uncertainty_flags: g.uncertainty_flags        ?? [],
      thesis_status:     g.thesis_status            ?? null,
      key_changes:       g.key_changes              ?? [],
      thesis_confirms:   g.thesis_confirms          ?? [],
      moat_strength:     g.regulatory_moat_strength ?? null,
      moat_type:         g.regulatory_moat_type     ?? null,
      gemini:            g,
    });

  } catch (err) {
    console.error(`[filing-narrative API] ${clean}: ${err.message}`);
    return res.status(500).json({ error: 'Failed to retrieve filing narrative', message: err.message });
  }
}
