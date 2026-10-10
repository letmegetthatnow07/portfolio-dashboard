// api/portfolio/multibagger.js
//   GET  -> { generatedAt, portfolio: {SYM: result}, watchlist: {SYM: result} }
//   POST { symbol } -> screens one PORTFOLIO stock now (used right after a stock is added)
// The full nightly/manual run lives in backend/scripts/multibagger-screen.js.
import { createClient } from 'redis';
import mb from '../../backend/lib/multibagger.js';

let redisClient = null;
async function getRedisClient() {
  if (!redisClient) {
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', err => console.error('Redis error:', err));
    await redisClient.connect();
  }
  return redisClient;
}
const parse = raw => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const client = await getRedisClient();
    const blob = parse(await client.get(mb.KEY)) || mb.emptyBlob();

    if (req.method === 'GET') return res.status(200).json(blob);
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const symbol = String(req.body?.symbol || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) return res.status(400).json({ error: 'Valid symbol required' });
    if (!process.env.FINNHUB_API_KEY) return res.status(500).json({ error: 'Screening is not configured (missing data key)' });

    const portfolio = parse(await client.get('portfolio')) || { stocks: [] };
    const stock = (portfolio.stocks || []).find(s => s.symbol.toUpperCase() === symbol) || null;
    if (stock && (stock.instrument_type === 'ETF' || stock.type === 'ETF')) {
      return res.status(200).json({ result: { symbol, status: 'NOT_APPLICABLE', verdict: 'NOT_APPLICABLE' } });
    }

    const inputs = await mb.fetchInputs(symbol, process.env.FINNHUB_API_KEY, process.env.FMP_API_KEY || null);
    if (mb.isEtfProfile(inputs.profile)) {
      return res.status(200).json({ result: { symbol, status: 'NOT_APPLICABLE', verdict: 'NOT_APPLICABLE' } });
    }
    const sectorCache = parse(await client.get('sector_health')) || { data: {} };
    const filing = parse(await client.get(`filing_narrative_${symbol}`));
    const earnings = parse(await client.get(`earnings_event_${symbol}`));
    const result = mb.screen({ symbol, ...inputs, stock, filing, earnings, sectorHealth: sectorCache.data, prev: blob.portfolio[symbol] || null, source: 'portfolio' });

    blob.portfolio[symbol] = result;
    await client.set(mb.KEY, JSON.stringify(blob));
    return res.status(200).json({ result });
  } catch (err) {
    console.error('[multibagger API]', err.message);
    return res.status(500).json({ error: 'Screening failed', message: err.message });
  }
}
