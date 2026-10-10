#!/usr/bin/env node
'use strict';
/**
 * MULTIBAGGER SCREEN RUNNER — nightly (after the EOD master run) or manual.
 * (The methodology/formulas live in backend/lib/multibagger.js.)
 *
 *   npm run multibagger                 # portfolio + pending/stale watchlist
 *   npm run multibagger -- --force      # re-screen everything (ignores the 7-day cache)
 *   npm run multibagger -- --only=CRWD  # one symbol
 *
 * Reads : Redis portfolio, watchlist, filing_narrative_*, earnings_event_*, sector_health, sector_fundamentals
 * Calls : Finnhub (2/stock + 5/sector/week), FMP estimates (1/stock, optional), Polygon (1/sector ETF/day, 1/PASS stock/week)
 * Writes: Redis multibagger_screen, watchlist (statuses), sector_health, sector_fundamentals
 * ETFs are skipped: this screen is for individual operating companies only.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { createClient } = require('redis');
const mb = require('../lib/multibagger');

const SLEEP_MS = 2500;                        // 2 Finnhub calls/stock => ~48 calls/min (free limit 60)
const POLY_SLEEP_MS = 13000;                  // Polygon free tier: 5 calls/min
const WATCHLIST_MAX = Number(process.env.WATCHLIST_MAX_PER_RUN) || 60;
const TIMING_MAX = 8;                         // entry-timing overlays per run (Polygon calls)
const args = process.argv.slice(2);
const FORCE = args.includes('--force') || process.env.FORCE_RUN === 'true';
const ONLY = (args.find(a => a.startsWith('--only=')) || '').split('=')[1]?.toUpperCase() || null;
const DAY = 86400000;
const iso = d => d.toISOString().split('T')[0];
const parse = raw => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

async function polygonBars(sym, key) {
  const end = new Date(), start = new Date();
  start.setFullYear(start.getFullYear() - 1); start.setDate(start.getDate() - 10);
  const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${iso(start)}/${iso(end)}?adjusted=true&sort=asc&limit=400&apiKey=${key}`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Polygon ${sym} HTTP ${res.status}`);
  return ((await res.json()).results || []).map(r => ({ c: r.c, t: r.t }));
}

async function main() {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) { console.error('FINNHUB_API_KEY missing'); process.exit(1); }
  const fmpKey = process.env.FMP_API_KEY || null, polyKey = process.env.POLYGON_API_KEY || null;

  const redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', e => console.error('Redis:', e.message));
  await redis.connect();

  const blob = parse(await redis.get(mb.KEY)) || mb.emptyBlob();
  const portfolio = parse(await redis.get('portfolio')) || { stocks: [] };
  const sectorCache = parse(await redis.get('sector_health')) || { data: {} };
  const sectorFund = parse(await redis.get('sector_fundamentals')) || { data: {} };
  const sectorData = {};
  let spyBars = null, timingLeft = TIMING_MAX;

  // Sector FUNDAMENTAL leg: median growth + forward-EPS expectation of representative constituents (weekly)
  async function ensureSectorFund(etf) {
    const fc = sectorFund.data[etf];
    if (fc && Date.now() - new Date(fc.asOf).getTime() < 7 * DAY) return fc.assessment;
    const metrics = [];
    for (const sym of mb.SECTOR_CONSTITUENTS[etf] || []) {
      try { const j = await mb.finnhub('/stock/metric', { symbol: sym, metric: 'all' }, token); if (j?.metric) metrics.push(j.metric); } catch (e) { console.warn(`  sector ${etf}/${sym}: ${e.message}`); }
      await mb.sleep(1300);
    }
    const history = fc?.history || [];
    const assessment = mb.assessSectorFundamentals(metrics, history);
    if (assessment?.medFwdEps != null) history.push({ asOf: new Date().toISOString(), medFwdEps: assessment.medFwdEps });
    sectorFund.data[etf] = { asOf: new Date().toISOString(), assessment, history: history.slice(-12) };
    return assessment;
  }
  // Sector PRICE leg (daily) + fundamental leg (weekly) -> one cached entry per ETF
  async function ensureSector(etf) {
    if (!etf) return;
    const hit = sectorCache.data[etf];
    if (hit && Date.now() - new Date(hit.asOf).getTime() < DAY) { sectorData[etf] = hit; return; }
    const entry = { asOf: new Date().toISOString(), price: hit?.price || null, fund: null };
    if (polyKey) {
      try {
        if (!spyBars) { spyBars = await polygonBars('SPY', polyKey); await mb.sleep(POLY_SLEEP_MS); }
        const bars = await polygonBars(etf, polyKey); await mb.sleep(POLY_SLEEP_MS);
        entry.price = mb.assessSectorPrice(bars, spyBars);
      } catch (e) { console.warn(`  sector ${etf} price: ${e.message}`); }
    }
    try { entry.fund = await ensureSectorFund(etf); } catch (e) { console.warn(`  sector ${etf} fundamentals: ${e.message}`); }
    sectorCache.data[etf] = entry; sectorData[etf] = entry;
  }

  async function runOne(symbol, stock, source, prev) {
    const inputs = await mb.fetchInputs(symbol, token, fmpKey);
    if (mb.isEtfProfile(inputs.profile)) return { skipped: 'ETF' };
    await ensureSector(mb.sectorEtfFor(inputs.profile.finnhubIndustry, stock?.sector, stock?.industry));
    const filing = parse(await redis.get(`filing_narrative_${symbol}`));
    const earnings = parse(await redis.get(`earnings_event_${symbol}`));
    const result = mb.screen({ symbol, ...inputs, stock, filing, earnings, sectorHealth: sectorData, prev, source });
    // Advisory entry-timing overlay (weekly RSI/MACD) for names that pass; refreshed weekly
    const t = result.entryTiming;
    if (result.status === 'PASS' && polyKey && timingLeft > 0 && (!t || Date.now() - new Date(t.asOf).getTime() > 6 * DAY)) {
      try {
        const o = mb.timingOverlay(await polygonBars(symbol, polyKey));
        if (o) result.entryTiming = { ...o, asOf: new Date().toISOString() };
        timingLeft--; await mb.sleep(POLY_SLEEP_MS);
      } catch (e) { console.warn(`  timing ${symbol}: ${e.message}`); }
    }
    return { result };
  }
  const line = r => `${r.symbol.padEnd(6)} ${String(r.status).padEnd(7)} raw=${String(r.rawStatus || '-').padEnd(5)} ${r.verdict} score=${r.score}${r.pending ? ` (pending ${r.pending.to} ${r.pending.runs}/2)` : ''}`;

  console.log(`MULTIBAGGER SCREEN  force=${FORCE} only=${ONLY || '-'}`);

  // ── Portfolio ─────────────────────────────────────────────────────────────
  const stocks = (portfolio.stocks || []).filter(s => s.instrument_type !== 'ETF' && s.type !== 'ETF').filter(s => !ONLY || s.symbol === ONLY);
  const newPortfolio = ONLY ? { ...blob.portfolio } : {};
  for (const s of stocks) {
    try {
      const { result } = await runOne(s.symbol, s, 'portfolio', blob.portfolio[s.symbol] || null);
      if (result) { newPortfolio[s.symbol] = result; console.log('  ' + line(result)); }
    } catch (e) {
      console.warn(`  ${s.symbol}: failed (${e.message}) — keeping previous result`);
      if (blob.portfolio[s.symbol]) newPortfolio[s.symbol] = blob.portfolio[s.symbol];
    }
    await mb.sleep(SLEEP_MS);
  }
  blob.portfolio = newPortfolio;

  // ── Watchlist (pending first, then stale; capped per run) ─────────────────
  const wl = parse(await redis.get('watchlist')) || { entries: [] };
  const staleMs = mb.PARAMS.CACHE_DAYS * DAY;
  const queue = wl.entries.filter(e => !ONLY || e.symbol === ONLY)
    .filter(e => FORCE || !e.screenedAt || Date.now() - new Date(e.screenedAt).getTime() > staleMs)
    .sort((a, b) => (a.screenedAt ? new Date(a.screenedAt).getTime() : 0) - (b.screenedAt ? new Date(b.screenedAt).getTime() : 0))
    .slice(0, WATCHLIST_MAX);
  console.log(`Watchlist: ${queue.length} to screen (cap ${WATCHLIST_MAX}/run)`);
  const updates = {};
  for (const e of queue) {
    try {
      const out = await runOne(e.symbol, null, 'watchlist', blob.watchlist[e.symbol] || null);
      if (out.skipped) { updates[e.symbol] = { status: 'NOT_APPLICABLE', screenedAt: new Date().toISOString() }; continue; }
      blob.watchlist[e.symbol] = out.result;
      updates[e.symbol] = { status: mb.statusOf(out.result), screenedAt: out.result.asOf, name: out.result.name };
      console.log('  ' + line(out.result));
    } catch (err) { console.warn(`  ${e.symbol}: failed (${err.message})`); }
    await mb.sleep(SLEEP_MS);
  }

  // Re-read the watchlist so UI additions made during the run are not clobbered
  const fresh = parse(await redis.get('watchlist')) || { entries: [] };
  fresh.entries = fresh.entries.map(e => (updates[e.symbol] ? { ...e, ...updates[e.symbol] } : e));
  blob.watchlist = Object.fromEntries(Object.entries(blob.watchlist).filter(([sym]) => fresh.entries.some(e => e.symbol === sym)));
  blob.generatedAt = new Date().toISOString();
  await redis.set('watchlist', JSON.stringify(fresh));
  await redis.set(mb.KEY, JSON.stringify(blob));
  await redis.set('sector_health', JSON.stringify(sectorCache));
  await redis.set('sector_fundamentals', JSON.stringify(sectorFund));
  await redis.quit();

  // Stability report: how often does the stable status flip vs the raw signal?
  const all = [...Object.values(blob.portfolio), ...Object.values(blob.watchlist)];
  const flips = (h, k) => h.slice(1).filter((x, i) => x[k] !== h[i][k]).length;
  const sFlips = all.reduce((a, r) => a + flips(r.history || [], 'status'), 0), rFlips = all.reduce((a, r) => a + flips(r.history || [], 'raw'), 0);
  const p = Object.values(blob.portfolio);
  console.log(`Done. Portfolio: ${p.filter(r => r.status === 'PASS').length}/${p.length} pass. Stability: ${sFlips} status flips vs ${rFlips} raw-signal flips across stored history.`);
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
