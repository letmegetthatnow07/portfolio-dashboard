#!/usr/bin/env node
'use strict';

/**
 * FILING NARRATIVE ANALYSER — 10-K / 10-Q MD&A via Gemini 2.5 Flash
 *
 * Merged and optimised from three versions. Key improvements:
 *   1. Correct Gemini endpoint (gemini-2.5-flash, not deprecated preview)
 *   2. primaryDocument from submissions JSON (no fragile HTML regex)
 *   3. chooseBestSection with Item-boundary end detection per form type
 *   4. Risk Factors section appended (new / intensified risks)
 *   5. Gemini retry with exponential backoff (429 / 5xx)
 *   6. evidence_quotes + uncertainty_flags in schema (anti-hallucination)
 *   7. Granular error logging per error class (404, 429, timeout, etc.)
 *   8. FORCE_RUN=true bypasses market-closed gate (matches master/news)
 *   9. Supabase earnings_events logging for audit trail
 *  10. Skipped vs failed vs processed counts in summary
 */

const axios = require('axios');
const path  = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { createClient: createRedisClient }    = require('redis');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

// gemini-2.5-flash = stable GA release (preview-05-20 was shut down → caused all 404s)
const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const SEC_UA = { 'User-Agent': 'AlphaDashboard/1.0 (portfolio@example.com)' };

// MD&A char budgets — covers 95%+ of large-cap sections
const MDA_HARD_CAP_10K  = 40000; // 10-K MD&A is longer
const MDA_HARD_CAP_10Q  = 35000; // 10-Q MD&A is shorter
const RISK_HARD_CAP     =  8000; // Risk Factors appended after MD&A

// ─── CLIENTS ──────────────────────────────────────────────────────────────────

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const _cikCache = {};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── ERROR LOGGING ────────────────────────────────────────────────────────────
// Classifies errors by type so logs tell you immediately whether it's a config
// issue (404 model name), rate limit (429), server error (5xx), or network.

function logHttpError(tag, symbol, context, e) {
  const status      = e?.response?.status;
  const bodyExcerpt = e?.response?.data
    ? JSON.stringify(e.response.data).slice(0, 300)
    : null;

  if (status === 404) {
    console.error(`  ${tag} ${symbol}: 404 NOT FOUND — ${context}`);
    console.error(`    → Check: model name deprecated? Wrong URL? CIK mismatch?`);
  } else if (status === 429) {
    console.error(`  ${tag} ${symbol}: 429 RATE LIMITED — ${context}`);
    console.error(`    → Increase sleep between stocks or reduce cron frequency`);
  } else if (status === 403) {
    console.error(`  ${tag} ${symbol}: 403 FORBIDDEN — ${context}`);
    console.error(`    → SEC requires valid User-Agent header`);
  } else if (status >= 500) {
    console.error(`  ${tag} ${symbol}: ${status} SERVER ERROR — ${context} (transient)`);
  } else if (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT') {
    console.error(`  ${tag} ${symbol}: TIMEOUT (${e.code}) — ${context}`);
  } else if (e?.code === 'ENOTFOUND' || e?.code === 'ECONNREFUSED') {
    console.error(`  ${tag} ${symbol}: NETWORK ERROR (${e.code}) — ${context}`);
  } else {
    console.error(`  ${tag} ${symbol}: ${e?.message ?? e} — ${context}`);
  }

  if (bodyExcerpt) console.error(`    Body: ${bodyExcerpt}`);
}

// ─── CIK LOOKUP ──────────────────────────────────────────────────────────────

async function getCIK(symbol) {
  if (_cikCache[symbol]) return _cikCache[symbol];
  try {
    const res = await axios.get('https://www.sec.gov/files/company_tickers.json', {
      headers: SEC_UA, timeout: 10000,
    });
    const company = Object.values(res.data || {}).find(
      c => c.ticker === symbol.toUpperCase()
    );
    if (!company) {
      console.warn(`  [CIK] ${symbol}: not found in SEC company_tickers.json`);
      return null;
    }
    const cik = company.cik_str.toString().padStart(10, '0');
    _cikCache[symbol] = cik;
    return cik;
  } catch (e) {
    logHttpError('[CIK]', symbol, 'company_tickers.json', e);
    return null;
  }
}

// ─── HTML CLEANER ─────────────────────────────────────────────────────────────

function cleanTextFromHtml(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&#8217;|&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── SECTION EXTRACTOR ───────────────────────────────────────────────────────
// Finds the best occurrence of a section by trying each start match and picking
// the one that produces the longest result before the end boundary.
// "Best" = longest (avoids picking Table of Contents one-liner).

function getAllMatchIndexes(text, regex) {
  const rx = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  const matches = [];
  let m;
  while ((m = rx.exec(text)) !== null) {
    matches.push(m.index);
    if (m.index === rx.lastIndex) rx.lastIndex++;
  }
  return matches;
}

function chooseBestSection(text, startRegex, endRegexList, opts = {}) {
  const {
    minLen          = 1800,
    maxLen          = 150000,
    minStartRatio   = 0.06,   // ignore matches in first 6% (TOC / cover page)
    hardCap         = 30000,
  } = opts;

  const starts = getAllMatchIndexes(text, startRegex);
  if (!starts.length) return null;

  let best = null;

  for (const start of starts) {
    if (start < Math.floor(text.length * minStartRatio)) continue;

    // Find nearest end boundary
    let nearestEnd = -1;
    for (const endRegex of endRegexList) {
      const tail = text.slice(start + 50);
      const m = tail.match(endRegex);
      if (!m || m.index == null) continue;
      const end = start + 50 + m.index;
      if (end > start && (nearestEnd === -1 || end < nearestEnd)) nearestEnd = end;
    }

    if (nearestEnd === -1) continue;
    const len = nearestEnd - start;
    if (len < minLen || len > maxLen) continue;
    if (!best || len > best.len) best = { start, end: nearestEnd, len };
  }

  if (!best) return null;
  return text.slice(best.start, best.end).trim().slice(0, hardCap);
}

// ─── MD&A EXTRACTION ──────────────────────────────────────────────────────────
// 10-K: Item 7 → Item 7A or Item 8
// 10-Q: Item 2 → Item 3 or Item 4 or Part II Item 1
// Falls back to a heuristic middle-of-document slice if boundaries aren't found.

function extractMDASection(cleanText, form) {
  if (!cleanText || cleanText.length < 2000) return null;

  const is10K = form === '10-K';
  const is10Q = form === '10-Q';
  const hardCap = is10K ? MDA_HARD_CAP_10K : MDA_HARD_CAP_10Q;

  if (is10K) {
    const strictStart = /item\s*7\s*[.:\-]?\s*management'?s\s+discussion\s+and\s+analysis\s+of\s+financial\s+condition\s+and\s+results\s+of\s+operations/i;
    const looseStart  = /management'?s\s+discussion\s+and\s+analysis/i;
    const endBounds   = [
      /item\s*7a\s*[.:\-]?\s*quantitative\s+and\s+qualitative\s+disclosures\s+about\s+market\s+risk/i,
      /item\s*8\s*[.:\-]?\s*financial\s+statements\s+and\s+supplementary\s+data/i,
    ];
    const opts = { minLen: 2200, maxLen: 170000, minStartRatio: 0.08, hardCap };

    return chooseBestSection(cleanText, strictStart, endBounds, opts)
        ?? chooseBestSection(cleanText, looseStart,  endBounds, opts)
        ?? cleanText.slice(Math.floor(cleanText.length * 0.18), Math.floor(cleanText.length * 0.65)).slice(0, hardCap);
  }

  if (is10Q) {
    const strictStart = /item\s*2\s*[.:\-]?\s*management'?s\s+discussion\s+and\s+analysis\s+of\s+financial\s+condition\s+and\s+results\s+of\s+operations/i;
    const looseStart  = /management'?s\s+discussion\s+and\s+analysis/i;
    const endBounds   = [
      /item\s*3\s*[.:\-]?\s*quantitative\s+and\s+qualitative\s+disclosures\s+about\s+market\s+risk/i,
      /item\s*4\s*[.:\-]?\s*controls\s+and\s+procedures/i,
      /part\s*ii\s*item\s*1/i,
    ];
    const opts = { minLen: 1800, maxLen: 120000, minStartRatio: 0.06, hardCap };

    return chooseBestSection(cleanText, strictStart, endBounds, opts)
        ?? chooseBestSection(cleanText, looseStart,  endBounds, opts)
        ?? cleanText.slice(Math.floor(cleanText.length * 0.15), Math.floor(cleanText.length * 0.65)).slice(0, hardCap);
  }

  // Unknown form type — take substantive middle
  return cleanText.slice(Math.floor(cleanText.length * 0.18), Math.floor(cleanText.length * 0.65)).slice(0, 30000);
}

// ─── RISK FACTORS EXTRACTION ──────────────────────────────────────────────────
// Appended after MD&A so Gemini can identify new / intensified / removed risks.
// Item 1A (10-K) or Part II Item 1A (10-Q).

function extractRiskSection(cleanText) {
  const RISK_START = /item\s*1a[.:\s]*risk\s+factors|part\s+ii[,.]?\s*item\s*1[.:\s]*risk\s+factors/gi;
  const RISK_END   = /item\s*(?:1b|2)\s*[.:\-]/gi;

  const starts = getAllMatchIndexes(cleanText, RISK_START);
  if (!starts.length) return '';

  const riskStart  = starts[starts.length - 1]; // last = actual section (not TOC)
  const riskWindow = cleanText.slice(riskStart + 50, riskStart + RISK_HARD_CAP + 5000);
  const endMatch   = riskWindow.match(RISK_END);
  const rawRisk    = endMatch
    ? cleanText.slice(riskStart, riskStart + 50 + endMatch.index)
    : cleanText.slice(riskStart, riskStart + RISK_HARD_CAP);

  return rawRisk.slice(0, RISK_HARD_CAP);
}

// ─── SEC FETCH ────────────────────────────────────────────────────────────────

async function fetchLatest10KQ(cik) {
  const res = await axios.get(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: SEC_UA, timeout: 12000,
  });
  const recent = res.data?.filings?.recent;
  if (!recent?.form?.length) return null;

  const idx = recent.form.findIndex(f => f === '10-K' || f === '10-Q');
  if (idx === -1) return null;

  return {
    form:            recent.form[idx],
    accessionNumber: recent.accessionNumber[idx],
    accessionRaw:    String(recent.accessionNumber[idx] || '').replace(/-/g, ''),
    filed:           recent.filingDate[idx],
    period:          recent.reportDate?.[idx] || null,
    primaryDocument: recent.primaryDocument?.[idx] || null,
  };
}

async function fetchPrimaryDocument(cik, filingMeta) {
  const cikNum = cik.replace(/^0+/, '');

  // Attempt 1: use primaryDocument field from submissions JSON (most reliable)
  if (filingMeta.primaryDocument) {
    const url = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${filingMeta.accessionRaw}/${filingMeta.primaryDocument}`;
    try {
      const res = await axios.get(url, { headers: SEC_UA, timeout: 20000 });
      if (res.data && String(res.data).length > 500) return res.data;
    } catch (e) {
      logHttpError('[EDGAR]', cikNum, `primaryDocument: ${filingMeta.primaryDocument}`, e);
    }
  }

  // Attempt 2: structured index.json — find the form-type document
  const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${filingMeta.accessionRaw}/index.json`;
  let items = [];
  try {
    const idxRes = await axios.get(indexUrl, { headers: SEC_UA, timeout: 10000 });
    items = idxRes.data?.directory?.item ?? [];
  } catch (e) {
    logHttpError('[EDGAR]', cikNum, indexUrl, e);
  }

  // Priority: exact form type match → largest non-exhibit .htm → any .htm → .txt
  const nonExhibit = items.filter(i => !/^EX-/i.test(i.type ?? ''));
  const parseSize  = s => {
    if (!s) return 0;
    const [n, u] = s.trim().split(' ');
    const v = parseFloat(n) || 0;
    if (u?.startsWith('M')) return v * 1024;
    if (u?.startsWith('K')) return v;
    return v / 1024;
  };
  const sortedHtm = nonExhibit
    .filter(i => /\.htm$/i.test(i.name ?? ''))
    .sort((a, b) => parseSize(b.size) - parseSize(a.size));

  const chosen =
    items.find(i => i.type === filingMeta.form && /\.htm$/i.test(i.name ?? '')) ??
    sortedHtm[0] ??
    nonExhibit.find(i => /\.txt$/i.test(i.name ?? ''));

  if (!chosen?.name) throw new Error(`No primary document found in index.json for ${cikNum}/${filingMeta.accessionRaw}`);

  const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${filingMeta.accessionRaw}/${chosen.name}`;
  const docRes = await axios.get(docUrl, { headers: SEC_UA, timeout: 25000 });
  return docRes.data;
}

// ─── fetchMDA ─────────────────────────────────────────────────────────────────

async function fetchMDA(symbol) {
  const cik = await getCIK(symbol);
  if (!cik) return { status: 'error', reason: 'CIK not found' };

  let filingMeta;
  try {
    filingMeta = await fetchLatest10KQ(cik);
  } catch (e) {
    logHttpError('[EDGAR]', symbol, `submissions/CIK${cik}.json`, e);
    return { status: 'error', reason: 'submissions fetch failed' };
  }

  if (!filingMeta) return { status: 'error', reason: 'no 10-K/10-Q in recent filings' };

  // Duplicate-filing guard — skip if we already processed this accession
  try {
    const rc = createRedisClient({ url: process.env.REDIS_URL });
    rc.on('error', () => {});
    await rc.connect();
    const last = await rc.get(`filing_narrative_acc_${symbol}`);
    await rc.quit();
    if (last === filingMeta.accessionNumber) {
      console.log(`  ${symbol}: ${filingMeta.form} ${filingMeta.accessionNumber} already processed — skipping`);
      return { status: 'already_processed' };
    }
  } catch (e) {
    console.warn(`  [Redis] ${symbol}: duplicate-check failed (${e.message}) — proceeding`);
  }

  let rawDoc;
  try {
    rawDoc = await fetchPrimaryDocument(cik, filingMeta);
  } catch (e) {
    logHttpError('[EDGAR]', symbol, 'primary document fetch', e);
    return { status: 'error', reason: 'document fetch failed' };
  }

  const fullText = cleanTextFromHtml(rawDoc);
  if (!fullText || fullText.length < 2000) {
    console.error(`  [EDGAR] ${symbol}: Cleaned text too short (${fullText?.length ?? 0} chars)`);
    return { status: 'error', reason: 'cleaned text too short' };
  }

  const mdaText  = extractMDASection(fullText, filingMeta.form);
  const riskText = extractRiskSection(fullText);

  if (!mdaText || mdaText.length < 1200) {
    console.warn(`  [EDGAR] ${symbol}: MD&A extraction too short (${mdaText?.length ?? 0} chars) — skipping`);
    return { status: 'error', reason: 'MD&A extraction too short' };
  }

  const quality = mdaText.length >= 4000 ? 'good' : 'partial';
  console.log(
    `  [EDGAR] ${symbol}: ${filingMeta.form} — MD&A ${mdaText.length} chars (${quality})` +
    `${riskText ? `, Risk ${riskText.length} chars` : ''}, filed ${filingMeta.filed}`
  );

  const combinedText = riskText
    ? `=== MD&A ===\n${mdaText}\n\n=== RISK FACTORS ===\n${riskText}`
    : mdaText;

  return {
    status:          'ok',
    text:            combinedText,
    form:            filingMeta.form,
    filed:           filingMeta.filed,
    period:          filingMeta.period,
    accessionNumber: filingMeta.accessionNumber,
    mdaLength:       mdaText.length,
    riskLength:      riskText.length,
  };
}

// ─── GEMINI PROMPT ────────────────────────────────────────────────────────────

function buildPrompt(symbol, stock, filingText, filingMeta) {
  const companyName = stock.name   || symbol;
  const sector      = stock.sector || 'unknown sector';

  return `You are conducting a rigorous independent analysis of a ${filingMeta.form} filing.
You are NOT a booster. You are a skeptical long-horizon equity analyst for a concentrated
compounder fund targeting 22% CAGR by 2030. Your job is to find truth, not to agree with management.

INVESTOR MANDATE:
- Concentrated portfolio (15-20 stocks), 3-7 year holding periods minimum
- Framework: ROIC durability, FCF quality, revenue growth trajectory, capital allocation discipline
- Currently holds this stock — assessing whether to maintain, add to, or reduce

COMPANY: ${companyName} (${symbol}), sector: ${sector}
FILING TYPE: ${filingMeta.form}, period ending ${filingMeta.period ?? filingMeta.filed}

FILING TEXT (MD&A + Risk Factors):
${filingText}

════════ CITATION RULES — MANDATORY ════════
1. Every percentage, dollar figure, or unit you cite MUST appear verbatim in the text above.
   If you cannot find a specific figure, write "not stated" — do NOT estimate or invent.
2. Your training knowledge of ${companyName} MAY be used ONLY for context (what the business
   does, what metrics matter historically) — NOT for specific numbers in this filing.
3. Do NOT accept management forward-looking statements at face value.
   Label them "mgmt guidance:" and add a one-word credibility assessment (credible/uncertain/optimistic).
4. "Stable" thesis_status requires concrete positive evidence — not merely absence of bad news.
5. new_risks must reflect language that is genuinely new or materially escalated vs typical boilerplate.
6. evidence_quotes MUST be short verbatim snippets (max 20 words each) copied exactly from the text.
7. uncertainty_flags must list specific claims you could not verify from the provided text.
═══════════════════════════════════════════

Return ONLY a JSON object matching the schema exactly.`;
}

// ─── GEMINI CALL WITH RETRY ────────────────────────────────────────────────────

const GEMINI_SCHEMA = {
  type: 'object',
  properties: {
    thesis_status:          { type: 'string', enum: ['strengthening', 'stable', 'weakening', 'unclear'] },
    key_changes:            { type: 'array', items: { type: 'string' }, maxItems: 4 },
    thesis_confirms:        { type: 'array', items: { type: 'string' }, maxItems: 3 },
    thesis_risks:           { type: 'array', items: { type: 'string' }, maxItems: 3 },
    guidance_changes:       { type: 'array', items: { type: 'string' }, maxItems: 2 },
    management_confidence:  { type: 'integer', minimum: 1, maximum: 5 },
    new_risks:              { type: 'array', items: { type: 'string' }, maxItems: 2 },
    summary:                { type: 'string' },
    has_regulatory_moat:    { type: 'boolean' },
    regulatory_moat_type:   { type: 'string' },
    regulatory_moat_strength: { type: 'integer', minimum: 0, maximum: 5 },
    dual_class_warning:     { type: 'string' },   // nullable via empty string — Gemini doesn't support nullable:true in schema
    evidence_quotes:        { type: 'array', items: { type: 'string' }, maxItems: 3 },
    uncertainty_flags:      { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: [
    'thesis_status', 'key_changes', 'thesis_confirms', 'thesis_risks',
    'guidance_changes', 'management_confidence', 'new_risks', 'summary',
    'has_regulatory_moat', 'regulatory_moat_type', 'regulatory_moat_strength',
    'dual_class_warning', 'evidence_quotes', 'uncertainty_flags',
  ],
};

async function callGeminiWithRetry(payload, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await axios.post(
        `${GEMINI_ENDPOINT}?key=${process.env.GEMINI_API_KEY}`,
        payload,
        { timeout: 60000 }
      );
    } catch (e) {
      lastErr = e;
      const status    = e?.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt === maxAttempts) break;
      const waitMs = 1000 * attempt * attempt; // 1s, 4s, 9s
      console.warn(`  [Gemini] retry ${attempt}/${maxAttempts} after HTTP ${status} (${waitMs}ms)`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

async function analyseFilingWithGemini(symbol, stock, filingText, filingMeta) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('  ⚠ GEMINI_API_KEY not set — skipping analysis');
    return null;
  }

  const prompt = buildPrompt(symbol, stock, filingText, filingMeta);

  let res;
  try {
    res = await callGeminiWithRetry({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema:   GEMINI_SCHEMA,
        temperature:      0.1,   // slightly above 0 — pure 0 + schema causes 400 on some inputs
        // topP removed — conflicts with responseSchema in Gemini 2.5 Flash
      },
    }, 3);
  } catch (e) {
    logHttpError('[Gemini]', symbol, `${GEMINI_ENDPOINT} (${filingMeta.form})`, e);
    return null;
  }

  const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    const finishReason = res.data?.candidates?.[0]?.finishReason;
    console.error(`  [Gemini] ${symbol}: empty response — finishReason: ${finishReason}`);
    console.error(`    promptFeedback: ${JSON.stringify(res.data?.promptFeedback)}`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`  [Gemini] ${symbol}: JSON parse failed`);
    console.error(`    raw (first 400 chars): ${raw.slice(0, 400)}`);
    return null;
  }

  // Sanity guard
  if (!parsed?.summary || !Array.isArray(parsed?.key_changes)) {
    console.error(`  [Gemini] ${symbol}: schema mismatch — missing summary or key_changes`);
    return null;
  }

  // Warn if summary has no number — common hallucination signal
  if (!/\d/.test(parsed.summary ?? '')) {
    console.warn(`  [Gemini] ${symbol}: summary contains no number — possible citation failure`);
  }

  console.log(`  [Gemini] ${symbol}: ${parsed.thesis_status} — ${parsed.summary}`);
  return parsed;
}

// ─── SAVE TO REDIS ────────────────────────────────────────────────────────────
// Payload write first (data safe), accession marker last (marks filing as done).
// If accession marker write fails, next run re-processes but gets same result.

async function save(symbol, filingMeta, geminiResult) {
  const payload = {
    symbol,
    form:            filingMeta.form,
    filed:           filingMeta.filed,
    period:          filingMeta.period,
    accessionNumber: filingMeta.accessionNumber,
    mdaLength:       filingMeta.mdaLength,
    riskLength:      filingMeta.riskLength,
    gemini:          geminiResult,
    processedAt:     new Date().toISOString(),
  };

  const client = createRedisClient({ url: process.env.REDIS_URL });
  client.on('error', err => console.error(`  [Redis] connection error: ${err.message}`));

  try {
    await client.connect();
  } catch (e) {
    console.error(`  [Redis] ${symbol}: connect failed — ${e.message} — result NOT saved`);
    return false;
  }

  try {
    await client.set(`filing_narrative_${symbol}`, JSON.stringify(payload));
    await client.set(`filing_narrative_acc_${symbol}`, filingMeta.accessionNumber);
    console.log(`  ✅ ${symbol}: filing_narrative saved to Redis (${Buffer.byteLength(JSON.stringify(payload))} bytes)`);
    return true;
  } catch (e) {
    console.error(`  [Redis] ${symbol}: write failed — ${e.message}`);
    return false;
  } finally {
    try { await client.quit(); } catch (_) {}
  }
}

// ─── SUPABASE AUDIT LOG ───────────────────────────────────────────────────────
// Optional — failure does not block the core pipeline.

async function logToSupabase(symbol, filingMeta, geminiResult) {
  try {
    const { error } = await supabase.from('earnings_events').insert({
      symbol,
      event_type:  'filing_narrative',
      event_date:  filingMeta.filed,   // matches migrations.sql column name
      payload: {
        form:            filingMeta.form,
        period:          filingMeta.period,
        accessionNumber: filingMeta.accessionNumber,
        thesis_status:   geminiResult.thesis_status,
        summary:         geminiResult.summary,
        processedAt:     new Date().toISOString(),
      },
    });
    if (error) {
      // Detailed error logging — show column name to catch schema mismatches quickly
      console.warn(`  [Supabase] ${symbol}: audit log failed — ${error.message} (code: ${error.code})`);
      if (error.message?.includes('column')) {
        console.warn(`  [Supabase] Note: run migrations.sql to ensure earnings_events has event_date column`);
      }
    }
  } catch (e) {
    console.warn(`  [Supabase] ${symbol}: audit log threw — ${e.message}`);
  }
}

// ─── MARKET OPEN CHECK ────────────────────────────────────────────────────────
// Reads the Polygon market status written by daily-update.js (12h TTL).
// FORCE_RUN=true (set by pipeline.yml on workflow_dispatch) bypasses this gate
// so manual runs work on weekends/holidays — matching master and news behaviour.

async function checkMarketOpen() {
  // Manual runs always bypass — FORCE_RUN set by the YAML on workflow_dispatch
  if (process.env.FORCE_RUN === 'true') {
    console.log('  [Market] FORCE_RUN=true — bypassing market-closed check');
    return true;
  }

  const todayStr = new Date().toISOString().split('T')[0];
  try {
    const rc = createRedisClient({ url: process.env.REDIS_URL });
    rc.on('error', () => {});
    await rc.connect();
    const cached = await rc.get(`market_open_${todayStr}`).catch(() => null);
    await rc.quit();
    if (cached === 'closed') {
      console.log('  [Market] Polygon status: closed');
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`  [Market] Redis check failed (${e.message}) — failing open`);
    return true; // prefer running over silent skip
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  const today     = new Date().toISOString().split('T')[0];

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' FILING NARRATIVE ANALYSER — 10-K / 10-Q MD&A');
  console.log(`  Date:  ${today}`);
  console.log(`  Model: gemini-2.5-flash (stable GA)`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const isOpen = await checkMarketOpen();
  if (!isOpen) {
    console.log('🏖️  Market closed today — skipping filing-narrative run.');
    process.exit(0);
  }

  // Load portfolio from Redis
  let portfolio;
  const portfolioClient = createRedisClient({ url: process.env.REDIS_URL });
  portfolioClient.on('error', err => console.error(`[Redis] portfolio: ${err.message}`));

  try {
    await portfolioClient.connect();
    const raw = await portfolioClient.get('portfolio');
    await portfolioClient.quit();
    if (!raw) { console.log('No portfolio found in Redis.'); process.exit(0); }
    portfolio = JSON.parse(raw);
  } catch (e) {
    console.error(`[Redis] Failed to load portfolio: ${e.message}`);
    try { await portfolioClient.quit(); } catch (_) {}
    process.exit(1);
  }

  // Exclude ETFs — they don't file 10-K/10-Q with MD&A
  const stocks = (portfolio.stocks || []).filter(
    s => s.type !== 'ETF' && s.instrument_type !== 'ETF'
  );

  console.log(`Stocks (excl. ETFs): ${stocks.map(s => s.symbol).join(', ')}\n`);

  let processed = 0;
  let skipped   = 0;  // already processed this filing
  let failed    = 0;  // fetch/parse/Gemini/save errors

  for (const stock of stocks) {
    const symbol = String(stock.symbol || '').toUpperCase();
    if (!symbol) continue;

    console.log(`\n─── ${symbol} ──────────────────────────────────────────`);

    const result = await fetchMDA(symbol);

    if (result.status === 'already_processed') { skipped++; continue; }
    if (result.status === 'error') {
      console.error(`  ${symbol}: fetchMDA failed — ${result.reason}`);
      failed++;
      continue;
    }

    // result.status === 'ok'
    const geminiResult = await analyseFilingWithGemini(symbol, stock, result.text, result);

    if (!geminiResult) { failed++; continue; }

    const saved = await save(symbol, result, geminiResult);
    if (!saved) { failed++; continue; }

    await logToSupabase(symbol, result, geminiResult);
    processed++;

    // Pace requests — SEC 10 req/s + Gemini free tier ~15 RPM
    await sleep(1500);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(` Filing Narrative Analyser complete in ${elapsed}s`);
  console.log(`   Processed : ${processed}`);
  console.log(`   Skipped   : ${skipped}  (already processed this filing)`);
  console.log(`   Failed    : ${failed}`);
  console.log('═══════════════════════════════════════════════════════════');

  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
