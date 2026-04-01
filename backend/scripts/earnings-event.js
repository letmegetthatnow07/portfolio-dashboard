#!/usr/bin/env node
'use strict';

/**
 * EARNINGS EVENT ANALYSER
 *
 * Runs as a GitHub Action step in the EOD master job — AFTER the main pipeline.
 * Does nothing on non-earnings days. On earnings days:
 *
 *  1. Finnhub /calendar/earnings → which portfolio stocks report today
 *  2. SEC EDGAR submissions → fetch the ex-99.1 press release from today's 8-K
 *  3. Google Gemini Flash (free tier) → structured JSON analysis
 *  4. Redis → store result with 90-day TTL as earnings_event_{SYMBOL}
 *
 * Dashboard reads earnings_event_{SYMBOL} and displays a special 📞 card
 * in the detail panel for the relevant stock for up to 90 days.
 *
 * Why Gemini Flash (not NVIDIA NIM):
 *   - Gemini Flash free tier resets daily → permanently free, never runs out
 *   - NVIDIA NIM gives 1,000 lifetime credits then requires payment
 *   - Gemini supports native JSON schema output → structured data guaranteed
 *   - OpenAI-compatible endpoint → drop-in for any future model switch
 *
 * API keys needed:
 *   FINNHUB_API_KEY   — already in your secrets
 *   GEMINI_API_KEY    — free, get from https://aistudio.google.com/
 *   REDIS_URL         — already in your secrets
 *   SUPABASE_URL / SUPABASE_SERVICE_KEY — already in your secrets
 */

const axios  = require('axios');
const path   = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { createClient: createRedisClient }    = require('redis');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent';
const TTL_SECONDS     = 90 * 24 * 60 * 60;  // 90 days in Redis

// ─── CLIENTS ──────────────────────────────────────────────────────────────────

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── STEP 1: EARNINGS CALENDAR ────────────────────────────────────────────────
// Returns list of portfolio symbols reporting today.
// Uses Finnhub /calendar/earnings — already your API key, free tier, no extra cost.

async function getPortfolioSymbols() {
  const client = createRedisClient({ url: process.env.REDIS_URL });
  client.on('error', () => {});
  await client.connect();
  const raw = await client.get('portfolio');
  await client.quit();
  if (!raw) return [];
  const portfolio = JSON.parse(raw);
  return (portfolio.stocks || []).map(s => s.symbol.toUpperCase());
}

async function getEarningsToday(symbols) {
  const today = new Date().toISOString().split('T')[0];  // YYYY-MM-DD

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
          epsEstimate: entry?.epsEstimate ?? null,
          revenueEstimate: entry?.revenueEstimate ?? null,
          quarter: entry?.quarter ?? null,
          year: entry?.year ?? null,
        });
        console.log(`✓ ${symbol} reports today (Q${entry?.quarter} ${entry?.year})`);
      }
    } catch (e) {
      console.warn(`⚠ Finnhub earnings check failed for ${symbol}: ${e.message}`);
    }
  }
  return reportingToday;
}

// ─── STEP 2: FETCH EARNINGS PRESS RELEASE ─────────────────────────────────────
// Looks for the most recent 8-K (form type 8-K) filed today in EDGAR.
// Ex-99.1 attachments = press releases with earnings results.
// Falls back to just the filing description if the full document is unavailable.

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
    // Fetch recent submissions — first few filings are most recent
    const res = await axios.get(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': 'AlphaDashboard/1.0 (portfolio@example.com)' },
      timeout: 10000,
    });

    const filings = res.data?.filings?.recent;
    if (!filings) return null;

    const today = new Date().toISOString().split('T')[0];

    // Find today's 8-K filing
    const idx = filings.form?.findIndex(
      (form, i) => form === '8-K' && filings.filingDate[i] === today
    );
    if (idx === -1 || idx == null) {
      console.log(`  ${symbol}: No 8-K filed today`);
      return null;
    }

    const accessionRaw = filings.accessionNumber[idx].replace(/-/g, '');
    const accessionFormatted = filings.accessionNumber[idx];
    const cikNum = cik.replace(/^0+/, '');

    // Fetch the filing index to find the ex-99.1 document
    const indexUrl = `https://www.sec.gov/Archives/edgar/${cikNum}/${accessionRaw}/${accessionFormatted}-index.htm`;
    const indexRes = await axios.get(indexUrl, {
      headers: { 'User-Agent': 'AlphaDashboard/1.0 (portfolio@example.com)' },
      timeout: 8000,
    });

    // Find ex-99.1 link (earnings press release attachment)
    const html = indexRes.data;
    const ex991Match = html.match(/href="([^"]+ex-?99\.?1[^"]*\.htm[^"]*)"[^>]*>/i)
      || html.match(/href="([^"]+ex99[^"]*\.htm[^"]*)"[^>]*>/i);

    if (!ex991Match) {
      console.log(`  ${symbol}: 8-K filed but no ex-99.1 press release found`);
      return { summary: `8-K filed ${today}`, source: 'filing_index' };
    }

    // Fetch the press release text
    const docPath = ex991Match[1].startsWith('/') ? ex991Match[1] : `/Archives/edgar/${cikNum}/${accessionRaw}/${ex991Match[1]}`;
    const docRes = await axios.get(`https://www.sec.gov${docPath}`, {
      headers: { 'User-Agent': 'AlphaDashboard/1.0 (portfolio@example.com)' },
      timeout: 10000,
    });

    // Strip HTML tags, collapse whitespace, truncate to ~8000 chars for Gemini
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

// ─── STEP 3: GEMINI FLASH ANALYSIS ────────────────────────────────────────────
// Sends press release text to Gemini 2.5 Flash with a structured JSON schema.
// Returns a guaranteed-schema object — no parsing errors possible.
//
// JSON schema:
//   eps_beat:            true/false/null    — did EPS beat consensus estimate?
//   revenue_beat:        true/false/null    — did revenue beat consensus?
//   guidance_direction:  'raised'/'lowered'/'maintained'/'none'/null
//   guidance_tone:       1-5               — 1=very bearish, 5=very bullish
//   thesis_risks:        string[]          — specific risks mentioned (max 3)
//   thesis_confirms:     string[]          — thesis-confirming signals (max 3)
//   management_tone:     1-5               — hedging language analysis
//   summary:             string            — 1-sentence plain English verdict

async function analyseWithGemini(symbol, pressReleaseText, earningsMetadata) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('⚠ GEMINI_API_KEY not set — skipping LLM analysis');
    return null;
  }

  const prompt = `You are a buy-side analyst reviewing an earnings press release for a long-horizon compounder portfolio.
Analyse this earnings release for ${symbol} and extract the information below. Be precise and conservative.

EPS estimate: ${earningsMetadata.epsEstimate ?? 'unknown'}
Revenue estimate: ${earningsMetadata.revenueEstimate != null ? `$${(earningsMetadata.revenueEstimate/1e6).toFixed(0)}M` : 'unknown'}

EARNINGS PRESS RELEASE:
${pressReleaseText}

Return ONLY a JSON object with these exact fields:
- eps_beat: boolean or null (did reported EPS beat the consensus estimate? null if estimate unavailable)
- revenue_beat: boolean or null (did reported revenue beat the consensus estimate? null if estimate unavailable)
- guidance_direction: one of "raised", "lowered", "maintained", "none" (was forward guidance updated?)
- guidance_tone: integer 1-5 (1=very bearish language, 3=neutral, 5=very bullish language in guidance)
- thesis_risks: array of up to 3 short strings (specific risks or negatives mentioned — quote numbers where possible)
- thesis_confirms: array of up to 3 short strings (thesis-confirming positives — quote numbers where possible)
- management_tone: integer 1-5 (1=defensive/hedging heavily, 3=balanced, 5=confident/aggressive)
- summary: single sentence verdict for a long-term investor (max 25 words)`;

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
              eps_beat:           { type: ['boolean', 'null'] },
              revenue_beat:       { type: ['boolean', 'null'] },
              guidance_direction: { type: 'string', enum: ['raised', 'lowered', 'maintained', 'none'] },
              guidance_tone:      { type: 'integer', minimum: 1, maximum: 5 },
              thesis_risks:       { type: 'array', items: { type: 'string' }, maxItems: 3 },
              thesis_confirms:    { type: 'array', items: { type: 'string' }, maxItems: 3 },
              management_tone:    { type: 'integer', minimum: 1, maximum: 5 },
              summary:            { type: 'string' },
            },
            required: ['eps_beat', 'revenue_beat', 'guidance_direction', 'guidance_tone',
                       'thesis_risks', 'thesis_confirms', 'management_tone', 'summary'],
          },
          temperature: 0.1,   // very low temperature — we want factual extraction, not creativity
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

// ─── STEP 4: WRITE TO REDIS ───────────────────────────────────────────────────
// Key: earnings_event_{SYMBOL}
// TTL: 90 days — visible in dashboard for one full quarter cycle

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

// ─── STEP 4b: LOG TO SUPABASE ─────────────────────────────────────────────────
// Optional — keeps a permanent historical record of earnings events.
// Useful once you have 2+ years of data to look back at earnings reactions.
// If the table doesn't exist yet, this fails silently.

async function logToSupabase(symbol, date, payload) {
  try {
    const { error } = await supabase
      .from('earnings_events')
      .upsert({
        symbol,
        date,
        eps_beat:           payload.gemini?.eps_beat ?? null,
        revenue_beat:       payload.gemini?.revenue_beat ?? null,
        guidance_direction: payload.gemini?.guidance_direction ?? null,
        guidance_tone:      payload.gemini?.guidance_tone ?? null,
        management_tone:    payload.gemini?.management_tone ?? null,
        summary:            payload.gemini?.summary ?? null,
        thesis_risks:       payload.gemini?.thesis_risks ?? [],
        thesis_confirms:    payload.gemini?.thesis_confirms ?? [],
        raw_payload:        payload,
      }, { onConflict: 'symbol,date' });

    if (error && !error.message.includes('does not exist')) {
      console.warn(`  Supabase log failed for ${symbol}: ${error.message}`);
    }
  } catch (e) {
    // Silently skip — Supabase table may not exist yet
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' EARNINGS EVENT ANALYSER');
  console.log(`  Date: ${new Date().toISOString().split('T')[0]}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Get current portfolio
  const symbols = await getPortfolioSymbols();
  if (!symbols.length) {
    console.log('No symbols in portfolio — nothing to do.');
    process.exit(0);
  }
  console.log(`Portfolio: ${symbols.join(', ')}\n`);

  // Check which symbols report today
  const reporting = await getEarningsToday(symbols);
  if (!reporting.length) {
    console.log('\n✓ No portfolio stocks report earnings today.');
    process.exit(0);
  }

  console.log(`\n${reporting.length} stock(s) report today:\n`);

  const today = new Date().toISOString().split('T')[0];

  for (const stock of reporting) {
    console.log(`\n─── ${stock.symbol} ──────────────────────────────────────────`);

    // Fetch press release from EDGAR
    const pressRelease = await fetchEarningsPressRelease(stock.symbol);

    let geminiResult = null;
    if (pressRelease?.text) {
      geminiResult = await analyseWithGemini(stock.symbol, pressRelease.text, stock);
    } else {
      console.log(`  ${stock.symbol}: No press release text — skipping Gemini analysis`);
    }

    // Build the payload
    const payload = {
      symbol:     stock.symbol,
      date:       today,
      quarter:    stock.quarter,
      year:       stock.year,
      estimates: {
        eps:     stock.epsEstimate,
        revenue: stock.revenueEstimate,
      },
      pressRelease: pressRelease ? {
        available: true,
        source:    pressRelease.source,
      } : { available: false },
      gemini:      geminiResult,
      processedAt: new Date().toISOString(),
    };

    // Store in Redis (primary — dashboard reads this)
    await saveToRedis(stock.symbol, payload);

    // Log to Supabase (optional — historical record)
    await logToSupabase(stock.symbol, today, payload);
  }

  console.log('\n✅ Earnings Event Analyser complete.');
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
