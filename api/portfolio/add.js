import { createClient } from 'redis';

// ─── REDIS CLIENT ────────────────────────────────────────────────────────────

let redisClient = null;

async function getRedisClient() {
  if (!redisClient) {
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on('error', err => console.error('Redis error:', err));
    await redisClient.connect();
  }
  return redisClient;
}

// ─── INSTRUMENT ENRICHMENT ────────────────────────────────────────────────────
//
// Two-source enrichment pipeline, run in parallel on add:
//
// Source A — FMP profile (primary for sector/industry/name/ETF flag):
//   Returns: companyName, sector, industry, exchange, country, currency,
//            isEtf (bool), isFund (bool), isActivelyTrading (bool), image
//   Free tier: 250 calls/day — one add = 1 call, fine.
//
// Source B — Finnhub profile2 (primary for instrument type classification):
//   Returns: type ("Common Stock", "ETP", "REIT", "DR", etc.), name,
//            exchange, country, expenseRatio (for ETFs)
//   Free tier: 60 calls/min — one add = 2 calls (profile2 + quote), fine.
//
// ETF detection logic (belt-and-suspenders):
//   1. FMP isEtf === true  → ETF
//   2. FMP isFund === true → ETF (closed-end funds, interval funds)
//   3. Finnhub type in ['ETP','ETF','Closed-End Fund','REIT','Open-End Fund'] → ETF
//   4. Otherwise → Stock (or ADR, preferred share — treated as stock)
//
// This handles ANY instrument you might add in the future — SHLD, AVNV, any
// new ETF, REIT, ADR — without ever touching this file.

async function enrichInstrument(symbol) {
  const result = {
    name:            symbol,          // official company/fund name
    sector:          'Unknown',
    industry:        'Unknown',
    exchange:        null,
    country:         null,
    currency:        'USD',
    isETF:           false,           // confirmed via dual-source check
    instrumentType:  'Common Stock',  // raw Finnhub type string
    expenseRatio:    null,            // annual % cost (ETFs only)
    isActivelyTrading: true,
    logoUrl:         null,
    currentPrice:    0,
    changePercent:   0,
  };

  // ── Parallel fetch: FMP profile + Finnhub profile2 + Finnhub quote ──────────
  const [fmpData, finnhubProfile, finnhubQuote] = await Promise.allSettled([
    fetch(
      `https://financialmodelingprep.com/api/v3/profile/${symbol}?apikey=${process.env.FMP_API_KEY}`,
      { signal: AbortSignal.timeout(8000) }
    ).then(r => r.json()).catch(() => null),

    fetch(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`,
      { signal: AbortSignal.timeout(6000) }
    ).then(r => r.json()).catch(() => null),

    fetch(
      `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`,
      { signal: AbortSignal.timeout(6000) }
    ).then(r => r.json()).catch(() => null),
  ]);

  // ── Process FMP ─────────────────────────────────────────────────────────────
  const fmp = fmpData.status === 'fulfilled' && fmpData.value?.[0]
    ? fmpData.value[0] : null;

  if (fmp) {
    if (fmp.companyName) result.name    = fmp.companyName;
    if (fmp.sector)      result.sector  = fmp.sector  || 'Unknown';
    if (fmp.industry)    result.industry = fmp.industry || 'Unknown';
    if (fmp.exchangeShortName) result.exchange = fmp.exchangeShortName;
    if (fmp.country)     result.country  = fmp.country;
    if (fmp.currency)    result.currency = fmp.currency;
    if (fmp.image)       result.logoUrl  = fmp.image;
    if (fmp.isActivelyTrading === false) result.isActivelyTrading = false;

    // ETF detection via FMP — most reliable for US ETFs
    if (fmp.isEtf === true || fmp.isFund === true) {
      result.isETF = true;
    }
  }

  // ── Process Finnhub profile ──────────────────────────────────────────────────
  const fhProfile = finnhubProfile.status === 'fulfilled' && finnhubProfile.value
    ? finnhubProfile.value : null;

  if (fhProfile) {
    // Override name from Finnhub only if FMP didn't provide one
    if (!fmp?.companyName && fhProfile.name) result.name = fhProfile.name;

    // Store raw type string for logging
    if (fhProfile.type) result.instrumentType = fhProfile.type;

    // ETF detection via Finnhub — catches types FMP might miss
    const ETF_TYPES = new Set(['ETP', 'ETF', 'Closed-End Fund', 'REIT', 'Open-End Fund']);
    if (ETF_TYPES.has(fhProfile.type)) {
      result.isETF = true;
    }

    // Expense ratio — Finnhub provides this for ETFs in decimal (e.g. 0.0013 = 0.13%)
    if (fhProfile.expenseRatio != null) {
      result.expenseRatio = parseFloat((fhProfile.expenseRatio * 100).toFixed(4));
    }

    // Exchange and country from Finnhub if not from FMP
    if (!result.exchange && fhProfile.exchange) result.exchange = fhProfile.exchange;
    if (!result.country  && fhProfile.country)  result.country  = fhProfile.country;
  }

  // ── Process Finnhub quote (initial price) ────────────────────────────────────
  const fhQuote = finnhubQuote.status === 'fulfilled' && finnhubQuote.value
    ? finnhubQuote.value : null;

  if (fhQuote?.c > 0) {
    result.currentPrice   = fhQuote.c;
    result.changePercent  = fhQuote.dp || 0;
  }

  return result;
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { symbol, quantity, average_price, type: manualType } = req.body;

    // ── Input validation ────────────────────────────────────────────────────
    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ error: 'Symbol is required' });
    }
    const cleanSymbol = symbol.trim().toUpperCase();
    if (cleanSymbol.length === 0 || cleanSymbol.length > 10) {
      return res.status(400).json({ error: 'Symbol must be 1–10 characters' });
    }
    const qty   = quantity      ? parseFloat(quantity)      : 0;
    const avgPx = average_price ? parseFloat(average_price) : 0;
    if (isNaN(qty) || qty < 0) {
      return res.status(400).json({ error: 'Quantity must be a non-negative number' });
    }
    if (isNaN(avgPx) || avgPx < 0) {
      return res.status(400).json({ error: 'Average price must be a non-negative number' });
    }

    // ── Load portfolio ───────────────────────────────────────────────────────
    const client = await getRedisClient();
    let portfolio = { stocks: [], lastUpdated: null };
    try {
      const raw = await client.get('portfolio');
      if (raw) portfolio = JSON.parse(raw);
    } catch (e) {
      console.error('Redis read error:', e);
    }

    // Duplicate check — case-insensitive
    if (portfolio.stocks.find(s => s.symbol.toUpperCase() === cleanSymbol)) {
      return res.status(400).json({ error: `${cleanSymbol} is already in your portfolio` });
    }

    // ── Enrich instrument data ───────────────────────────────────────────────
    // Runs profile2 + profile + quote in parallel — total ~6–8s worst case.
    // This is a one-time cost on add, not per-day. Worth the wait.
    let enriched = {
      name: cleanSymbol, sector: 'Unknown', industry: 'Unknown',
      exchange: null, country: null, currency: 'USD',
      isETF: false, instrumentType: 'Common Stock',
      expenseRatio: null, isActivelyTrading: true,
      logoUrl: null, currentPrice: 0, changePercent: 0,
    };

    try {
      enriched = await enrichInstrument(cleanSymbol);
      console.log(`[add] ${cleanSymbol}: type=${enriched.instrumentType} isETF=${enriched.isETF} price=${enriched.currentPrice}`);
    } catch (e) {
      console.error(`[add] Enrichment failed for ${cleanSymbol}:`, e.message);
      // Non-fatal — stock is added with defaults, EOD run will fill in data
    }

    // ── Manual type override ─────────────────────────────────────────────────
    // If the user explicitly passed type='ETF' in the request body, respect that.
    // This is a safety valve for instruments our APIs might misclassify.
    if (manualType === 'ETF' || manualType === 'etf') {
      enriched.isETF = true;
    }
    if (manualType === 'Stock' || manualType === 'stock') {
      enriched.isETF = false; // override if user corrects a misclassification
    }

    // ── Build stock object ───────────────────────────────────────────────────
    const newStock = {
      id:           Date.now().toString(),
      symbol:       cleanSymbol,
      name:         enriched.name,
      type:         enriched.isETF ? 'ETF' : 'Stock',
      instrument_type_raw: enriched.instrumentType,  // e.g. "ETP", "Common Stock", "REIT"
      region:       enriched.country || req.body.region || 'Global',
      sector:       enriched.sector,
      industry:     enriched.industry,
      exchange:     enriched.exchange,
      currency:     enriched.currency,
      expense_ratio: enriched.expenseRatio,          // null for stocks, % for ETFs
      logo_url:     enriched.logoUrl,
      is_actively_trading: enriched.isActivelyTrading,

      // Position data
      quantity:       qty,
      average_price:  avgPx,

      // Live data — populated immediately from Finnhub quote, updated nightly
      current_price:  enriched.currentPrice,
      change_percent: enriched.changePercent,

      // Score defaults — will be populated by first EOD run
      latest_score:   5,
      signal:         'HOLD',
      instrument_type: enriched.isETF ? 'ETF' : 'Stock',

      // Timestamps
      createdAt:  new Date().toISOString(),
      updatedAt:  new Date().toISOString(),
    };

    // ── Save to Redis ────────────────────────────────────────────────────────
    portfolio.stocks.push(newStock);
    portfolio.lastUpdated = new Date().toISOString();
    await client.set('portfolio', JSON.stringify(portfolio));

    // ── Response ─────────────────────────────────────────────────────────────
    return res.status(201).json({
      status:    'success',
      message:   `${cleanSymbol} added successfully`,
      stock:     newStock,
      detected:  {
        type:         newStock.type,
        name:         newStock.name,
        sector:       newStock.sector,
        price:        newStock.current_price,
        expense_ratio: newStock.expense_ratio,
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Add stock error:', error);
    return res.status(500).json({
      error:   'Failed to add instrument',
      message: error.message,
    });
  }
}
