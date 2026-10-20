#!/usr/bin/env node
'use strict';
/**
 * MULTIBAGGER SCREEN RUNNER — runs after the EOD master run (or manually).
 * (The methodology/formulas live in backend/lib/multibagger.js.)
 *
 *   npm run multibagger                    # portfolio stocks that are DUE + pending/stale watchlist
 *   npm run multibagger -- --force         # re-screen everything (ignores cadence and caches)
 *   npm run multibagger -- --only=CRWD     # one symbol
 *   npm run multibagger -- --estimates=CRWD  # DIAGNOSTIC: show FMP analyst-estimate fields + how they parse (no writes)
 *
 * CADENCE: the portfolio thesis check is WEEKLY per stock (REFRESH_DAYS). A stock is re-checked sooner when
 *   - the old quality engine turned bearish (TRIM_25 / SELL / REDUCE), a critical 8-K appeared, or the score dropped sharply
 *   - a new earnings or filing analysis landed since the last check
 *   - its last result is stale or missing
 * Everything the check uses is already gathered by the daily pipeline (quality score, filing + earnings analysis, 8-K).
 *
 * Reads : Redis portfolio, watchlist, filing_narrative_*, earnings_event_*, sector_health, sector_fundamentals
 * Calls : Finnhub (2/stock + 5/sector/week), FMP estimates (1/stock), Polygon then FMP for sector ETF + timing bars
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
const TIMING_MAX = 8;                         // entry-timing overlays per run (price-bar calls)
const PRICE_MAX_AGE_MS = 7 * 86400000;        // a sector price leg older than this is dropped, never carried forward
const args = process.argv.slice(2);
const FORCE = args.includes('--force') || process.env.FORCE_RUN === 'true';
const ONLY = (args.find(a => a.startsWith('--only=')) || '').split('=')[1]?.toUpperCase() || null;
const DIAG = (args.find(a => a.startsWith('--estimates=')) || '').split('=')[1]?.toUpperCase() || null;
const DAY = 86400000;
const parse = raw => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

// ── Diagnostic: confirm the FMP field names/analyst counts the parser relies on ──────────
async function diagnoseEstimates(sym) {
  const key = process.env.FMP_API_KEY;
  if (!key) { console.error('FMP_API_KEY missing'); process.exit(1); }
  const urls = [
    `https://financialmodelingprep.com/stable/analyst-estimates?symbol=${sym}&period=annual&limit=10&apikey=${key}`,
    `https://financialmodelingprep.com/api/v3/analyst-estimates/${sym}?limit=10&apikey=${key}`,
  ];
  for (const url of urls) {
    const label = url.includes('/stable/') ? 'stable' : 'v3';
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      console.log(`[${label}] HTTP ${res.status}`);
      if (!res.ok) continue;
      const rows = await res.json();
      if (!Array.isArray(rows) || !rows.length) { console.log(`[${label}] empty`); continue; }
      console.log(`[${label}] ${rows.length} rows; keys: ${Object.keys(rows[0]).join(', ')}`);
      rows.slice(0, 6).forEach(r => console.log(`   ${r.date}  rev=${r.revenueAvg ?? r.estimatedRevenueAvg}  eps=${r.epsAvg ?? r.estimatedEpsAvg}  nRev=${r.numAnalystsRevenue ?? r.numberAnalystEstimatedRevenue ?? '—'}  nEps=${r.numAnalystsEps ?? r.numberAnalystsEstimatedEps ?? r.numberAnalystEstimatedEps ?? '—'}`));
      console.log(`[${label}] parsed:`, JSON.stringify(mb.parseEstimates(rows)));
      return;
    } catch (e) { console.log(`[${label}] failed: ${e.message}`); }
  }
}

// Old-engine / event triggers that pull a portfolio re-check forward
const BEARISH = new Set(['TRIM_25', 'SELL', 'REDUCE']);
function eventTrigger(stock, prev, earnings, filing) {
  const since = Date.parse(prev?.asOf ?? '');
  if (!Number.isFinite(since)) return true;                    // corrupted or missing timestamp: re-screen
  if (stock.event_8k_hint === 'critical' || stock.sharp_score_drop === true || BEARISH.has(stock.signal)) return true;
  const newer = t => { const v = Date.parse(t ?? ''); return Number.isFinite(v) && v > since; };
  return newer(earnings?.processedAt) || newer(filing?.processedAt);
}

// A failed run must not erase a confirmed state, leave a buy signal standing, or keep a stale PASS forever (30-day expiry).
function markStale(prev, held, reason, source) {
  return mb.preserveOrExpire(prev, held, reason, { symbol: prev.symbol, name: prev.name, source, asOf: new Date().toISOString() });
}

async function main() {
  if (DIAG) { await diagnoseEstimates(DIAG); process.exit(0); }

  const token = process.env.FINNHUB_API_KEY;
  if (!token) { console.error('FINNHUB_API_KEY missing'); process.exit(1); }
  const fmpKey = process.env.FMP_API_KEY || null, polyKey = process.env.POLYGON_API_KEY || null;
  const barKeys = { polyKey, fmpKey };

  const redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', e => console.error('Redis:', e.message));
  await redis.connect();

  const blob = parse(await redis.get(mb.KEY)) || mb.emptyBlob();
  const portfolio = parse(await redis.get('portfolio')) || { stocks: [] };
  const sectorCache = parse(await redis.get('sector_health')) || { data: {} };
  const sectorFund = parse(await redis.get('sector_fundamentals')) || { data: {} };
  const sectorData = {};
  let spyBars = null, timingLeft = TIMING_MAX;

  // Sector FUNDAMENTAL leg: median growth of representative constituents (weekly).
  // History gets one entry per refresh (>= 7 days apart by construction) and feeds the repeated-reading rule for BROKEN.
  async function ensureSectorFund(etf) {
    const fc = sectorFund.data[etf];
    if (fc && Date.now() - new Date(fc.asOf).getTime() < 7 * DAY) return fc.assessment;
    const metrics = [];
    for (const sym of mb.SECTOR_CONSTITUENTS[etf] || []) {
      try { const j = await mb.finnhub('/stock/metric', { symbol: sym, metric: 'all' }, token); if (j?.metric) metrics.push(j.metric); } catch (e) { console.warn(`  sector ${etf}/${sym}: ${e.message}`); }
      await mb.sleep(1300);
    }
    const history = fc?.history || [];
    const assessment = mb.assessSectorFundamentals(metrics, history, { cyclical: mb.CYCLICAL_ETFS.has(etf) });
    if (assessment && assessment.label !== 'UNKNOWN') {
      history.push({ asOf: new Date().toISOString(), medFwdEps: assessment.medFwdEps ?? null, medRevYoY: assessment.medRevYoY ?? null, rawBroken: !!assessment.rawBroken });
    }
    sectorFund.data[etf] = { asOf: new Date().toISOString(), assessment, history: history.slice(-12) };
    return assessment;
  }
  // Sector PRICE leg (daily) + fundamentals leg (weekly) -> one cached entry per ETF.
  // The price leg keeps its OWN timestamp: it is reused for at most 7 days, then dropped (null), never carried forward silently.
  async function ensureSector(etf) {
    if (!etf) return;
    const hit = sectorCache.data[etf];
    if (hit && Date.now() - new Date(hit.asOf).getTime() < DAY) { sectorData[etf] = hit; return; }
    const keep = hit?.price && hit.priceAsOf && Date.now() - new Date(hit.priceAsOf).getTime() < PRICE_MAX_AGE_MS;
    const entry = { asOf: new Date().toISOString(), price: keep ? hit.price : null, priceAsOf: keep ? hit.priceAsOf : null, fund: null };
    if (polyKey || fmpKey) {
      try {
        if (!spyBars) {
          const s = await mb.fetchBars('SPY', barKeys);
          if (s) { spyBars = s.bars; if (s.source === 'polygon') await mb.sleep(POLY_SLEEP_MS); }
        }
        const e = spyBars ? await mb.fetchBars(etf, barKeys) : null;
        if (e) {
          if (e.source === 'polygon') await mb.sleep(POLY_SLEEP_MS);
          const p = mb.assessSectorPrice(e.bars, spyBars);
          if (p) { entry.price = p; entry.priceAsOf = new Date().toISOString(); }
        }
      } catch (e) { console.warn(`  sector ${etf} price: ${e.message}`); }
    }
    try { entry.fund = await ensureSectorFund(etf); } catch (e) { console.warn(`  sector ${etf} fundamentals: ${e.message}`); }
    sectorCache.data[etf] = entry; sectorData[etf] = entry;
  }

  async function runOne(symbol, stock, source, prev, held, filing, earnings) {
    const inputs = await mb.fetchInputs(symbol, token, fmpKey);
    if (mb.isEtfProfile(inputs.profile)) return { result: mb.screen({ symbol, profile: inputs.profile, isETF: true, source, held }) };   // consistent NOT_APPLICABLE in every store
    await ensureSector(mb.sectorEtfFor(stock?.industry, stock?.sector, inputs.profile.finnhubIndustry));
    const result = mb.screen({ symbol, ...inputs, stock, filing, earnings, sectorHealth: sectorData, prev, source, held });
    // Advisory entry-timing overlay for names that pass; refreshed weekly (Polygon, then FMP)
    if (result.status === 'PASS' && timingLeft > 0) {
      try {
        const t = await mb.attachTiming(result, barKeys);
        if (t.fetched) { timingLeft--; if (t.source === 'polygon') await mb.sleep(POLY_SLEEP_MS); }
      } catch (e) { console.warn(`  timing ${symbol}: ${e.message}`); }
    }
    return { result };
  }
  const line = r => `${r.symbol.padEnd(6)} ${String(r.status).padEnd(7)} raw=${String(r.rawStatus || '-').padEnd(5)} ${String(r.verdict).padEnd(22)} ${String(r.action || '-').padEnd(20)} score=${r.score}${r.pending ? ` (pending ${r.pending.to} ${r.pending.runs}/2)` : ''}${r.stale ? ' [STALE]' : ''}`;

  console.log(`MULTIBAGGER SCREEN  force=${FORCE} only=${ONLY || '-'}  cadence=${mb.PARAMS.REFRESH_DAYS}d  tax=${(mb.PARAMS.EXIT_TAX * 100).toFixed(1)}%`);

  // ── Portfolio: weekly thesis check (+ event triggers) ──────────────────────
  const stocks = (portfolio.stocks || []).filter(s => s.instrument_type !== 'ETF' && s.type !== 'ETF').filter(s => !ONLY || s.symbol === ONLY);
  const newPortfolio = ONLY ? { ...blob.portfolio } : {};
  let checked = 0, skippedFresh = 0;
  for (const s of stocks) {
    const prev = blob.portfolio[s.symbol] || null;
    const held = (Number(s.quantity) || 0) > 0;
    const earnings = parse(await redis.get(`earnings_event_${s.symbol}`));
    const filing = parse(await redis.get(`filing_narrative_${s.symbol}`));
    const prevTime = Date.parse(prev?.asOf ?? '');
    const ageDays = Number.isFinite(prevTime) ? (Date.now() - prevTime) / DAY : Infinity;
    const due = FORCE || !!ONLY || !prev || prev.status === 'NO_DATA' || prev.stale || ageDays >= mb.PARAMS.REFRESH_DAYS || eventTrigger(s, prev, earnings, filing);
    if (!due) { newPortfolio[s.symbol] = prev; skippedFresh++; continue; }
    try {
      const out = await runOne(s.symbol, s, 'portfolio', prev, held, filing, earnings);
      if (out.result) { newPortfolio[s.symbol] = out.result; checked++; console.log('  ' + line(out.result)); }
    } catch (e) {
      console.warn(`  ${s.symbol}: failed (${e.message}) — keeping previous result, marked stale`);
      if (prev) newPortfolio[s.symbol] = markStale(prev, held, e.message, 'portfolio');
    }
    await mb.sleep(SLEEP_MS);
  }
  blob.portfolio = newPortfolio;
  console.log(`Portfolio: ${checked} checked, ${skippedFresh} still fresh (weekly cadence)`);

  // ── Watchlist (pending first, then stale; capped per run) ─────────────────
  const wl = parse(await redis.get('watchlist')) || { entries: [] };
  const staleMs = mb.PARAMS.CACHE_DAYS * DAY;
  const queue = wl.entries.filter(e => !ONLY || e.symbol === ONLY)
    .filter(e => FORCE || !!ONLY || !Number.isFinite(Date.parse(e.screenedAt ?? '')) || Date.now() - Date.parse(e.screenedAt) > staleMs)
    .sort((a, b) => (Date.parse(a.screenedAt ?? '') || 0) - (Date.parse(b.screenedAt ?? '') || 0))
    .slice(0, WATCHLIST_MAX);
  console.log(`Watchlist: ${queue.length} to screen (cap ${WATCHLIST_MAX}/run)`);
  const updates = {};
  for (const e of queue) {
    const prev = blob.watchlist[e.symbol] || null;
    try {
      const filing = parse(await redis.get(`filing_narrative_${e.symbol}`));
      const earnings = parse(await redis.get(`earnings_event_${e.symbol}`));
      const out = await runOne(e.symbol, null, 'watchlist', prev, false, filing, earnings);
      blob.watchlist[e.symbol] = out.result;
      updates[e.symbol] = { status: mb.statusOf(out.result), screenedAt: out.result.asOf, name: out.result.name, stale: false };
      console.log('  ' + line(out.result));
    } catch (err) {
      console.warn(`  ${e.symbol}: failed (${err.message})`);
      if (prev) { blob.watchlist[e.symbol] = markStale(prev, false, err.message, 'watchlist'); updates[e.symbol] = { stale: true }; }   // screenedAt unchanged, so it is retried next run
    }
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
