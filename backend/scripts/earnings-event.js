#!/usr/bin/env node
'use strict';

/**
 * EARNINGS EVENT ANALYSER
 *
 * Runs as a GitHub Action step in the EOD master job — AFTER the main pipeline.
 *
 *  A. EVERY run: refresh each stock's reported-quarter surprise history (revenue and EPS, actual vs analyst estimate)
 *     from the Finnhub earnings calendar -> Redis earnings_surprise_{SYMBOL}. These are plain numbers, no AI involved.
 *     Running nightly (not only on report day) also picks up actuals that Finnhub fills in a day or two late.
 *     Consumers: backend/lib/earnings-context.js (daily-update.js and multibagger.js).
 *  B. On report day only:
 *     1. Finnhub /calendar/earnings -> which portfolio stocks report today
 *     2. SEC EDGAR submissions -> fetch the ex-99.1 press release from today's 8-K
 *     3. Google Gemini Flash -> structured JSON analysis (guidance direction, thesis confirms/risks, tone)
 *        Where real actual-vs-estimate numbers exist they OVERRIDE Gemini's beat/miss booleans.
 *     4. Redis -> earnings_event_{SYMBOL} with 90-day TTL
 *
 * Dashboard reads earnings_event_{SYMBOL} and earnings_surprise_{SYMBOL} for the Earnings card.
 */

const axios  = require('axios');
const path   = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { createClient: createRedisClient }    = require('redis');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');
const ec = require('../lib/earnings-context');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const TTL_SECONDS     = 90 * 24 * 60 * 60;  // 90 days in Redis
const SURPRISE_WINDOW_DAYS = 430;           // ~4-5 reported quarters
const SURPRISE_KEEP        = 6;
const DAY = 86400000;

// ─── CLIENTS ──────────────────────────────────────────────────────────────────

// NODE 20 FIX: @supabase/realtime-js v2 throws on startup without a WebSocket
// implementation on Node < 22. 'ws' is a direct dep of @supabase/realtime-js
// so it is always present. This script only uses HTTP REST — never realtime
// subscriptions — so this has zero effect on runtime behaviour.
const _ws = require('ws');

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: _ws } }
);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isoDay = d => new Date(d).toISOString().split('T')[0];

// ─── MARKET HOLIDAY GUARD ─────────────────────────────────────────────────────

async function checkMarketOpen() {
  if (process.env.FORCE_RUN === 'true') {
    console.log('  [Market] FORCE_RUN=true — bypassing market-closed check');
    return true;
  }
  const todayStr = new Date().toISOString().split('T')[0];
  const _r = createRedisClient({ url: process.env.REDIS_URL });
  _r.on('error', () => {});
  await _r.connect().catch(() => {});
  const cached = await _r.get(`market_open_${todayStr}`).catch(() => null);
  if (cached === 'closed') { await _r.quit().catch(() => {}); return false; }
  if (!cached) {
    try {
      const res = await axios.get(
        `https://api.polygon.io/v1/marketstatus/now?apiKey=${process.env.POLYGON_API_KEY}`,
        { timeout: 6000 }
      );
      const status = res.data?.market ?? 'open';
      await _r.set(`market_open_${todayStr}`, status, { EX: 43200 }).catch(() => {});
      await _r.quit().catch(() => {});
      return status !== 'closed';
    } catch (e) {
      await _r.quit().catch(() => {});
      return true; // fail open
    }
  }
  await _r.quit().catch(() => {});
  return true;
}

// ─── PORTFOLIO ────────────────────────────────────────────────────────────────

// ETFs have no earnings reports, so they are left out.
async function getPortfolioSymbols() {
  const client = createRedisClient({ url: process.env.REDIS_URL });
  client.on('error', () => {});
  await client.connect();
  const raw = await client.get('portfolio');
  await client.quit();
  if (!raw) return [];
  const portfolio = JSON.parse(raw);
  return (portfolio.stocks || [])
    .filter(s => s.type !== 'ETF' && s.instrument_type !== 'ETF')
    .map(s => s.symbol.toUpperCase());
}

// ─── STEP A: SURPRISE HISTORY (numbers only) ──────────────────────────────────

const numOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Reported quarters only: a date in the past with at least one actual AND its estimate. Oldest -> newest. */
function reportedQuarters(rows) {
  const today = isoDay(Date.now());
  return (rows || [])
    .filter(r => r && typeof r.date === 'string' && r.date <= today)
    .map(r => ({
      date: r.date, quarter: r.quarter ?? null, year: r.year ?? null,
      revenueActual: numOrNull(r.revenueActual), revenueEstimate: numOrNull(r.revenueEstimate),
      epsActual: numOrNull(r.epsActual), epsEstimate: numOrNull(r.epsEstimate),
    }))
    .filter(q => (q.revenueActual != null && q.revenueEstimate != null) || (q.epsActual != null && q.epsEstimate != null))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-SURPRISE_KEEP);
}

async function fetchCalendar(symbol, from, to) {
  const res = await axios.get('https://finnhub.io/api/v1/calendar/earnings', {
    params: { symbol, from, to, token: process.env.FINNHUB_API_KEY },
    timeout: 8000,
  });
  return res.data?.earningsCalendar || [];
}

async function refreshSurprises(symbols) {
  const client = createRedisClient({ url: process.env.REDIS_URL });
  client.on('error', () => {});
  await client.connect();
  const to = isoDay(Date.now()), from = isoDay(Date.now() - SURPRISE_WINDOW_DAYS * DAY);
  let updated = 0, unchanged = 0, failed = 0;
  console.log('Refreshing reported-quarter surprise history…');
  for (const symbol of symbols) {
    try {
      const quarters = reportedQuarters(await fetchCalendar(symbol, from, to));
      if (!quarters.length) {                       // never overwrite good history with an empty answer
        unchanged++; console.log(`  ${symbol}: no reported quarters returned — keeping what is stored`);
      } else {
        await client.set(`earnings_surprise_${symbol}`, JSON.stringify({ symbol, asOf: new Date().toISOString(), quarters }));
        updated++;
        const last = quarters[quarters.length - 1];
        const rs = ec.surprise(last.revenueActual, last.revenueEstimate), es = ec.surprise(last.epsActual, last.epsEstimate);
        console.log(`  ${symbol}: ${quarters.length} quarters · latest ${last.date} revenue ${rs == null ? 'n/a' : (rs * 100).toFixed(1) + '%'} · EPS ${es == null ? 'n/a' : (es * 100).toFixed(1) + '%'}`);
      }
    } catch (e) {
      failed++; console.warn(`  ${symbol}: surprise refresh failed — ${e.message} (previous history kept)`);
    }
    await sleep(1000);
  }
  await client.quit().catch(() => {});
  console.log(`Surprise history: ${updated} updated, ${unchanged} unchanged, ${failed} failed\n`);
}

// ─── STEP B1: WHO REPORTS TODAY ───────────────────────────────────────────────

async function getEarningsToday(symbols) {
  const today = new Date().toISOString().split('T')[0];
  const reportingToday = [];
  for (const symbol of symbols) {
    try {
      const res = await axios.get('https://finnhub.io/api/v1/calendar/earnings', {
        params: { symbol, from: today, to: today, token: process.env.FINNHUB_API_KEY },
        timeout: 6000,
      });
      const earnings = res.data?.earningsCalendar || [];
      if (earnings.some(e => e.date === today)) {
        const entry = earnings.find(e => e.date === today);
        reportingToday.push({
          symbol,
          epsEstimate:     entry?.epsEstimate     ?? null,
          revenueEstimate: entry?.revenueEstimate ?? null,
          epsActual:       entry?.epsActual       ?? null,   // usually filled in later; used when present
          revenueActual:   entry?.revenueActual   ?? null,
          quarter:         entry?.quarter         ?? null,
          year:            entry?.year            ?? null,
        });
        console.log(`✓ ${symbol} reports today (Q${entry?.quarter} ${entry?.year})`);
      }
    } catch (e) {
      console.warn(`⚠ Finnhub earnings check failed for ${symbol}: ${e.message}`);
    }
    await sleep(1000);
  }
  return reportingToday;
}

// ─── STEP B2: FETCH EARNINGS PRESS RELEASE ────────────────────────────────────

const _cikCache = {};

async function getCIK(symbol) {
  if (_cikCache[symbol]) return _cikCache[symbol];
  try {
    const res = await axios.get('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': 'AlphaDashboard/1.0 (portfolio@example.com)' },
      timeout: 8000,
    });
    const company = Object.values(res.data).find(c => c.ticker === symbol.toUpperCase());
    if (!company) return null;
    const cik = company.cik_str.toString().padStart(10, '0');
    _cikCache[symbol] = cik;
    return cik;
  } catch (e) {
    return null;
  }
}

async function fetchEarningsPressRelease(symbol) {
  const cik = await getCIK(symbol);
  if (!cik) return null;

  try {
    const res = await axios.get(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': 'AlphaDashboard/1.0 (portfolio@example.com)' },
      timeout: 10000,
    });

    const filings = res.data?.filings?.recent;
    if (!filings) return null;

    const today     = new Date().toISOString().split('T')[0];
    const yesterday = (() => { const y = new Date(); y.setDate(y.getDate() - 1); return y.toISOString().split('T')[0]; })();

    const idx = filings.form?.findIndex(
      (form, i) => form === '8-K' &&
        (filings.filingDate[i] === today || filings.filingDate[i] === yesterday)
    );
    if (idx === -1 || idx == null) {
      console.log(`  ${symbol}: No 8-K filed today`);
      return null;
    }

    const accessionRaw = filings.accessionNumber[idx].replace(/-/g, '');
    const cikNum       = cik.replace(/^0+/, '');

    // Use structured index.json instead of parsing index.htm HTML.
    // index.json has { directory: { item: [{ name, type, size }] } } — reliable regardless
    // of how the company names its exhibit files (ex991.htm, pressrelease.htm, etc.)
    const indexJsonUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionRaw}/index.json`;
    let ex991Name = null;
    try {
      const idxRes = await axios.get(indexJsonUrl, {
        headers: { 'User-Agent': 'AlphaDashboard/1.0 (portfolio@example.com)' },
        timeout: 8000,
      });
      const items = idxRes.data?.directory?.item ?? [];
      const ex991Item = items.find(i =>
        i.type === 'EX-99.1' ||
        i.type === 'EX-99' ||
        /ex-?99[-_.]?1/i.test(i.name ?? '')
      );
      ex991Name = ex991Item?.name ?? null;
    } catch (e) {
      console.warn(`  ${symbol}: index.json fetch failed (${e.message}) — trying filename regex fallback`);
    }

    // Fallback: if index.json failed, try index.htm HTML regex (original approach)
    if (!ex991Name) {
      try {
        const accessionFormatted = filings.accessionNumber[idx];
        const htmUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionRaw}/${accessionFormatted}-index.htm`;
        const htmRes = await axios.get(htmUrl, {
          headers: { 'User-Agent': 'AlphaDashboard/1.0 (portfolio@example.com)' },
          timeout: 8000,
        });
        const match = htmRes.data.match(
          /href="([^"]*(?:ex-?99[-_.]?1|exhibit[-_]?99[-_.]?1|ex99[-_.]?1|pressrelease)[^"]*\.htm[^"]*)"[^>]*>/i
        );
        if (match) {
          ex991Name = match[1].split('/').pop();
        }
      } catch (e) { /* htm fallback also failed */ }
    }

    if (!ex991Name) {
      console.log(`  ${symbol}: 8-K filed but no ex-99.1 press release found`);
      return { summary: `8-K filed ${today}`, source: 'filing_index' };
    }

    const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionRaw}/${ex991Name}`;
    const docRes = await axios.get(docUrl, {
      headers: { 'User-Agent': 'AlphaDashboard/1.0 (portfolio@example.com)' },
      timeout: 10000,
    });

    const text = docRes.data
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);

    console.log(`  ${symbol}: Press release fetched (${text.length} chars)`);
    return { text, source: 'ex-99.1' };

  } catch (e) {
    console.warn(`  ${symbol}: Press release fetch failed — ${e.message}`);
    return null;
  }
}

// ─── STEP B3: GEMINI FLASH ANALYSIS ───────────────────────────────────────────

async function analyseWithGemini(symbol, pressReleaseText, earningsMetadata) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('⚠ GEMINI_API_KEY not set — skipping LLM analysis');
    return null;
  }

  const epsStr = earningsMetadata.epsEstimate != null
    ? `$${earningsMetadata.epsEstimate}`
    : 'not available';
  const revStr = earningsMetadata.revenueEstimate != null
    ? `$${(earningsMetadata.revenueEstimate / 1e6).toFixed(0)}M`
    : 'not available';

  const prompt = `You are reviewing an earnings press release on behalf of a long-horizon equity investor.

INVESTOR MANDATE:
- Concentrated portfolio (15-20 stocks), targeting 22% CAGR
- Holding period: 3-7 years minimum
- Framework: fundamentals-first compounder — ROIC durability, FCF quality, revenue growth trajectory
- Reading as a current HOLDER, not a prospective buyer

STOCK: ${symbol}
CONSENSUS EPS ESTIMATE: ${epsStr}
CONSENSUS REVENUE ESTIMATE: ${revStr}

EARNINGS PRESS RELEASE:
${pressReleaseText}

Analyse this through the lens of a long-term holder. Your job is to assess whether the long-term investment case is strengthening, stable, or weakening based on this result.

Rules:
- Cite specific numbers from the release (percentages, dollar figures, units)
- Focus on what CHANGED vs prior expectations, not what was already known
- Identify anything that threatens the multi-year thesis specifically
- Ignore short-term noise (fx rates, one-time items) unless they indicate structural change
- Be conservative — a miss that management explains away is still a miss
- Revenue versus the consensus estimate matters most: state the reported revenue and whether it is above or below the estimate

Return ONLY a JSON object:
- eps_beat: boolean or null (null if no estimate available)
- revenue_beat: boolean or null (null if no estimate available)
- guidance_direction: "raised", "lowered", "maintained", or "none"
- thesis_confirms: up to 3 strings — evidence the long-term investment case is intact (cite numbers)
- thesis_risks: up to 3 strings — evidence that threatens the multi-year thesis (cite numbers)
- management_confidence: integer 1-5 (1=heavily hedging language, 3=balanced, 5=unusually confident)
- summary: single sentence for a long-term holder, max 25 words, no filler phrases`;

  try {
    const res = await axios.post(
      `${GEMINI_ENDPOINT}?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              eps_beat:              { type: 'boolean' },
              revenue_beat:          { type: 'boolean' },
              guidance_direction:    { type: 'string', enum: ['raised', 'lowered', 'maintained', 'none'] },
              thesis_confirms:       { type: 'array', items: { type: 'string' }, maxItems: 3 },
              thesis_risks:          { type: 'array', items: { type: 'string' }, maxItems: 3 },
              management_confidence: { type: 'integer', minimum: 1, maximum: 5 },
              summary:               { type: 'string' },
            },
            required: ['eps_beat', 'revenue_beat', 'guidance_direction',
                       'thesis_confirms', 'thesis_risks', 'management_confidence', 'summary'],
          },
          temperature: 0.1,
        },
      },
      { timeout: 30000 }
    );

    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('Empty Gemini response');

    const parsed = JSON.parse(raw);
    console.log(`  ${symbol} Gemini verdict: ${parsed.summary}`);
    return parsed;

  } catch (e) {
    console.warn(`  ${symbol}: Gemini analysis failed — ${e.message}`);
    return null;
  }
}

// ─── STEP B4: WRITE TO REDIS ──────────────────────────────────────────────────

async function saveToRedis(symbol, payload) {
  const client = createRedisClient({ url: process.env.REDIS_URL });
  client.on('error', err => console.warn('Redis error:', err.message));
  await client.connect();
  try {
    await client.setEx(
      `earnings_event_${symbol}`,
      TTL_SECONDS,
      JSON.stringify(payload)
    );
    console.log(`  ✅ Saved earnings_event_${symbol} to Redis (TTL: 90 days)`);
  } finally {
    await client.quit();
  }
}

// ─── STEP B4b: LOG TO SUPABASE ────────────────────────────────────────────────

async function logToSupabase(symbol, date, payload) {
  try {
    const { error } = await supabase
      .from('earnings_events')
      .upsert({
        symbol,
        date,
        form:               '8-K-earnings',
        quarter:            payload.quarter                    ?? null,
        year:               payload.year                       ?? null,
        eps_beat:           payload.gemini?.eps_beat           ?? null,
        revenue_beat:       payload.gemini?.revenue_beat       ?? null,
        guidance_direction: payload.gemini?.guidance_direction ?? null,
        management_tone:    payload.gemini?.management_confidence ?? null,
        summary:            payload.gemini?.summary            ?? null,
        thesis_risks:       payload.gemini?.thesis_risks       ?? [],
        thesis_confirms:    payload.gemini?.thesis_confirms    ?? [],
        raw_payload:        payload,
      }, { onConflict: 'symbol,date' });

    if (error && !error.message?.includes('does not exist')) {
      console.warn(`  Supabase log failed for ${symbol}: ${error.message}`);
    }
  } catch (e) {
    // Silently skip — Supabase table may not exist yet
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const _isOpen = await checkMarketOpen();
  if (!_isOpen) {
    console.log('🏖️  Market closed today — skipping earnings-event run.');
    process.exit(0);
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' EARNINGS EVENT ANALYSER');
  console.log(`  Date: ${new Date().toISOString().split('T')[0]}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const symbols = await getPortfolioSymbols();
  if (!symbols.length) {
    console.log('No symbols in portfolio — nothing to do.');
    process.exit(0);
  }
  console.log(`Portfolio (stocks): ${symbols.join(', ')}\n`);

  // A. every run: numbers-only surprise history (never blocks the rest of the run)
  try { await refreshSurprises(symbols); } catch (e) { console.warn(`Surprise refresh crashed: ${e.message}`); }

  // B. report-day analysis
  const reporting = await getEarningsToday(symbols);
  if (!reporting.length) {
    console.log('\n✓ No portfolio stocks report earnings today.');
    process.exit(0);
  }

  console.log(`\n${reporting.length} stock(s) report today:\n`);

  const today = new Date().toISOString().split('T')[0];

  for (const stock of reporting) {
    console.log(`\n─── ${stock.symbol} ──────────────────────────────────────────`);

    const pressRelease = await fetchEarningsPressRelease(stock.symbol);

    let geminiResult = null;
    if (pressRelease?.text) {
      geminiResult = await analyseWithGemini(stock.symbol, pressRelease.text, stock);
    } else {
      console.log(`  ${stock.symbol}: No press release text — skipping Gemini analysis`);
    }

    // Real numbers beat an AI read: where actual and estimate are both known, they decide "beat".
    const revS = ec.surprise(stock.revenueActual, stock.revenueEstimate);
    const epsS = ec.surprise(stock.epsActual, stock.epsEstimate);
    if (geminiResult) {
      if (revS != null) { geminiResult.revenue_beat = revS > 0; geminiResult.revenue_beat_source = 'numbers'; }
      if (epsS != null) { geminiResult.eps_beat     = epsS > 0; geminiResult.eps_beat_source     = 'numbers'; }
    }

    const payload = {
      symbol:     stock.symbol,
      date:       today,
      quarter:    stock.quarter,
      year:       stock.year,
      estimates: {
        eps:     stock.epsEstimate,
        revenue: stock.revenueEstimate,
      },
      actuals: {
        eps:     stock.epsActual,
        revenue: stock.revenueActual,
      },
      surprise: { revenuePct: revS == null ? null : revS * 100, epsPct: epsS == null ? null : epsS * 100 },
      pressRelease: pressRelease ? {
        available: true,
        source:    pressRelease.source,
      } : { available: false },
      gemini:      geminiResult,
      processedAt: new Date().toISOString(),
    };

    await saveToRedis(stock.symbol, payload);
    await logToSupabase(stock.symbol, today, payload);
  }

  console.log('\n✅ Earnings Event Analyser complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
