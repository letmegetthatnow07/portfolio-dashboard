// api/portfolio/watchlist.js  — the Screener tab's list of checked stocks
//   GET                         -> { entries: [{symbol,name,addedAt,status,screenedAt}], results: {SYM: fullResult} }
//   POST {symbol}               -> add (status PENDING). ETFs are rejected: screener is for stocks only.
//   POST ?action=screen&symbol= -> run the screen for one stock now (UI "Run screen" calls this per stock)
//   DELETE ?symbol=             -> remove
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
const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const client = await getRedisClient();
    const wl = parse(await client.get('watchlist')) || { entries: [] };
    const blob = parse(await client.get(mb.KEY)) || mb.emptyBlob();

    if (req.method === 'GET') return res.status(200).json({ entries: wl.entries, results: blob.watchlist });

    const key = process.env.FINNHUB_API_KEY;
    if (req.method === 'POST') {
      const action = req.query.action;
      const symbol = String(req.query.symbol || req.body?.symbol || '').trim().toUpperCase();
      if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ error: 'Enter a valid ticker symbol' });
      if (!key) return res.status(500).json({ error: 'Screening is not configured (missing data key)' });

      if (action === 'screen') {
        const entry = wl.entries.find(e => e.symbol === symbol);
        if (!entry) return res.status(404).json({ error: `${symbol} is not on the list` });
        const inputs = await mb.fetchInputs(symbol, key, process.env.FMP_API_KEY || null);
        if (mb.isEtfProfile(inputs.profile)) return res.status(400).json({ error: `${symbol} is an ETF. The screener is for individual stocks only.` });
        const sectorCache = parse(await client.get('sector_health')) || { data: {} };
        const filing = parse(await client.get(`filing_narrative_${symbol}`));
        const earnings = parse(await client.get(`earnings_event_${symbol}`));
        const result = mb.screen({ symbol, ...inputs, filing, earnings, sectorHealth: sectorCache.data, prev: blob.watchlist[symbol] || null, source: 'watchlist' });
        blob.watchlist[symbol] = result;
        entry.status = mb.statusOf(result);
        entry.screenedAt = result.asOf;
        entry.name = result.name || entry.name;
        await client.set('watchlist', JSON.stringify(wl));
        await client.set(mb.KEY, JSON.stringify(blob));
        return res.status(200).json({ entry, result });
      }

      // add
      if (wl.entries.some(e => e.symbol === symbol)) return res.status(400).json({ error: `${symbol} is already on the list` });
      const profile = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${key}`, { signal: AbortSignal.timeout(8000) })
        .then(r => (r.ok ? r.json() : {})).catch(() => ({}));
      if (mb.isEtfProfile(profile)) return res.status(400).json({ error: `${symbol} is an ETF. The screener is for individual stocks only.` });
      if (!profile?.name) return res.status(404).json({ error: `Could not find ticker ${symbol}` });
      const entry = { symbol, name: profile.name, addedAt: new Date().toISOString(), status: 'PENDING', screenedAt: null };
      wl.entries.unshift(entry);
      await client.set('watchlist', JSON.stringify(wl));
      return res.status(201).json({ entry });
    }

    if (req.method === 'DELETE') {
      const symbol = String(req.query.symbol || '').trim().toUpperCase();
      wl.entries = wl.entries.filter(e => e.symbol !== symbol);
      delete blob.watchlist[symbol];
      await client.set('watchlist', JSON.stringify(wl));
      await client.set(mb.KEY, JSON.stringify(blob));
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[watchlist API]', err.message);
    return res.status(500).json({ error: 'Request failed', message: err.message });
  }
}
