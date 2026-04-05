#!/usr/bin/env node
'use strict';

/**
 * FILING NARRATIVE ANALYSER — 10-K / 10-Q MD&A via Gemini Flash
 *
 * What this adds that Loughran-McDonald word counts CANNOT:
 *   - Whether the thesis narrative is strengthening or weakening
 *   - Specific forward-looking changes management telegraphed (margin guidance,
 *     capex plans, competitive positioning language)
 *   - Whether risk factors are new vs repeated vs removed vs intensified
 *   - Thesis-specific signals calibrated to WHY you own each stock
 *
 * When it runs:
 *   - Triggered by the EOD pipeline when it detects a new 10-K or 10-Q
 *     in the SEC EDGAR submissions feed (same feed already used for 8-K watching)
 *   - Runs at most 4 times per year per stock — negligible API usage
 *   - Stores result in Redis as filing_narrative_{SYMBOL} (no TTL — permanent,
 *     overwritten when next filing comes in)
 *   - Also logs to Supabase earnings_events table for historical record
 *
 * Free tier usage:
 *   - SEC EDGAR: free, no auth
 *   - Gemini 2.5 Flash: free tier, resets daily
 *
 * Place in: backend/scripts/filing-narrative.js
 * Add to package.json scripts: "filing-narrative": "node scripts/filing-narrative.js"
 * Call from daily-update.js after fetchFilingSentiment detects a new filing
 */

const axios = require('axios');
const path  = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { createClient: createRedisClient }    = require('redis');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

// ─── THESIS CONTEXT ───────────────────────────────────────────────────────────
// This is the most important part of the prompt quality.
// Without knowing WHY you own each stock, Gemini gives generic analysis.
// With this context, it extracts thesis-specific signals from the filing.
//
// Update this when your thesis changes or when you add new positions.
// For any stock not listed here, it falls back to _DEFAULT which extracts
// generic fundamental signals — still useful, just not thesis-calibrated.

// ─── NO HARDCODED THESIS ─────────────────────────────────────────────────────
// We do NOT hardcode investment theses for individual stocks.
// Reasons:
//   1. Gemini 2.5 Flash has deep training knowledge of every public company —
//      it already knows what GEV, CRWD, MU, etc. do and what moves their stock
//   2. Hardcoded theses break silently when you add or remove stocks
//   3. Hardcoded theses introduce confirmation bias — you're telling the model
//      what to find rather than letting it extract what's actually in the filing
//   4. A thesis you wrote 6 months ago may no longer reflect your actual view
//
// Instead: we pass the investor mandate and the company's sector/name from Redis.
// The model uses its training knowledge to determine what metrics matter for that
// specific business and surfaces what actually changed in this filing.
//
// This approach works for any stock, any sector, any time — zero maintenance.

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent';

// ─── CLIENTS ──────────────────────────────────────────────────────────────────

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── CIK LOOKUP ──────────────────────────────────────────────────────────────

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

// ─── FETCH MD&A FROM EDGAR ────────────────────────────────────────────────────
// Fetches the most recent 10-K or 10-Q and extracts the MD&A section.
// MD&A (Item 7 in 10-K, Item 2 in 10-Q) is where management discusses what
// actually changed in the business — the richest narrative signal in any filing.

async function fetchMDA(symbol) {
  const cik = await getCIK(symbol);
  if (!cik) return null;

  try {
    const res = await axios.get(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': 'AlphaDashboard/1.0 (portfolio@example.com)' },
      timeout: 10000,
    });

    const filings = res.data?.filings?.recent;
    if (!filings) return null;

    // Find most recent 10-K or 10-Q
    const idx = filings.form?.findIndex(f => f === '10-K' || f === '10-Q');
    if (idx == null || idx === -1) return null;

    const form    = filings.form[idx];
    const accRaw  = filings.accessionNumber[idx].replace(/-/g, '');
    const accFmt  = filings.accessionNumber[idx];
    const filed   = filings.filingDate[idx];
    const period  = filings.reportDate?.[idx] ?? null;
    const cikNum  = cik.replace(/^0+/, '');

    // Check if we already processed this filing (avoid re-running on same filing)
    // We store the last processed accession number in Redis
    const redisClient = createRedisClient({ url: process.env.REDIS_URL });
    redisClient.on('error', () => {});
    await redisClient.connect();
    const lastProcessed = await redisClient.get(`filing_narrative_acc_${symbol}`);
    await redisClient.quit();

    if (lastProcessed === accFmt) {
      console.log(`  ${symbol}: Filing ${accFmt} already processed — skipping`);
      return null;
    }

    // Fetch the primary document from the filing
    const docIndexUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accRaw}/${accFmt}-index.htm`;
    const docIndex = await axios.get(docIndexUrl, {
      headers: { 'User-Agent': 'AlphaDashboard/1.0 (portfolio@example.com)' },
      timeout: 8000,
    });

    // Find the primary HTML document (not the XBRL)
    const html = docIndex.data;
    // Match the main filing document — typically the first .htm that isn't an exhibit
    const mainDocMatch = html.match(/href="([^"]+(?:10[kq]|form10[kq])[^"]*\.htm[^"]*)"[^>]*>/i)
      || html.match(/href="([^"]+\.htm[^"]*)"[^>]*>(?!.*(?:ex-|exhibit))/i)
      || html.match(/href="(\/Archives\/edgar\/[^"]+\.htm)"/i);

    if (!mainDocMatch) {
      console.log(`  ${symbol}: Could not find primary document in filing index`);
      return null;
    }

    const docPath = mainDocMatch[1].startsWith('/') ? mainDocMatch[1]
      : `/Archives/edgar/data/${cikNum}/${accRaw}/${mainDocMatch[1]}`;

    const docRes = await axios.get(`https://www.sec.gov${docPath}`, {
      headers: { 'User-Agent': 'AlphaDashboard/1.0 (portfolio@example.com)' },
      timeout: 15000,
    });

    // Extract and clean text
    const fullText = docRes.data
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Extract MD&A section — heuristic: find "Management's Discussion" heading
    // and take up to 12,000 chars after it (covers most MD&A sections)
    const mdaStart = fullText.search(/management.s discussion and analysis/i);
    let mdaText;
    if (mdaStart !== -1) {
      mdaText = fullText.slice(mdaStart, mdaStart + 12000);
    } else {
      // Fallback: take a broad middle section of the document
      // (first 20% is cover page / TOC, last 30% is financial statements)
      const start = Math.floor(fullText.length * 0.20);
      const end   = Math.floor(fullText.length * 0.65);
      mdaText = fullText.slice(start, end).slice(0, 12000);
    }

    console.log(`  ${symbol}: ${form} MD&A extracted (${mdaText.length} chars, filed ${filed})`);
    return { text: mdaText, form, filed, period, accessionNumber: accFmt };

  } catch (e) {
    console.warn(`  ${symbol}: MD&A fetch failed — ${e.message}`);
    return null;
  }
}

// ─── GEMINI ANALYSIS ──────────────────────────────────────────────────────────
// No hardcoded thesis. We pass:
//   - The investor mandate (concentrated compounder, 3-7yr hold, ROIC-first)
//   - The company name and sector from Redis (added at stock add-time)
//   - The actual MD&A text from SEC EDGAR
// Gemini uses its training knowledge of the company to determine what matters,
// then reads the filing to find what changed. Works for any stock, any sector.
// Adding or removing stocks requires zero code changes.

async function analyseFilingWithGemini(symbol, stock, mdaText, filingMeta) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('⚠ GEMINI_API_KEY not set — skipping LLM analysis');
    return null;
  }

  // Use name/sector stored in Redis at add-time — no hardcoding needed
  const companyName = stock.name   || symbol;
  const sector      = stock.sector || 'unknown sector';

  const prompt = `You are reviewing a ${filingMeta.form} filing on behalf of a long-horizon equity investor.

INVESTOR MANDATE:
- Concentrated portfolio (15-20 stocks), targeting 22% CAGR by 2030
- Holding period: 3-7 years minimum
- Framework: fundamentals-first compounder — ROIC durability, FCF quality, revenue growth trajectory, capital allocation discipline
- Current holder assessing whether to maintain, add to, or reduce this position

COMPANY: ${companyName} (${symbol}), sector: ${sector}
FILING TYPE: ${filingMeta.form}, period ending ${filingMeta.period ?? filingMeta.filed}

MD&A SECTION:
${mdaText}

Using your knowledge of ${companyName}'s business model and competitive position, analyse this MD&A as a current long-term holder.

Rules:
- Cite specific numbers (percentages, dollar figures, units) from the text
- Focus on what CHANGED vs prior period language — new language, removed language, tone shifts
- Identify forward-looking statements about margins, capex, growth rates, competitive position
- Flag any new risk factors or risks that have intensified
- Ignore one-time items unless they signal structural change
- Be precise and conservative — management spin is noted but not accepted

Return ONLY a JSON object:
- thesis_status: "strengthening", "stable", "weakening", or "unclear"
- key_changes: up to 4 strings — what materially changed vs prior period (cite numbers)
- thesis_confirms: up to 3 strings — evidence the long-term investment case is intact
- thesis_risks: up to 3 strings — evidence threatening the multi-year thesis
- guidance_changes: up to 2 strings — specific forward metric changes management flagged
- management_confidence: integer 1-5 (1=heavily hedging, 3=balanced, 5=unusually confident)
- new_risks: up to 2 strings — risks appearing for the first time or notably intensifying
- summary: single sentence for a long-term holder, max 30 words, cite one key number`;

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
              thesis_status:         { type: 'string', enum: ['strengthening', 'stable', 'weakening', 'unclear'] },
              key_changes:           { type: 'array', items: { type: 'string' }, maxItems: 4 },
              thesis_confirms:       { type: 'array', items: { type: 'string' }, maxItems: 3 },
              thesis_risks:          { type: 'array', items: { type: 'string' }, maxItems: 3 },
              guidance_changes:      { type: 'array', items: { type: 'string' }, maxItems: 2 },
              management_confidence: { type: 'integer', minimum: 1, maximum: 5 },
              new_risks:             { type: 'array', items: { type: 'string' }, maxItems: 2 },
              summary:               { type: 'string' },
            },
            required: ['thesis_status', 'key_changes', 'thesis_confirms', 'thesis_risks',
                       'guidance_changes', 'management_confidence', 'new_risks', 'summary'],
          },
          temperature: 0.1,
        },
      },
      { timeout: 45000 }
    );

    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('Empty Gemini response');

    const parsed = JSON.parse(raw);
    console.log(`  ${symbol} filing verdict: ${parsed.summary}`);
    return parsed;

  } catch (e) {
    console.warn(`  ${symbol}: Gemini filing analysis failed — ${e.message}`);
    return null;
  }
}

// ─── SAVE TO REDIS AND SUPABASE ────────────────────────────────────────────────

async function save(symbol, filingMeta, geminiResult) {
  const payload = {
    symbol,
    form:            filingMeta.form,
    filed:           filingMeta.filed,
    period:          filingMeta.period,
    accessionNumber: filingMeta.accessionNumber,
    gemini:          geminiResult,
    processedAt:     new Date().toISOString(),
  };

  // Redis — no TTL (overwritten when next filing comes in)
  const client = createRedisClient({ url: process.env.REDIS_URL });
  client.on('error', err => console.warn('Redis error:', err.message));
  await client.connect();
  try {
    await client.set(`filing_narrative_${symbol}`, JSON.stringify(payload));
    // Store accession number so we don't re-process the same filing
    await client.set(`filing_narrative_acc_${symbol}`, filingMeta.accessionNumber);
    console.log(`  ✅ Saved filing_narrative_${symbol} to Redis`);
  } finally {
    await client.quit();
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' FILING NARRATIVE ANALYSER — 10-K / 10-Q MD&A');
  console.log(`  Date: ${new Date().toISOString().split('T')[0]}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Market holiday check — reads Polygon status from Redis cache
  const _isOpen = await checkMarketOpen();
  if (!_isOpen) {
    console.log(`🏖️  Market closed today — skipping filing-narrative run.`);
    process.exit(0);
  }

  // Get portfolio symbols from Redis
  const redisClient = createRedisClient({ url: process.env.REDIS_URL });
  redisClient.on('error', () => {});
  await redisClient.connect();
  const raw = await redisClient.get('portfolio');
  await redisClient.quit();

  if (!raw) {
    console.log('No portfolio found in Redis.');
    process.exit(0);
  }

  const portfolio = JSON.parse(raw);
  // Keep full stock objects — name and sector go into the Gemini prompt
  // so it can use its knowledge of the company without any hardcoded thesis
  const stocks = (portfolio.stocks || [])
    .filter(s => s.type !== 'ETF' && s.instrument_type !== 'ETF');

  console.log(`Portfolio stocks (excluding ETFs): ${stocks.map(s => s.symbol).join(', ')}\n`);

  let processed = 0;

  for (const stock of stocks) {
    const symbol = stock.symbol.toUpperCase();
    console.log(`\n─── ${symbol} ──────────────────────────────────────────`);

    const filing = await fetchMDA(symbol);
    if (!filing) {
      console.log(`  ${symbol}: No new filing to process`);
      continue;
    }

    const geminiResult = await analyseFilingWithGemini(symbol, stock, filing.text, filing);
    if (geminiResult) {
      await save(symbol, filing, geminiResult);
      processed++;
    }

    // Pace requests to SEC EDGAR — respect rate limits
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\n✅ Filing Narrative Analyser complete. Processed: ${processed} new filings.`);
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
