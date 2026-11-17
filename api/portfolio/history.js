// api/portfolio/history.js
//   GET ?symbols=A,B,C&days=30            -> last N calendar days
//   GET ?symbols=A,B,C&from=YYYY-MM-DD&to=YYYY-MM-DD
//   -> { dates: ['2026-09-01', ...] (oldest -> newest),
//        rows:  [{ symbol, data: { 'YYYY-MM-DD': { total_score, fund_score, analyst_score, tech_score, news_score, insider_score, signal, price } } }] }
// Source: Supabase daily_metrics (written nightly by backend/scripts/daily-update.js).
// Needs SUPABASE_URL and SUPABASE_SERVICE_KEY in the Vercel project's environment variables.
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = 1000;   // PostgREST returns at most 1000 rows per request, so page until a short page comes back

let sb = null;
function client() {
  if (!sb) sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { realtime: { transport: ws } });
  return sb;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'History is not configured (missing SUPABASE_URL / SUPABASE_SERVICE_KEY)' });
  }

  const symbols = [...new Set(String(req.query.symbols || '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean))];
  if (!symbols.length) return res.status(400).json({ error: 'symbols is required' });
  if (symbols.length > 60 || symbols.some(s => !SYMBOL_RE.test(s))) return res.status(400).json({ error: 'Invalid symbols' });

  let from, to = null;
  if (req.query.from && req.query.to) {
    if (!DATE_RE.test(req.query.from) || !DATE_RE.test(req.query.to)) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
    from = req.query.from; to = req.query.to;
  } else {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 400);
    from = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  }

  try {
    const all = [];
    for (let start = 0; ; start += PAGE) {
      let q = client().from('daily_metrics')
        .select('symbol, date, price, total_score, fund_score, tech_score, analyst_score, news_score, insider_score, signal')
        .in('symbol', symbols).gte('date', from)
        .order('date', { ascending: true }).order('symbol', { ascending: true })   // deterministic order so pages never overlap or skip
        .range(start, start + PAGE - 1);
      if (to) q = q.lte('date', to);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data || !data.length) break;
      all.push(...data);
      if (data.length < PAGE) break;
    }

    const bySymbol = Object.fromEntries(symbols.map(s => [s, {}]));
    const dates = new Set();
    for (const r of all) {
      const d = String(r.date).slice(0, 10);
      const n = v => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
      // the same date can appear twice if a run was repeated; the later row wins
      bySymbol[r.symbol][d] = {
        total_score: n(r.total_score), fund_score: n(r.fund_score), tech_score: n(r.tech_score),
        analyst_score: n(r.analyst_score), news_score: n(r.news_score), insider_score: n(r.insider_score),
        signal: r.signal || null, price: n(r.price),
      };
      dates.add(d);
    }
    return res.status(200).json({
      dates: [...dates].sort(),
      rows: symbols.map(symbol => ({ symbol, data: bySymbol[symbol] })).filter(r => Object.keys(r.data).length),
    });
  } catch (err) {
    console.error('[history API]', err.message);
    return res.status(500).json({ error: 'Failed to load history', message: err.message });
  }
}
