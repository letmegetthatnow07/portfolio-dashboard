// api/portfolio/history.js
// Returns daily score history for all portfolio stocks.
// Reads from Supabase daily_metrics table (written by daily-update.js each EOD).
//
// Query params:
//   symbols  — comma-separated list of tickers  (required)
//   days     — last N trading days (default 15, max 90)
//   from     — ISO date YYYY-MM-DD (custom range start)
//   to       — ISO date YYYY-MM-DD (custom range end)
//
// Response:
//   { dates: ['2026-05-01', ...], rows: [{ symbol, data: { '2026-05-01': { total_score, fund_score, ... } } }] }

'use strict';

const { createClient } = require('@supabase/supabase-js');
const _ws = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: _ws } }
);

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Cache-Control', 'no-store');

  // ── Parse params ────────────────────────────────────────────────────────────
  const rawSymbols = (req.query.symbols || '').trim();
  if (!rawSymbols) return res.status(400).json({ error: 'symbols param required' });

  const symbols = rawSymbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'No valid symbols' });

  const MAX_DAYS = 90;
  let fromDate, toDate;

  if (req.query.from && req.query.to) {
    // Custom date range
    fromDate = req.query.from;
    toDate   = req.query.to;
  } else {
    // Last N days
    const days = Math.min(parseInt(req.query.days, 10) || 15, MAX_DAYS);
    const to   = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days - 10); // add buffer for weekends/holidays
    fromDate = from.toISOString().split('T')[0];
    toDate   = to.toISOString().split('T')[0];
  }

  try {
    // ── Fetch from Supabase ────────────────────────────────────────────────────
    const { data, error } = await supabase
      .from('daily_metrics')
      .select('symbol, date, total_score, fund_score, tech_score, analyst_score, news_score, insider_score, signal, price')
      .in('symbol', symbols)
      .gte('date', fromDate)
      .lte('date', toDate)
      .order('date', { ascending: true });

    if (error) {
      console.error('[history API] Supabase error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    if (!data || !data.length) {
      return res.status(200).json({ dates: [], rows: [] });
    }

    // ── Build response shape ──────────────────────────────────────────────────
    // Collect all unique dates (already sorted ascending from Supabase)
    const dateSet = new Set();
    data.forEach(row => dateSet.add(row.date));
    const allDates = Array.from(dateSet).sort();

    // Limit to requested N days (trim from front after removing weekend gaps)
    const days = parseInt(req.query.days, 10) || 15;
    const dates = req.query.from && req.query.to
      ? allDates
      : allDates.slice(-Math.min(days, MAX_DAYS));

    // Build per-symbol data map
    const bySymbol = {};
    for (const sym of symbols) bySymbol[sym] = {};

    for (const row of data) {
      if (!bySymbol[row.symbol]) continue;
      bySymbol[row.symbol][row.date] = {
        total_score:   row.total_score   != null ? parseFloat(row.total_score.toFixed(2))   : null,
        fund_score:    row.fund_score    != null ? parseFloat(row.fund_score.toFixed(2))    : null,
        tech_score:    row.tech_score    != null ? parseFloat(row.tech_score.toFixed(2))    : null,
        analyst_score: row.analyst_score != null ? parseFloat(row.analyst_score.toFixed(2)) : null,
        news_score:    row.news_score    != null ? parseFloat(row.news_score.toFixed(2))    : null,
        insider_score: row.insider_score != null ? parseFloat(row.insider_score.toFixed(2)) : null,
        signal:        row.signal        ?? null,
        price:         row.price         != null ? parseFloat(parseFloat(row.price).toFixed(2)) : null,
      };
    }

    const rows = symbols
      .filter(sym => Object.keys(bySymbol[sym]).length > 0) // skip symbols with no data
      .map(sym => ({ symbol: sym, data: bySymbol[sym] }));

    return res.status(200).json({ dates, rows });

  } catch (err) {
    console.error('[history API] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
