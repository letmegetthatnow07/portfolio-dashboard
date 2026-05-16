#!/usr/bin/env node
'use strict';

/**
 * PORTFOLIO REGIME ANALYSIS ENGINE — EOD Master Run
 *
 * Architecture:
 *   - Supabase  → permanent time-series history (daily_metrics, regime_flags, fundamentals)
 *   - Redis     → frontend cache (optional, graceful fallback if unavailable)
 *   - CSV       → local backup log
 *
 * NEWS HANDLING (changed from previous version):
 *   News is NO LONGER fetched here. The three intraday runs (news-update.js)
 *   log their scores to Supabase's intraday_news_log table throughout the day.
 *   This master run reads those logs at EOD and computes a recency-weighted
 *   average across all available runs. This gives a better daily news signal
 *   than a single late-day fetch and eliminates duplicate API calls.
 *
 * Array convention: index 0 = OLDEST, index N-1 = MOST RECENT (today)
 */

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const axios        = require('axios');
const logger       = require('../lib/logger');
const quantEngine  = require('../lib/quant-engine');

const { createClient: createRedisClient }    = require('redis');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const SLEEP_BETWEEN_STOCKS_MS = 15000;
const TODAY = new Date().toISOString().split('T')[0];

// ─── US MARKET HOLIDAY DETECTION — POLYGON UPCOMING HOLIDAYS ────────────────
// ─── US MARKET HOLIDAY DETECTION — POLYGON UPCOMING HOLIDAYS ────────────────
// F01 FIX: The previous implementation used /v1/marketstatus/now which returns
// 'closed' after 4 PM ET on EVERY trading day — including the evening when our
// EOD run fires (22:00 UTC = 5-6 PM ET). This caused the run to silently skip
// on every normal trading day. Only weekends and pre-4PM calls would succeed.
//
// Correct approach: use /v1/marketstatus/upcoming to get the list of upcoming
// market holidays, then check if TODAY's date appears in that list.
// Also check if today is a weekend (Saturday/Sunday) — always closed.
// This is date-based, not real-time-status-based, so it works at any hour.
//
// Result cached in Redis for 24h per date — one API call per calendar day.
async function isMarketClosedToday(redisClient) {
  const cacheKey = `market_holiday_${TODAY}`;
  const cached   = await redisClient.get(cacheKey).catch(() => null);
  if (cached !== null) return cached === '1';

  const dayOfWeek = new Date(TODAY + 'T12:00:00Z').getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    await redisClient.set(cacheKey, '1', { EX: 86400 }).catch(() => {});
    return true;
  }

  try {
    const res = await axios.get(
      `https://api.polygon.io/v1/marketstatus/upcoming?apiKey=${process.env.POLYGON_API_KEY}`,
      { timeout: 6000 }
    );
    const holidays = res.data ?? [];
    const isHoliday = holidays.some(h => h.date === TODAY && h.status === 'closed');
    await redisClient.set(cacheKey, isHoliday ? '1' : '0', { EX: 86400 }).catch(() => {});
    logger.info(`  Market holiday check: ${TODAY} = ${isHoliday ? 'HOLIDAY' : 'trading day'}`);
    return isHoliday;
  } catch (e) {
    logger.warn(`Polygon upcoming holidays check failed: ${e.message} — assuming trading day`);
    return false;
  }
}

// ─── SCORING PARAMETERS ──────────────────────────────────────────────────────
// E6: All scoring thresholds in one place — tune here without hunting through calculateScore.
// Each value is documented with its calibration rationale.
const SCORING_PARAMS = {
  ROIC_FLOOR:              0.08,
  ROIC_RANGE:              0.22,
  FCF_MARGIN_DIVISOR:      0.15,
  CAPEX_FCF_BONUS:         2.5,
  HYPERGROWTH_CAGR_MIN:    0.20,
  HYPERGROWTH_GM_MIN:      0.60,
  CYCLICAL_PEAK_MULTIPLE:  1.50,
  CYCLICAL_PEAK_SCORE_CAP: 6.5,
  SBC_HEAVY_THRESHOLD:     0.25,
  SBC_WATCH_THRESHOLD:     0.10,
  REV_GROWTH_NEUTRAL_SCORE: 4,
  REV_GROWTH_DIVISOR:      0.042,
  EVENT_8K_LOOKBACK_DAYS:  60,
  EVENT_8K_MIN_DECAY:      0.15,
  INSIDER_MIN_BUY_USD:     50_000,
};

const VALID_SIGNALS = [
  'STRONG_BUY', 'BUY', 'HOLD', 'WATCH',
  'TRIM_25', 'SELL', 'SPRING_CANDIDATE', 'SPRING_CONFIRMED', 'ADD',
  'HOLD_NOISE', 'NORMAL', 'INSUFFICIENT_DATA', 'IDIOSYNCRATIC_DECAY', 'REDUCE',
  'MARKET_NOISE',
];

// ─── UTILITY: URL SANITISER ─────────────────────────────────────────────────
// W2: Strips API keys from URLs that appear in error messages.
// Axios error messages sometimes include the full request URL with embedded keys.
// Without this, keys can appear in GitHub Actions logs or external log services.
function sanitizeMsg(msg) {
  if (!msg) return msg;
  return String(msg).replace(/([?&](apiKey|token|apikey|key|api_key)=)[^&\s]+/gi, '$1[REDACTED]');
}

// ─── INSTRUMENT TYPE DETECTION ────────────────────────────────────────────────
// Instrument type is auto-detected via Finnhub profile2 API, not a hardcoded list.
// This means any ticker you add — stock, ETF, REIT, ADR, preferred share —
// is classified correctly without any code change.
//
// Finnhub type field values we care about:
//   "Common Stock"  → stock (full pipeline)
//   "ETP"           → ETF/ETP (skip fundamentals/insider/SEC/filings)
//   "DR"            → Depositary Receipt / ADR (treat as stock)
//   "Preferred Stock" → treat as stock
//   "Closed-End Fund" → treat as ETF
//   "REIT"          → treat as ETF (no traditional FCF/ROIC)
//
// In-memory cache per run to avoid duplicate profile calls.
const _instrumentTypeCache = {};

async function fetchInstrumentType(symbol, finnhubKey) {
  if (_instrumentTypeCache[symbol]) return _instrumentTypeCache[symbol];
  try {
    const res = await axios.get(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${finnhubKey}`,
      { timeout: 6000 }
    );
    const type = res.data?.type || 'Common Stock';
    const isFund = ['ETP', 'ETF', 'Closed-End Fund', 'REIT', 'Open-End Fund'].includes(type);
    const result = {
      raw:   type,
      isETF: isFund,
      name:  res.data?.name   || null,
      industry: res.data?.finnhubIndustry || null,
      expenseRatio: res.data?.expenseRatio != null
        ? parseFloat((res.data.expenseRatio * 100).toFixed(4))
        : null,
    };
    _instrumentTypeCache[symbol] = result;
    return result;
  } catch (e) {
    logger.warn(`Instrument type fetch failed for ${symbol}: ${e.message} — treating as stock`);
    const fallback = { raw: 'Common Stock', isETF: false, name: null, expenseRatio: null };
    _instrumentTypeCache[symbol] = fallback;
    return fallback;
  }
}

// ─── FMP ETF CROSS-CHECK ─────────────────────────────────────────────────────
// Finnhub sometimes returns "Common Stock" for ETFs (Invesco, VanEck, iShares
// structured as Regulated Investment Companies). When this happens, we cross-
// check with FMP's profile endpoint which has a reliable isEtf boolean.
// This is fully dynamic — works for any ETF you add, no hardcoded list needed.
// Result is cached per run to avoid duplicate API calls.
const _fmpEtfCache = {};

async function checkFmpIsEtf(symbol) {
  if (_fmpEtfCache[symbol] !== undefined) return _fmpEtfCache[symbol];
  try {
    const res = await axios.get(
      `https://financialmodelingprep.com/api/v3/profile/${symbol}?apikey=${process.env.FMP_API_KEY}`,
      { timeout: 6000 }
    );
    const profile = res.data?.[0];
    const isEtf = profile?.isEtf === true || profile?.isFund === true;
    _fmpEtfCache[symbol] = isEtf;
    return isEtf;
  } catch (e) {
    _fmpEtfCache[symbol] = false;
    return false;
  }
}

// ─── CLIENTS ──────────────────────────────────────────────────────────────────

const _ws = require('ws');
const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: _ws } }
);

let redisClient = null;

async function getRedisClient() {
  if (redisClient) return redisClient;
  try {
    const client = createRedisClient({ url: process.env.REDIS_URL });
    client.on('error', err => logger.warn('Redis error (non-fatal):', err.message));
    await client.connect();
    redisClient = client;
    return redisClient;
  } catch (e) {
    logger.warn('Redis unavailable — Supabase is primary store.');
    return null;
  }
}

// ─── STORAGE ──────────────────────────────────────────────────────────────────

class PortfolioStorage {
  async readData() {
    const client = await getRedisClient();
    if (!client) return { stocks: [] };
    try {
      const data = await client.get('portfolio');
      return data ? JSON.parse(data) : { stocks: [] };
    } catch (e) {
      logger.warn('Redis read failed');
      return { stocks: [] };
    }
  }

  async writeData(data) {
    const client = await getRedisClient();
    if (!client) return false;
    try {
      data.lastUpdated = new Date().toISOString();
      await client.set('portfolio', JSON.stringify(data));
      return true;
    } catch (e) {
      logger.warn('Redis write failed (non-fatal)');
      return false;
    }
  }

  async updateStock(symbol, updates) {
    try {
      const data  = await this.readData();
      let stock   = data.stocks.find(s => s.symbol === symbol);
      if (!stock) {
        stock = { id: Date.now().toString(), symbol, name: symbol, quantity: 0, average_price: 0, createdAt: new Date().toISOString() };
        data.stocks.push(stock);
      }
      const idx = data.stocks.findIndex(s => s.symbol === symbol);
      data.stocks[idx] = { ...stock, ...updates, updatedAt: new Date().toISOString() };
      await this.writeData(data);
      return true;
    } catch (e) {
      logger.warn(`Redis updateStock failed for ${symbol} (non-fatal)`);
      return false;
    }
  }

  async getPortfolio() { return await this.readData(); }
}

// ─── PRICE ANALYZER ───────────────────────────────────────────────────────────

class PriceAnalyzer {

  async fetchPrice(symbol) {
    try {
      const res = await axios.get(
        `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`,
        { timeout: 8000 }
      );
      if (res.data?.c > 0) return { price: res.data.c, changePercent: res.data.dp || 0 };
    } catch (e) { logger.warn(`Finnhub price failed for ${symbol}, trying FMP...`); }
    try {
      const res = await axios.get(
        `https://financialmodelingprep.com/api/v3/quote/${symbol}?apikey=${process.env.FMP_API_KEY}`,
        { timeout: 8000 }
      );
      if (res.data?.length > 0) return { price: res.data[0].price, changePercent: res.data[0].changesPercentage || 0 };
    } catch (e) { logger.error(`All price fetches failed for ${symbol}`); }
    return null;
  }

  async fetchFundamentals(symbol) {
    try {
      const res = await axios.get(
        `https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${process.env.FINNHUB_API_KEY}`,
        { timeout: 8000 }
      );
      if (res.data?.metric) {
        const m = res.data.metric;

        const revenueGrowth3Y = (m['revenueGrowth3Y'] || 0) / 100;
        const revenueGrowthYoY = (m.revenueGrowthTTMYoy || 0) / 100;
        const revenueGrowth = revenueGrowth3Y !== 0
          ? revenueGrowth3Y
          : (revenueGrowthYoY !== 0 ? revenueGrowthYoY : (m['revenueGrowth5Y'] || 0) / 100);

        const grossMargin   = (m.grossMarginTTM || m.grossMarginAnnual || 0) / 100;
        const fcfMarginRaw  = (m.freeCashFlowMarginTTM || m.operatingMarginTTM || 0) / 100;
        const opMarginRaw   = (m.operatingMarginTTM || 0) / 100;
        const fcfConversion = opMarginRaw > 0 ? Math.min(1.5, fcfMarginRaw / opMarginRaw) : 0.5;

        const marketCap = m.marketCapitalization || 0;

        // FCF YIELD FIX: freeCashFlowTTM is frequently null/0 in Finnhub.
        // Multiple fallback paths to avoid showing 0.00% yield for healthy companies.
        // Path 1: Direct TTM FCF from Finnhub (most accurate)
        const fcfTTM_direct = m.freeCashFlowTTM > 0 ? m.freeCashFlowTTM : null;
        const ocfTTM  = m.operatingCashFlowTTM  || 0;
        const capexTTM = m.capitalExpendituresTTM || 0;
        const fcfTTM_ocf = ocfTTM > 0 ? (ocfTTM + capexTTM) : null;
        const revTTM  = m.revenueTTM || m.revenueAnnual || 0;
        const fcfTTM_margin = (fcfMarginRaw > 0 && revTTM > 0) ? (fcfMarginRaw * revTTM) : null;
        const fcfTTM = fcfTTM_direct
                    ?? (fcfTTM_ocf != null && fcfTTM_ocf > 0 ? fcfTTM_ocf : null)
                    ?? (fcfTTM_margin != null && fcfTTM_margin > 0 ? fcfTTM_margin : null)
                    ?? 0;
        // FCF Yield: >5% = attractive, <1% = expensive relative to cash generation
        // Return null (not 0) when we genuinely don't have data — prevents false 0.00% display
        const fcfYield = marketCap > 0 && fcfTTM > 0 ? (fcfTTM / marketCap) : null;

        // EV/FCF: EV = market cap + net debt. Net debt = total debt - cash.
        // Finnhub provides totalDebtAnnual and cashAndEquivalentsAnnual in millions
        const totalDebtM  = m.totalDebtAnnual || 0;
        const cashM       = m.cashAndEquivalentsAnnual || 0;
        const netDebtM    = totalDebtM - cashM;
        const evM         = marketCap + netDebtM;
        // EV/FCF: <15 = cheap, 15-25 = fair, >40 = expensive for a compounder
        const evFcf       = (fcfTTM > 0 && evM > 0) ? (evM / fcfTTM) : null;

        const sharesNow  = m.shareOutstanding || m.sharesOutstanding || null;
        const sharesYoY  = m['52WeekShareChange'] ?? null;

        const grossMargin5Y = m.grossMargin5Y != null ? m.grossMargin5Y / 100 : null;

        let dilutionFlag = null;
        if (sharesYoY != null) {
          if (sharesYoY > 5)       dilutionFlag = 'heavy';
          else if (sharesYoY > 3)  dilutionFlag = 'watch';
          else if (sharesYoY < -1) dilutionFlag = 'buyback';
        }

        // ── Valuation ratios — all from existing Finnhub metric response ──────
        // No additional API calls needed. These fields are in the same /stock/metric response.
        const peTTM        = m.peTTM        > 0 ? parseFloat(m.peTTM.toFixed(1))        : null;
        const forwardPE    = m.forwardPE    > 0 ? parseFloat(m.forwardPE.toFixed(1))    : null;
        const psTTM        = m.psTTM        > 0 ? parseFloat(m.psTTM.toFixed(2))        : null;
        const pbAnnual     = m.pbAnnual     > 0 ? parseFloat(m.pbAnnual.toFixed(2))     : null;
        const evEbitdaTTM  = m.currentEv    > 0 && m.ebitdaTTM > 0
          ? parseFloat((m.currentEv / m.ebitdaTTM).toFixed(1)) : null;
        const netMarginTTM = m.netMarginTTM != null
          ? parseFloat(m.netMarginTTM.toFixed(2)) : null;
        const epsGrowth3Y  = m['epsGrowth3Y'] != null
          ? parseFloat(m['epsGrowth3Y'].toFixed(2)) : null;

        // PEG ratio: PE / EPS growth rate (use trailing PE and 3Y EPS CAGR)
        // <1 = undervalued relative to growth, >2 = expensive relative to growth
        // Use forward PE if trailing unavailable; use revenue growth as proxy if EPS growth missing
        const _peForPeg  = forwardPE ?? peTTM ?? null;
        const _growthPeg = epsGrowth3Y ?? ((m['revenueGrowth3Y'] || 0));
        const pegRatio   = (_peForPeg != null && _growthPeg > 0)
          ? parseFloat((_peForPeg / _growthPeg).toFixed(2))
          : null;

        return {
          roic:          (m.roicTTM || m.roiAnnual || 0) / 100,
          fcfMargin:     fcfMarginRaw,
          debtToEquity:  m['longTermDebt/equityAnnual'] || m['totalDebt/totalEquityAnnual'] || 0,
          revenueGrowth,
          revenueGrowth3Y,
          revenueGrowthYoY,
          grossMargin,
          fcfConversion,
          fcfYield,
          evFcf,
          marketCapM:    marketCap,
          _grossMargin5Y: grossMargin5Y,
          dilutionFlag,
          sharesYoYPct:  sharesYoY,
          // New valuation ratios
          peTTM,
          forwardPE,
          psTTM,
          pbAnnual,
          evEbitdaTTM,
          netMarginTTM,
          epsGrowth3Y,
          pegRatio,
          _raw: {
            roicPct:            (m.roicTTM || m.roiAnnual || 0),
            grossMarginPct:     (m.grossMarginTTM || m.grossMarginAnnual || 0),
            operatingMarginPct: (m.operatingMarginTTM || 0),
            revenueGrowthPct:   revenueGrowth3Y !== 0
              ? m['revenueGrowth3Y'] || 0
              : (m.revenueGrowthTTMYoy || 0),
            revenueGrowth3YPct: m['revenueGrowth3Y'] || 0,
            fcfMarginPct:       (m.freeCashFlowMarginTTM || m.operatingMarginTTM || 0),
            fcfYieldPct:        fcfYield != null ? (fcfYield * 100) : null,
            evFcf:              evFcf,
            sharesOutstandingM: sharesNow,
            cashM:      m.cashAndEquivalentsAnnual || 0,
            totalDebtM: m.totalDebtAnnual || 0,
            netMarginPct:   netMarginTTM,
            peTTM,
            forwardPE,
            psTTM,
            pegRatio,
          }
        };
      }
    } catch (e) { /* fall through */ }
    return null;
  }

  async fetchTechnicals(symbol) {
    try {
      const end   = new Date();
      const start = new Date();
      start.setFullYear(start.getFullYear() - 1);
      const res = await axios.get(
        `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day` +
        `/${start.toISOString().split('T')[0]}/${end.toISOString().split('T')[0]}` +
        `?adjusted=true&sort=asc&limit=300&apiKey=${process.env.POLYGON_API_KEY}`,
        { timeout: 8000 }
      );
      if (!res.data?.results?.length) return null;
      const historyAscRaw = [...res.data.results].sort((a, b) => a.t - b.t);
      const period200 = Math.min(200, historyAscRaw.length);
      const period50  = Math.min(50,  historyAscRaw.length);
      const sma200    = historyAscRaw.slice(-period200).reduce((acc, d) => acc + d.c, 0) / period200;
      const sma50     = historyAscRaw.slice(-period50 ).reduce((acc, d) => acc + d.c, 0) / period50;
      const rsiSeries = this._computeRollingRSI(historyAscRaw, 14);
      const historyAsc = historyAscRaw.map((d, i) => ({ c: d.c, v: d.v, t: d.t, rsi: rsiSeries[i] ?? 50 }));
      const historyDesc   = [...historyAsc].reverse();
      const todayRsi      = historyAsc[historyAsc.length - 1].rsi;
      const currentVolume = historyDesc[0].v;
      return { rsi: todayRsi, sma200, sma50, currentVolume, historyAsc, historyDesc };
    } catch (e) {
      logger.warn(`fetchTechnicals failed for ${symbol}: ${e.message}`);
      return null;
    }
  }

  _computeRollingRSI(priceData, period = 14) {
    const rsi = new Array(priceData.length).fill(null);
    if (priceData.length < period + 1) return rsi;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const diff = priceData[i].c - priceData[i - 1].c;
      if (diff > 0) avgGain += diff;
      else          avgLoss += Math.abs(diff);
    }
    avgGain /= period;
    avgLoss /= period;
    const calcRsi = (g, l) => l === 0 ? 100 : 100 - (100 / (1 + g / l));
    rsi[period] = calcRsi(avgGain, avgLoss);
    for (let i = period + 1; i < priceData.length; i++) {
      const diff = priceData[i].c - priceData[i - 1].c;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      rsi[i] = calcRsi(avgGain, avgLoss);
    }
    return rsi;
  }

  async fetchRatings(symbol) {
    try {
      const res = await axios.get(
        `https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`,
        { timeout: 8000 }
      );
      if (!res.data?.length) return null;
      const current = res.data[0];
      const prior   = res.data[1] ?? null;
      return { ...current, _prior: prior };
    } catch (e) { /* fall through */ }
    return null;
  }

  async fetchInsider(symbol) {
    const NON_ECONOMIC = new Set(['A', 'F', 'M', 'G', 'X', 'D']);

    try {
      const payload = {
        query: `issuer.tradingSymbol:${symbol}`,
        from: '0', size: '100',
        sort: [{ transactionDate: 'desc' }]
      };
      const res = await axios.post(
        `https://api.sec-api.io/insider-trading?token=${process.env.SEC_API_KEY}`,
        payload, { timeout: 8000 }
      );
      const trades = res.data.transactions || (Array.isArray(res.data) ? res.data : []);

      if (trades.length > 0) {
        let totalBought = 0, totalSold = 0, totalRawBought = 0;
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const recentBuyers = new Set();

        const titleWeight = (title) => {
          if (!title) return 1;
          const t = title.toUpperCase();
          if (t.includes('CEO') || t.includes('CHIEF EXEC') ||
              t.includes('CFO') || t.includes('CHIEF FIN'))  return 3;
          if (t.includes('COO') || t.includes('PRESIDENT') ||
              t.includes('CHIEF OPE'))                       return 2;
          return 1;
        };

        const seen = new Map();
        const dedupedTrades = [];
        for (const trade of trades) {
          const cik  = trade.reportingCik || trade.reporterCik || '';
          const date = trade.transactionDate || trade.filingDate || '';
          const code = (trade.transactionCode || trade.code || '').trim();
          const key  = `${cik}|${date}|${code}`;
          if (!seen.has(key)) {
            seen.set(key, true);
            dedupedTrades.push(trade);
          }
        }

        dedupedTrades.forEach(trade => {
          const formType = (trade.formType || '').trim();
          if (formType === '5' || formType === '5/A') return;

          const tradeDate = new Date(trade.transactionDate || trade.filingDate);
          if (tradeDate < sixMonthsAgo) return;

          const shares = parseFloat(trade.shares || trade.securitiesTransacted || 0);
          const price  = parseFloat(trade.pricePerShare || trade.price || 0);
          const code   = (trade.transactionCode || trade.code || '').trim();
          const title  = trade.reportingOwnerRelationship?.officerTitle || trade.officerTitle || '';
          const tw     = titleWeight(title);

          if (shares <= 0) return;
          if (NON_ECONOMIC.has(code)) return;

          if (code === 'P') {
            const rawVal = shares * (price || 1);
            totalBought    += rawVal * tw;
            totalRawBought += rawVal;
            if (tradeDate >= thirtyDaysAgo) {
              // B3 FIX: Math.random() created a new unique ID every run, inflating cluster30d.
              // Use stable fields: reportingCik → reportingName → officerTitle → filingDate
              const buyerId = trade.reportingCik || trade.reportingName || trade.reporterName || title || trade.filingDate;
              recentBuyers.add(buyerId);
            }
            return;
          }

          if (code === 'S') {
            const is10b51 = trade.is10b51 ?? trade.automaticTransaction ?? false;
            const weight   = is10b51 ? 0.5 : 1.0;
            totalSold += shares * (price || 1) * weight;
            return;
          }
        });

        return {
          bought:     totalBought,
          sold:       totalSold,
          cluster30d: recentBuyers.size,
          rawBought:  totalRawBought,
          _source:    'sec-api',
        };
      }
    } catch (e) { /* try Finnhub fallback */ }

    try {
      const startStr = new Date(new Date().setMonth(new Date().getMonth() - 6))
        .toISOString().split('T')[0];
      const endStr = new Date().toISOString().split('T')[0];
      const res = await axios.get(
        `https://finnhub.io/api/v1/stock/insider-sentiment?symbol=${symbol}` +
        `&from=${startStr}&to=${endStr}&token=${process.env.FINNHUB_API_KEY}`,
        { timeout: 8000 }
      );
      if (res.data?.data?.length > 0) {
        const sorted  = [...res.data.data].sort((a, b) => b.month?.localeCompare(a.month ?? '') ?? 0);
        const weights = [3, 2, 1];
        let wSum = 0, wTot = 0;
        sorted.slice(0, 3).forEach((m, i) => {
          const w = weights[i] ?? 1;
          wSum += (m.mspr ?? 0) * w;
          wTot += w;
        });
        const recentMspr = wTot > 0 ? wSum / wTot : 0;
        if (recentMspr > 0) return { bought: recentMspr * 1_000_000, sold: 0, rawBought: Infinity, _source: 'finnhub' };
        if (recentMspr < 0) return { bought: 0, sold: Math.abs(recentMspr) * 1_000_000, rawBought: 0, _source: 'finnhub' };
      }
    } catch (e) { /* fall through */ }
    return null;
  }

  calculateScore(priceData, fundamentals, technicals, ratings, analyzedNews, insiderData, capexException = false, newsScoreOverride = null, isETF = false, expenseRatio = null, recent8K = null) {
    let fundScore = 5, techScore = 5, ratingScore = 5, newsScore = 5, insiderScore = 5;
    let adjFcfMargin = null;

    if (fundamentals) {
      let roicS = Math.max(0, Math.min(10, ((fundamentals.roic - SCORING_PARAMS.ROIC_FLOOR) / SCORING_PARAMS.ROIC_RANGE) * 10));

      if (fundamentals._earningsQualityFlag === 'risk' && !capexException) {
        roicS = Math.min(roicS, 5.0);
        logger.warn(`  🔒 ROIC capped at neutral (earnings quality risk — OCF < 0, GAAP income > 0)`);
      }

      const _gm5y = fundamentals._grossMargin5Y ?? null;
      const _gmNow = fundamentals.grossMargin ?? 0;
      const _atCyclicalPeak = _gm5y != null && _gm5y > 0.02 && _gmNow > _gm5y * SCORING_PARAMS.CYCLICAL_PEAK_MULTIPLE;
      if (_atCyclicalPeak) {
        logger.warn(`  ⚠️ CYCLICAL PEAK SIGNAL: current gross margin ${(_gmNow*100).toFixed(1)}% is >150% of 5Y avg ${(_gm5y*100).toFixed(1)}%`);
      }

      adjFcfMargin = fundamentals.fcfMargin;
      const rawFcfMargin = fundamentals.fcfMargin;

      if (fundamentals.sbcMillions != null && fundamentals.sbcMillions > 0
          && fundamentals.fcfYield != null
          && fundamentals.marketCapM > 0) {
        const fcfMillions = fundamentals.fcfYield * fundamentals.marketCapM;
        if (fcfMillions > 0) {
          const sbcAsFcfFraction = fundamentals.sbcMillions / fcfMillions;
          fundamentals._sbcAsFcfRatio = sbcAsFcfFraction;
          adjFcfMargin = Math.max(0, fundamentals.fcfMargin * (1 - sbcAsFcfFraction));
          if (Math.abs(adjFcfMargin - rawFcfMargin) > 0.005) {
            logger.info(`  💰 SBC adj: FCF ${(rawFcfMargin*100).toFixed(1)}% → ${(adjFcfMargin*100).toFixed(1)}% (SBC ${(sbcAsFcfFraction*100).toFixed(0)}% of true FCF)`);
          }
        } else {
          fundamentals._sbcAsFcfRatio = 10.0;
          adjFcfMargin = 0;
          logger.warn(`  ⚠️ SBC penalty: negative FCF + $${fundamentals.sbcMillions.toFixed(0)}M SBC → max moat penalty applied`);
        }
      }

      let fcfS = Math.max(0, Math.min(10, (adjFcfMargin / SCORING_PARAMS.FCF_MARGIN_DIVISOR) * 10));

      // ── Debt/Equity ───────────────────────────────────────────────────────
      // W7 FIX: Negative D/E has two distinct meanings:
      //   (A) Net cash: cash > total debt → genuinely good → score 10
      //   (B) Negative equity: liabilities > assets → financial distress → score 2
      // The old code gave score=10 for BOTH, masking real distress signals.
      let deS;
      if (fundamentals.debtToEquity < 0) {
        const _cashM = fundamentals._raw?.cashM      ?? 0;
        const _debtM = fundamentals._raw?.totalDebtM ?? 0;
        const _isNetCash   = _cashM > _debtM && _cashM > 0;
        const _isNegEquity = !_isNetCash && _debtM > 0;
        deS = _isNetCash   ? 10 : _isNegEquity ? 2 : 5;
        if (_isNegEquity) logger.warn(`  ⚠️ NEGATIVE EQUITY: D/E=${fundamentals.debtToEquity.toFixed(2)} — distress signal, not net cash`);
      } else {
        deS = Math.max(0, Math.min(10, 10 - ((fundamentals.debtToEquity / 2.0) * 10)));
      }

      // ── FCF Yield — computed for display only, NOT in composite ──────────
      let fcfYieldS = 5;
      if (fundamentals.fcfYield != null) {
        const fy = fundamentals.fcfYield;
        if (fy >= 0.06)      fcfYieldS = 10;
        else if (fy >= 0.03) fcfYieldS = 5 + ((fy - 0.03) / 0.03) * 5;
        else if (fy >= 0.01) fcfYieldS = 2 + ((fy - 0.01) / 0.02) * 3;
        else if (fy > 0)     fcfYieldS = (fy / 0.01) * 2;
        else                 fcfYieldS = 0;
        fcfYieldS = Math.max(0, Math.min(10, fcfYieldS));
      }

      // ── Dual-window revenue growth ────────────────────────────────────────
      const yoy  = fundamentals.revenueGrowthYoY  ?? 0;
      const cagr = fundamentals.revenueGrowth3Y   ?? 0;
      const yoyS  = Math.max(0, Math.min(10, SCORING_PARAMS.REV_GROWTH_NEUTRAL_SCORE + (yoy  / SCORING_PARAMS.REV_GROWTH_DIVISOR)));
      const cagrS = Math.max(0, Math.min(10, SCORING_PARAMS.REV_GROWTH_NEUTRAL_SCORE + (cagr / SCORING_PARAMS.REV_GROWTH_DIVISOR)));
      let revGS;
      if (cagr !== 0 && yoy !== 0) {
        revGS = (yoyS * 0.40) + (cagrS * 0.60);
      } else if (cagr !== 0) {
        revGS = cagrS;
      } else {
        revGS = yoyS;
      }
      // F-004 FIX: threshold lowered from 0.10 to 0.05. A 9.9% CAGR accelerating to 20% YoY
      // is a genuine compounder signal, not a recovery bounce. Only cap truly low-CAGR (<5%) stocks.
      if (cagr !== 0 && yoy !== 0 && yoy > cagr * 1.5 && cagr < 0.05) {
        revGS = Math.min(revGS, 6.5);
      }

      if (capexException) fcfS = Math.min(10, fcfS + SCORING_PARAMS.CAPEX_FCF_BONUS);

      // ── Hypergrowth detection ─────────────────────────────────────────────
      const _isHypergrowth = (
        cagr > SCORING_PARAMS.HYPERGROWTH_CAGR_MIN &&
        (fundamentals.grossMargin ?? 0) > SCORING_PARAMS.HYPERGROWTH_GM_MIN &&
        !_atCyclicalPeak
      );

      if (_isHypergrowth) {
        fundScore = (revGS * 0.55) + (fcfS * 0.15) + (roicS * 0.15) + (deS * 0.15);
        fundamentals._hypergrowthMode = true;
      } else {
        fundScore = (roicS * 0.40) + (fcfS * 0.30) + (deS * 0.20) + (revGS * 0.10);
        fundamentals._hypergrowthMode = false;
      }

      if (_atCyclicalPeak) {
        fundScore = Math.min(fundScore, SCORING_PARAMS.CYCLICAL_PEAK_SCORE_CAP);
        fundamentals._cyclicalPeakFlag = true;
      } else {
        fundamentals._cyclicalPeakFlag = false;
      }

      // ── Enhanced Moat Score (display-only, never feeds composite) ─────────
      const gmPct = fundamentals.grossMargin ?? 0;
      // Moat GM range fixed: was 20-26% (every tech stock trivially maxed).
      // Now 30-80% range: LLY at 83% GM = 10, EME at 20% GM = 0. Meaningful.
      const gmS   = Math.max(0, Math.min(10, (gmPct - 0.30) / 0.05));
      const fcfConvS = Math.max(0, Math.min(10, (fundamentals.fcfConversion ?? 0.5) * 6.67));
      const roicVsHurdleS = Math.max(0, Math.min(10, ((fundamentals.roic - 0.15) / 0.10) * 10));

      // SBC dilution penalty: uses _sbcAsFcfRatio = SBC/FCF computed in the SBC block above.
      // This is the direct ratio of SBC to true FCF (fcfYield × marketCap) — no extra arithmetic.
      // Example: CRWD SBC≈$1.1B, true FCF≈$150M → ratio≈7.3 → sbcPenalty = 2.5 (heavy).
      // This correctly hammers companies where SBC is destroying most of the FCF shareholders see.
      let sbcPenalty = 0;
      const _sbcRatio = fundamentals._sbcAsFcfRatio ?? null;
      if (_sbcRatio != null) {
        if (_sbcRatio > SCORING_PARAMS.SBC_HEAVY_THRESHOLD) sbcPenalty = 2.5;
        else if (_sbcRatio > SCORING_PARAMS.SBC_WATCH_THRESHOLD) sbcPenalty = 1.0;
      }

      const fcfYieldMoatAdj = fundamentals.fcfYield != null
        ? (fundamentals.fcfYield < 0.02 ? -1.0 : fundamentals.fcfYield > 0.05 ? 1.0 : 0)
        : 0;

      const rawMoat = (roicVsHurdleS * 0.30) + (gmS * 0.25) + (cagrS * 0.25) + (fcfConvS * 0.20);
      fundamentals._moatScore = Math.max(0, Math.min(10,
        parseFloat((rawMoat - sbcPenalty + fcfYieldMoatAdj).toFixed(1))
      ));

      // Blend moat into fundScore (20% weight) — moat was display-only, now drives score.
      // For a compounder, moat durability IS the primary long-term thesis signal.
      const _preMoatFundScore = fundScore;
      fundScore = Math.max(0, Math.min(10,
        parseFloat((_preMoatFundScore * 0.80 + fundamentals._moatScore * 0.20).toFixed(2))
      ));

      // Valuation adjuster (FCF yield modifier) — F-004-ZA.
      // fundScore has no valuation component without this: quality at 150x FCF = same as 15x FCF.
      // Small modifier (+0.7 to -1.8). Quality stays primary but price matters too.
      if (fundamentals.fcfYield != null) {
        const fy = fundamentals.fcfYield;
        const valuationAdj = fy > 0.06  ? +0.7
                           : fy > 0.04  ? +0.4
                           : fy > 0.025 ? +0.1
                           : fy > 0.015 ?  0
                           : fy > 0.008 ? -0.8
                           : -1.8;
        const _preValFundScore = fundScore;
        fundScore = Math.max(0, Math.min(10, fundScore + valuationAdj));
        if (Math.abs(valuationAdj) >= 0.4) {
          logger.info('  💎 Valuation: FCF yield ' + (fy*100).toFixed(1) + '% adj '
            + (valuationAdj >= 0 ? '+' : '') + valuationAdj
            + ' → fundScore ' + _preValFundScore.toFixed(1) + ' → ' + fundScore.toFixed(1));
        }
      }
    }

    if (technicals && priceData?.price) {
      const price = priceData.price;

      let trend200S = 5;
      if (technicals.sma200 > 0) {
        const diff200 = (price - technicals.sma200) / technicals.sma200;
        trend200S = Math.max(0, Math.min(10, 5 + ((diff200 / 0.05) * 5)));
      }

      let trend50S = 5;
      if (technicals.sma50 > 0) {
        const diff50 = (price - technicals.sma50) / technicals.sma50;
        trend50S = Math.max(0, Math.min(10, 5 + ((diff50 / 0.04) * 5)));
      }

      const trendS = (trend200S * 0.60) + (trend50S * 0.40);

      // RSI recalibrated for buy-the-dip compounder (Indian investor).
      // Old: 45-65 → 10, oversold <35 → 8 (lower!) — backwards for "buy when cheap".
      // New: deep oversold scores AS HIGH as healthy uptrend. Overbought penalised.
      const rsi = technicals.rsi;
      let rsiS = 5;
      if      (rsi < 25)               rsiS = 10;
      else if (rsi >= 25 && rsi < 40)  rsiS = 9;
      else if (rsi >= 40 && rsi < 55)  rsiS = 7;
      else if (rsi >= 55 && rsi <= 70) rsiS = 10;
      else if (rsi > 70 && rsi <= 80)  rsiS = 6;
      else if (rsi > 80)               rsiS = 2;

      techScore = (trendS * 0.50) + (rsiS * 0.50);
    }

    if (ratings) {
      const total = (ratings.strongBuy || 0) + (ratings.buy || 0) + (ratings.hold || 0) + (ratings.sell || 0) + (ratings.strongSell || 0);
      if (total > 0) {
        const bullish = (ratings.strongBuy || 0) + (ratings.buy || 0);
        const bearish = (ratings.sell || 0) + (ratings.strongSell || 0);
        ratingScore = Math.max(0, Math.min(10, ((bullish / total) * 10) - ((bearish / total) * 5)));

        if (ratings._prior) {
          const priorTotal = (ratings._prior.strongBuy || 0) + (ratings._prior.buy || 0)
                           + (ratings._prior.hold || 0) + (ratings._prior.sell || 0)
                           + (ratings._prior.strongSell || 0);
          if (priorTotal > 0) {
            const priorBullishPct = ((ratings._prior.strongBuy || 0) + (ratings._prior.buy || 0)) / priorTotal;
            const currBullishPct  = bullish / total;
            const delta           = currBullishPct - priorBullishPct;
            const revisionAdj = Math.max(-2.0, Math.min(2.0, delta * 10));
            ratingScore = Math.max(0, Math.min(10, ratingScore + revisionAdj));
          }
        }
      }
    }

    // B12 FIX: guard against null, undefined, and NaN (null = no news logged = neutral 5.0)
    if (newsScoreOverride !== null && newsScoreOverride !== undefined && !Number.isNaN(newsScoreOverride)) {
      newsScore = newsScoreOverride;
      logger.info(`  📰 Using intraday news score: ${newsScore.toFixed(2)}`);
    } else if (analyzedNews?.length > 0) {
      const avgSentiment  = analyzedNews.reduce((s, i) => s + i.sentiment.score, 0) / analyzedNews.length;
      const avgImportance = analyzedNews.reduce((s, i) => s + i.importance,      0) / analyzedNews.length;
      newsScore = 5 + (avgSentiment * 4);
      newsScore += avgSentiment > 0 ? (avgImportance / 10) : -(avgImportance / 10);
      newsScore = Math.max(0, Math.min(10, newsScore));
    }

    if (insiderData) {
      // INSIDER_MIN_BUY_USD from SCORING_PARAMS
      const { bought, sold, cluster30d = 0, rawBought = bought } = insiderData;

      // FIX: Finnhub fallback tags rawBought = Infinity so it always clears this threshold.
      // The $50K floor filters token SEC-API purchases (CEO buys $3K of stock = noise).
      // Finnhub MSPR is a ratio-based signal — magnitude is not in dollars, so the dollar
      // threshold is inapplicable. Directional signal (positive vs negative MSPR) is reliable.
      const effectiveBought = rawBought >= SCORING_PARAMS.INSIDER_MIN_BUY_USD ? bought : 0;
      const clusterBonus    = cluster30d >= 3 ? 1.5 : cluster30d === 2 ? 0.5 : 0;

      // B2 FIX: sell-side branch ordering was broken.
      // Old code: "sold > 0 && effectiveBought === 0" always fired first (score=3),
      // making "sold > bought * 5" (score=2) unreachable — heavy selling was never penalised.
      // Fix: distinguish heavy pure-selling (score=2) from normal pure-selling (score=3)
      // within the same branch, then handle mixed buy/sell cases below.
      if      (effectiveBought > 0 && sold === 0) insiderScore = Math.min(10, 9 + clusterBonus);
      else if (effectiveBought > sold * 3)        insiderScore = Math.min(10, 8 + clusterBonus);
      else if (effectiveBought > sold * 2)        insiderScore = Math.min(10, 7 + clusterBonus);
      else if (effectiveBought > sold)            insiderScore = Math.min(10, 6 + clusterBonus);
      else if (sold > 0 && effectiveBought === 0) {
        // Pure selling — distinguish heavy (score=2) from normal (score=3)
        // F09 FIX: use rawBought (not title-weighted bought) for this ratio check.
        // Use absolute $500K threshold — rawBought*5 with rawBought≈0 always returned 2
        insiderScore = sold > 500_000 ? 2 : 3;
      }
      else if (sold > bought * 2)                 insiderScore = 3;
      else if (sold > bought)                     insiderScore = 4;
      else                                        insiderScore = 5;
    }

    // ── 8-K / 6-K material event adjustment ────────────────────────────────────
    // Applies scoreAdj from the most recent material filing to newsScore.
    // Recency decay: full weight on day 0, 15% at day 60. Critical events
    // (bankruptcy, delisting) override the final score to 0 and set a flag.
    // This was previously decoration-only — now directly affects the composite.
    let _8kCriticalOverride = false;
    if (recent8K?.scoreAdj != null && recent8K.scoreAdj !== 0) {
      const daysOld   = recent8K.daysOld ?? 0;
      const decayMul  = Math.max(SCORING_PARAMS.EVENT_8K_MIN_DECAY, 1 - daysOld / SCORING_PARAMS.EVENT_8K_LOOKBACK_DAYS);
      const adj       = recent8K.scoreAdj * decayMul;
      if (recent8K.hint === 'critical') {
        _8kCriticalOverride = true;
        logger.warn(`  🚨 CRITICAL 8-K: ${recent8K.label} — score overridden to 0`);
      } else {
        newsScore = Math.max(0, Math.min(10, newsScore + adj));
        logger.info(`  📋 8-K adj: ${adj >= 0 ? '+' : ''}${adj.toFixed(2)} (${recent8K.item} "${recent8K.label}", ${daysOld.toFixed(0)}d old, decay=${decayMul.toFixed(2)})`);
      }
    }

    let finalScore;
    if (isETF) {
      if (ratings === null || ratings === undefined) {
        finalScore = (techScore * 0.65) + (newsScore * 0.35);
      } else {
        finalScore = (techScore * 0.50) + (newsScore * 0.30) + (ratingScore * 0.20);
      }
      const er = typeof expenseRatio === 'number' ? expenseRatio : null;
      if (er != null) {
        const erPenalty = er < 0.10 ? 0.0
                        : er < 0.25 ? 0.2
                        : er < 0.50 ? 0.5
                        : er < 0.75 ? 0.8
                        : 1.2;
        finalScore = Math.max(0, finalScore - erPenalty);
      }
    } else {
      if (insiderData === null) {
        finalScore = (fundScore * 0.60) + (ratingScore * 0.15) + (techScore * 0.15) + (newsScore * 0.10);
      } else {
        // F-002 FIX: corrected comment — actual weights already sum to 1.00, not 0.90.
        // Fund 60% (quality + valuation adj + moat blend) | Insider 15% | Rating 10% | Tech 8% | News 7%
        // Weights: 0.60+0.15+0.10+0.08+0.07 = 1.00 ✓
        finalScore = (fundScore * 0.60) + (insiderScore * 0.15) + (ratingScore * 0.10) + (techScore * 0.08) + (newsScore * 0.07);
      }
    }
    const _finalTotal = _8kCriticalOverride ? 0 : Math.max(0, Math.min(10, finalScore));

    return {
      total:               _finalTotal,
      fund:                fundScore,
      tech:                techScore,
      rating:              ratingScore,
      news:                newsScore,
      insider:             insiderScore,
      _adjFcfMargin:       adjFcfMargin,
      _8kCriticalOverride,
    };
  }

  getSignal(score, marketRegime = 'NORMAL') {
    const buyThreshold       = marketRegime === 'BEAR' ? 8.0 : marketRegime === 'STRESSED' ? 7.8 : 7.5;
    const strongBuyThreshold = marketRegime === 'BEAR' ? 9.0 : 8.5;
    if (score >= strongBuyThreshold) return 'STRONG_BUY';
    if (score >= buyThreshold)       return 'BUY';
    if (score >= 4.5)                return 'HOLD';
    if (score >= 3.5)                return 'REDUCE';
    return 'SELL';
  }
}

// ─── SEC EDGAR — STOCK-BASED COMPENSATION ────────────────────────────────────

const _cikCache = {};

async function getEdgarCIK(symbol) {
  if (_cikCache[symbol]) return _cikCache[symbol];

  // W8: Check Redis before fetching 8MB company_tickers.json from SEC.
  // CIKs change rarely — 24h TTL is safe. Eliminates the large download on every cold start.
  try {
    const rc = await getRedisClient();
    if (rc) {
      const cached = await rc.get(`edgar_cik_${symbol.toUpperCase()}`).catch(() => null);
      if (cached) { _cikCache[symbol] = cached; return cached; }
    }
  } catch (e) { /* cache miss */ }

  try {
    const res = await axios.get(
      'https://www.sec.gov/files/company_tickers.json',
      { timeout: 8000, headers: { 'User-Agent': 'PortfolioDashboard contact@portfolio.local' } }
    );
    const entries = Object.values(res.data);
    const match   = entries.find(e => e.ticker?.toUpperCase() === symbol.toUpperCase());
    if (match) {
      const cik = String(match.cik_str).padStart(10, '0');
      _cikCache[symbol] = cik;
      try {
        const rc = await getRedisClient();
        if (rc) await rc.set(`edgar_cik_${symbol.toUpperCase()}`, cik, { EX: 86400 }).catch(() => {});
      } catch (e) { /* non-critical */ }
      return cik;
    }
  } catch (e) {
    logger.warn(sanitizeMsg(`EDGAR CIK lookup failed for ${symbol}: ${e.message}`));
  }
  return null;
}

async function fetchSECStockBasedComp(symbol) {
  try {
    const cik = await getEdgarCIK(symbol);
    if (!cik) return null;

    const res = await axios.get(
      `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/ShareBasedCompensation.json`,
      { timeout: 10000, headers: { 'User-Agent': 'PortfolioDashboard contact@portfolio.local' } }
    );

    const units = res.data?.units?.USD;
    if (!units?.length) return null;

    const annual = units
      .filter(f => f.form === '10-K' && f.end && f.val > 0)
      .sort((a, b) => new Date(b.end) - new Date(a.end));

    if (!annual.length) return null;

    const latestSBC = annual[0].val / 1_000_000;
    return parseFloat(latestSBC.toFixed(2));
  } catch (e) {
    if (e.response?.status !== 404) {
      logger.warn(`SEC EDGAR SBC fetch failed for ${symbol}: ${e.message}`);
    }
    return null;
  }
}

// ─── IFRS / US-GAAP DETECTION ────────────────────────────────────────────────

const _accountingStdCache = {};

async function detectAccountingStandard(symbol) {
  if (_accountingStdCache[symbol]) return _accountingStdCache[symbol];
  try {
    const cik = await getEdgarCIK(symbol);
    if (!cik) return 'UNKNOWN';
    const res = await axios.get(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
      { timeout: 10000, headers: { 'User-Agent': 'PortfolioDashboard contact@portfolio.local' } }
    );
    const facts = res.data?.facts ?? {};
    const std = facts['ifrs-full'] ? 'IFRS'
              : facts['us-gaap']   ? 'US-GAAP'
              : 'UNKNOWN';
    _accountingStdCache[symbol] = std;
    return std;
  } catch (e) {
    _accountingStdCache[symbol] = 'UNKNOWN';
    return 'UNKNOWN';
  }
}

// ─── FINNHUB FILING SENTIMENT ─────────────────────────────────────────────────

async function fetchFilingSentiment(symbol) {
  try {
    const filingsRes = await axios.get(
      `https://finnhub.io/api/v1/stock/filings?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`,
      { timeout: 8000 }
    );
    const filings = filingsRes.data || [];
    const recent = filings.find(f => f.form === '10-K' || f.form === '10-Q');
    if (!recent?.accessNumber) return null;

    const sentRes = await axios.get(
      `https://finnhub.io/api/v1/stock/filings-sentiment?accessNumber=${recent.accessNumber}&token=${process.env.FINNHUB_API_KEY}`,
      { timeout: 8000 }
    );

    const s = sentRes.data?.sentiment;
    if (!s) return null;

    const posRaw = s.positive ?? 0;
    const negRaw = s.negative ?? 0;
    const pos = posRaw > 1 ? posRaw / 100 : posRaw;
    const neg = negRaw > 1 ? negRaw / 100 : negRaw;
    if (posRaw > 1) logger.warn(`  ⚠️ fetchFilingSentiment: values out of [0,1] — normalised from ${posRaw}/${negRaw}`);
    const net = pos - neg;
    const score = Math.max(0, Math.min(10, 5 + (net / 0.05) * 5));
    return {
      score:   parseFloat(score.toFixed(1)),
      form:    recent.form,
      filedAt: recent.filedDate,
      positive: pos,
      negative: neg,
    };
  } catch (e) {
    return null;
  }
}

// ─── SEC EDGAR 8-K / 6-K MATERIAL EVENT WATCHER ─────────────────────────────
//
// Improvements vs original:
//   - Expanded MATERIAL_ITEMS to 14 items (was 7) including bankruptcy/delisting
//   - Each item carries a scoreAdj for use in calculateScore()
//   - Matches 8-K/A amendments (not just 8-K)
//   - For ADRs (type='DR'), also queries 6-K (foreign equivalent of 8-K)
//   - Lookback extended to 60 days (was 30) with recency decay in calculateScore
//   - Returns daysOld so calculateScore can apply decay without re-computing

const MATERIAL_ITEMS_8K = {
  '1.03': { label: 'BANKRUPTCY / RECEIVERSHIP',   hint: 'critical',  icon: '🚨', scoreAdj: -5.0 },
  '3.01': { label: 'DELISTING NOTICE',            hint: 'critical',  icon: '🚫', scoreAdj: -5.0 },
  '4.02': { label: 'Non-Reliance on Financials',  hint: 'negative',  icon: '🚨', scoreAdj: -3.0 },
  '2.05': { label: 'Material Impairment',         hint: 'negative',  icon: '📉', scoreAdj: -2.0 },
  '1.02': { label: 'Agreement Terminated',        hint: 'negative',  icon: '❌', scoreAdj: -2.0 },
  '4.01': { label: 'Auditor Change',              hint: 'negative',  icon: '⚠️', scoreAdj: -1.5 },
  '2.03': { label: 'New Debt Obligation',         hint: 'negative',  icon: '💸', scoreAdj: -1.0 },
  '5.01': { label: 'Change in Control',           hint: 'negative',  icon: '👔', scoreAdj: -1.0 },
  '2.02': { label: 'Earnings Release',            hint: 'neutral',   icon: '📊', scoreAdj:  0   },
  '5.02': { label: 'Director/Officer Change',     hint: 'neutral',   icon: '👔', scoreAdj:  0   },
  '7.01': { label: 'Reg FD Disclosure',           hint: 'neutral',   icon: '📢', scoreAdj:  0   },
  '8.01': { label: 'Other Material Event',        hint: 'neutral',   icon: '📌', scoreAdj:  0   },
  '1.01': { label: 'Material Agreement',          hint: 'neutral',   icon: '📋', scoreAdj:  0   },
  '2.01': { label: 'Acquisition Completed',       hint: 'positive',  icon: '🤝', scoreAdj: +1.5 },
};

async function fetchRecent8K(symbol, instrumentIsADR = false) {
  try {
    const cik = await getEdgarCIK(symbol);
    if (!cik) return null;

    const res = await axios.get(
      `https://data.sec.gov/submissions/CIK${cik}.json`,
      { timeout: 10000, headers: { 'User-Agent': 'PortfolioDashboard contact@portfolio.local' } }
    );

    const filings = res.data?.filings?.recent;
    if (!filings?.form?.length) return null;

    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    const targetForms = instrumentIsADR
      ? new Set(['6-K', '6-K/A'])
      : new Set(['8-K', '8-K/A']);

    for (let i = 0; i < filings.form.length; i++) {
      const formType = filings.form[i];
      if (!targetForms.has(formType)) continue;

      const filingDate = new Date(filings.filingDate[i]);
      // E-002 FIX: continue not break — EDGAR order not guaranteed to be strictly newest-first.
      // A single out-of-order filing would cause break to exit early, missing critical events.
      if (filingDate < sixtyDaysAgo) continue;

      const isAmendment = formType.endsWith('/A');
      const daysOld = (Date.now() - filingDate.getTime()) / 86_400_000;

      // 6-K handling — no standardised item codes, classify by description keywords
      // F02 FIX: both ternary branches were 'neutral' — now checks for negative events.
      if (formType === '6-K' || formType === '6-K/A') {
        const desc = (filings.primaryDocument?.[i] || filings.items?.[i] || '').toLowerCase();
        const NEGATIVE_6K = ['default', 'restat', 'adverse', 'impairment', 'delist', 'bankrupt', 'material weak', 'going concern'];
        const isNeg6K  = NEGATIVE_6K.some(k => desc.includes(k));
        const hint6K   = isNeg6K ? 'negative' : 'neutral';
        const scoreAdj6K = isNeg6K ? -2.0 : 0;
        return {
          item: '6-K',
          label:    isNeg6K ? 'Foreign Adverse Event' : 'Foreign Interim Report',
          hint:     hint6K,
          icon:     isNeg6K ? '⚠️' : '🌍',
          scoreAdj: scoreAdj6K,
          filedDate: filings.filingDate[i], daysOld, isAmendment,
        };
      }

      const items = (filings.items?.[i] || '').split(',').map(s => s.trim());
      for (const item of items) {
        const meta = MATERIAL_ITEMS_8K[item];
        if (meta) {
          return {
            item, isAmendment, daysOld,
            label:     meta.label,
            hint:      meta.hint,
            icon:      meta.icon,
            scoreAdj:  meta.scoreAdj,
            filedDate: filings.filingDate[i],
          };
        }
      }
    }

    return null;
  } catch (e) {
    if (e.response?.status !== 404) {
      logger.warn(`8-K/6-K watcher failed for ${symbol}: ${e.message}`);
    }
    return null;
  }
}

// ─── SUPABASE WRITERS ─────────────────────────────────────────────────────────

// ── FIX #7: Retry wrapper for all Supabase RPC calls ─────────────────────────
// Silent data loss on transient DB failure is unacceptable when real money is
// involved. Retries with exponential backoff (2s, 4s, 6s). Logs each attempt.
async function rpcWithRetry(fn, label, maxAttempts = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (result.error) throw new Error(result.error.message);
      return result;
    } catch (err) {
      if (attempt === maxAttempts) {
        logger.error(`[RPC FAILED after ${maxAttempts} attempts] ${label}: ${err.message}`);
        throw err;
      }
      logger.warn(`[RPC retry ${attempt}/${maxAttempts}] ${label}: ${err.message}`);
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
}

async function writeSupabaseDailyMetrics(symbol, scoreObj, priceData, technicals, spyPrice, regimeStatus) {
  const safeSignal = VALID_SIGNALS.includes(regimeStatus) ? regimeStatus : 'HOLD';
  try {
    await rpcWithRetry(
      () => supabase.rpc('upsert_daily_metrics', {
        p_date:          TODAY,
        p_symbol:        symbol,
        p_price:         priceData?.price          ?? 0,
        p_spy_price:     spyPrice                  ?? 0,
        p_volume:        Math.round(technicals?.currentVolume ?? 0),
        p_total_score:   scoreObj.total,
        p_fund_score:    scoreObj.fund,
        p_tech_score:    scoreObj.tech,
        p_analyst_score: scoreObj.rating,
        p_news_score:    scoreObj.news,
        p_insider_score: scoreObj.insider,
        p_signal:        safeSignal
      }),
      `daily_metrics:${symbol}`
    );
  } catch (e) { /* already logged by rpcWithRetry */ }
}

async function writeSupabaseQuarterlyFundamentals(symbol, fundamentals, secCapex, fiscalPeriod = null, sharesOutstandingM = null, rawFcfMargin = null) {
  if (!fundamentals) return;
  try {
    await rpcWithRetry(
      () => supabase.rpc('upsert_fundamentals_snapshot', {
        p_date:                TODAY,
        p_symbol:              symbol,
        p_fiscal_period:       fiscalPeriod ?? null,
        p_roic_pct:            fundamentals.roic              != null ? parseFloat((fundamentals.roic * 100).toFixed(4))            : null,
        // B5 FIX: store raw GAAP FCF margin (p_fcf_margin_pct) AND SBC-adjusted (p_fcf_margin_adj_pct).
        // Raw = what Finnhub reports (GAAP). Adjusted = after SBC deduction (what the score used).
        // Historical trend analysis can now distinguish GAAP degradation from SBC-driven adjustment.
        p_fcf_margin_pct:      rawFcfMargin                   != null ? parseFloat((rawFcfMargin * 100).toFixed(4))                  : null,
        p_fcf_margin_adj_pct:  fundamentals.fcfMargin         != null ? parseFloat((fundamentals.fcfMargin * 100).toFixed(4))        : null,
        p_gross_margin_pct:    fundamentals.grossMargin       != null ? parseFloat((fundamentals.grossMargin * 100).toFixed(4))      : null,
        p_operating_margin_pct: fundamentals._raw?.operatingMarginPct != null ? parseFloat(fundamentals._raw.operatingMarginPct.toFixed(4)) : null,
        p_de_ratio:            fundamentals.debtToEquity      != null ? parseFloat(fundamentals.debtToEquity.toFixed(4))             : null,
        p_revenue_growth_yoy:  fundamentals.revenueGrowthYoY != null ? parseFloat((fundamentals.revenueGrowthYoY * 100).toFixed(4)) : null,
        p_revenue_growth_3y:   fundamentals.revenueGrowth3Y  != null ? parseFloat((fundamentals.revenueGrowth3Y * 100).toFixed(4))  : null,
        p_sbc_millions:        fundamentals.sbcMillions       ?? null,
        p_shares_outstanding_m: sharesOutstandingM            ?? null,
        p_capex_millions:      secCapex?.capex                != null ? parseFloat(Math.abs(secCapex.capex).toFixed(2))             : null,
        p_ocf_millions:        secCapex?.ocf                  != null ? parseFloat(secCapex.ocf.toFixed(2))                         : null,
        p_net_income_millions: secCapex?.netIncome            != null ? parseFloat(secCapex.netIncome.toFixed(2))                   : null,
      }),
      `fundamentals_snapshot:${symbol}`
    );
  } catch (e) { /* already logged by rpcWithRetry */ }
}

async function writeSupabaseRegimeFlags({ symbol, w1, w2, w3, w4, beta, excessReturn, regimeStatus, action, springDays, capexException, qualityScore, rsi }) {
  try {
    await rpcWithRetry(
      () => supabase.rpc('upsert_regime_flags', {
        p_date:              TODAY,
        p_symbol:            symbol,
        p_w1_signal:         w1             ?? false,
        p_w2_confirmed:      w2             ?? false,
        p_w3_confirmed:      w3             ?? false,
        p_w4_confirmed:      w4             ?? false,
        p_beta_63d:          beta           ?? 1.0,
        p_excess_return_pct: excessReturn   ?? 0,
        p_regime_status:     regimeStatus   ?? 'MARKET_NOISE',
        p_action:            action         ?? 'HOLD',
        p_spring_days:       springDays     ?? 0,
        p_capex_exception:   capexException ?? false,
        p_quality_score:     qualityScore   ?? null,
        p_rsi_14:            rsi            ?? null
      }),
      `regime_flags:${symbol}`
    );
  } catch (e) { /* already logged by rpcWithRetry */ }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function ensureCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath,
      'Date,Symbol,Final_Score,Regime,Action,Price,SpyPrice,Fundamentals,Technicals,Analysts,News,Insiders,Beta,ExcessReturn,W1,W2,W3,W4,SpringDays,CapexException,SharpDrop,ScoreDelta\n'
    );
  }
}

function appendCsvRow(csvPath, symbol, scoreObj, priceData, spyPrice, regimeStatus, action, beta, excessReturn, w1, w2, w3, w4, springDays, capexException, sharpDrop = false, scoreDelta = 0) {
  const line = [
    TODAY, symbol,
    scoreObj.total.toFixed(2), regimeStatus, action,
    priceData?.price ?? 0, spyPrice ?? 0,
    scoreObj.fund.toFixed(2), scoreObj.tech.toFixed(2),
    scoreObj.rating.toFixed(2), scoreObj.news.toFixed(2), scoreObj.insider.toFixed(2),
    (beta ?? 1).toFixed(4), (excessReturn ?? 0).toFixed(4),
    w1 ? 1 : 0, w2 ? 1 : 0, w3 ? 1 : 0, w4 ? 1 : 0,
    springDays ?? 0, capexException ? 1 : 0,
    sharpDrop ? 1 : 0, (scoreDelta ?? 0).toFixed(2)
  ].join(',') + '\n';
  fs.appendFileSync(csvPath, line);
}

// BUG-002 FIX: return null (not 0) when history is insufficient — consistent with computeNdReturn.
// A silent 0 pushes spyReturn21d to 0 → marketRegime forced to NORMAL when SPY data is missing.
function compute21dReturn(historyAsc) {
  if (!historyAsc || historyAsc.length < 22) return null;
  const recent = historyAsc[historyAsc.length - 1].c;
  const prior  = historyAsc[historyAsc.length - 21].c;
  if (!prior) return null;
  return ((recent - prior) / prior) * 100;
}

/**
 * computeNdReturn — general n-day return on a full price history.
 * B1 FIX: compute21dReturn(historyAsc.slice(-8)) produced NaN because
 * slice(-8).length=8, then [8-21]=-13 → undefined → NaN → spring signals
 * never fired. This function takes the full history and indexes correctly.
 */
function computeNdReturn(historyAsc, n) {
  if (!historyAsc || historyAsc.length < n + 1) return null;
  const recent = historyAsc[historyAsc.length - 1].c;
  const prior  = historyAsc[historyAsc.length - 1 - n].c;
  if (!prior) return null;
  return ((recent - prior) / prior) * 100;
}

function computeMaxDrawdown(historyAsc) {
  if (!historyAsc || historyAsc.length < 10) return null;
  const window = historyAsc.slice(-252);
  let peak = -Infinity;
  let maxDD = 0;
  for (const bar of window) {
    if (bar.c > peak) peak = bar.c;
    const dd = (bar.c - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return parseFloat((maxDD * 100).toFixed(2));
}

async function getPreviousSpringDays(symbol) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yDate = yesterday.toISOString().split('T')[0];
  const { data } = await supabase
    .from('regime_flags')
    .select('spring_days, action')
    .eq('symbol', symbol)
    .lte('date', yDate)
    .order('date', { ascending: false })
    .limit(1);
  if (!data?.length) return 0;
  const prev = data[0];
  if (!prev?.action) return 0;
  return ['SPRING_CANDIDATE', 'SPRING_CONFIRMED'].includes(prev.action) ? (prev.spring_days ?? 0) : 0;
}

// F06: getIntradayNewsScore() removed — dead code. Replaced by the batch query
// (intradayNewsMap) built before the stock loop. See 'batch intraday news' block.

// ─── INSIDER CACHE HELPER ──────────────────────────────────────────────────────

async function fetchInsiderCached(symbol, storage) {
  const cacheKey = `insider_cache_${symbol}`;
  try {
    const rc = await getRedisClient();
    if (rc) {
      const redisRaw = await rc.get(cacheKey).catch(() => null);
      if (redisRaw) return JSON.parse(redisRaw);
    }
  } catch (e) { /* cache miss */ }

  const _localAnalyzer = new PriceAnalyzer();
  const fresh = await _localAnalyzer.fetchInsider(symbol);

  if (fresh !== null) {
    try {
      const rc = await getRedisClient();
      if (rc) await rc.set(cacheKey, JSON.stringify(fresh), { EX: 604800 });
    } catch (e) { /* write failure non-critical */ }
  }

  return fresh;
}

// ─── MAIN PIPELINE ────────────────────────────────────────────────────────────

async function updateMarketData() {
  const storage  = new PortfolioStorage();
  const analyzer = new PriceAnalyzer();

  const dataDir = path.resolve(__dirname, '../data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const csvPath = path.join(dataDir, 'score_history.csv');
  ensureCsv(csvPath);

  try {
    logger.info('╔════════════════════════════════════════════════════════════╗');
    logger.info('║     PORTFOLIO REGIME ANALYSIS ENGINE — EOD Master Run      ║');
    logger.info(`║     Date: ${TODAY}                                   ║`);
    logger.info('╚════════════════════════════════════════════════════════════╝');

    const _isManualRun = process.env.FORCE_RUN === 'true';
    const _holidayRedis = createRedisClient({ url: process.env.REDIS_URL });
    _holidayRedis.on('error', () => {});
    await _holidayRedis.connect().catch(() => {});
    let _marketClosed = false;
    try {
      _marketClosed = await isMarketClosedToday(_holidayRedis);
    } finally {
      await _holidayRedis.quit().catch(() => {});
    }

    if (_marketClosed && !_isManualRun) {
      logger.info(`\n🏖️  Market closed today (${TODAY}) — confirmed via Polygon.`);
      logger.info('   Skipping EOD updates. News-only runs are unaffected.');
      process.exit(0);
    }
    if (_marketClosed && _isManualRun) {
      logger.info(`\n⚡ Market closed today but FORCE_RUN=true — proceeding with manual run.`);
    }

    const portfolio = await storage.getPortfolio();
    const stocks    = portfolio.stocks || [];
    if (stocks.length === 0) { logger.warn('No stocks in portfolio.'); process.exit(0); }

    logger.info('\n→ Fetching SPY benchmark...');
    const spyTechnicals = await analyzer.fetchTechnicals('SPY');
    if (!spyTechnicals) { logger.error('SPY fetch failed. Aborting.'); process.exit(1); }

    // BUG-002 FIX: compute21dReturn now returns null for insufficient history.
    // Guard here — SPY null is fatal since marketRegime depends entirely on spyReturn21d.
    const spyReturn21d = compute21dReturn(spyTechnicals.historyAsc);
    if (spyReturn21d === null) {
      logger.error('SPY 21d return is null — insufficient price history (<22 bars). Aborting run.');
      const client = await getRedisClient();
      if (client) await client.quit().catch(() => {});
      process.exit(1);
    }
    const spyPrice     = spyTechnicals.historyDesc[0].c;

    const spy21dSlice = spyTechnicals.historyAsc.slice(-21);
    let _spyPeak = spy21dSlice[0]?.c || 1;
    let spyMaxDD21d = 0;
    for (const bar of spy21dSlice) {
      if (bar.c > _spyPeak) _spyPeak = bar.c;
      const dd = ((bar.c - _spyPeak) / _spyPeak) * 100;
      if (dd < spyMaxDD21d) spyMaxDD21d = dd;
    }
    const spyWorstSignal = Math.min(spyReturn21d, spyMaxDD21d);
    const marketRegime = spyWorstSignal > -3 ? 'NORMAL'
                       : spyWorstSignal > -8 ? 'STRESSED'
                       : 'BEAR';
    logger.info(`  SPY 21d return: ${spyReturn21d.toFixed(2)}% | 21d MaxDD: ${spyMaxDD21d.toFixed(2)}% | Market Regime: ${marketRegime}`);

    try {
      const _mrc = await getRedisClient();
      if (_mrc) await _mrc.set('market_regime', JSON.stringify({
        regime:      marketRegime,
        spy21d:      parseFloat(spyReturn21d.toFixed(2)),
        spyMaxDD21d: parseFloat(spyMaxDD21d.toFixed(2)),
        date:        TODAY,
      }), { EX: 100800 });
    } catch (e) { /* non-critical */ }

    const totalPortfolioValue = stocks.reduce(
      (sum, s) => sum + ((s.current_price || 0) * (s.quantity || 0)), 0
    );

    // ── Batch intraday news ───────────────────────────────────────────────────
    const intradayNewsMap = {};
    try {
      const { data: allNewsRows, error: newsErr } = await supabase
        .from('intraday_news_log')
        .select('symbol, run_slot, news_score, recency_weight, article_count')
        .eq('date', TODAY)
        .in('symbol', stocks.map(s => s.symbol));

      if (newsErr) {
        logger.warn(`Batch intraday news read failed: ${newsErr.message} — using neutral 5.0 for all`);
      } else {
        for (const sym of stocks.map(s => s.symbol)) {
          const runs = (allNewsRows || []).filter(r => r.symbol === sym);
          if (!runs.length) { intradayNewsMap[sym] = null; continue; }
          let wSum = 0, tW = 0;
          runs.forEach(r => {
            const w = parseFloat(r.recency_weight) || 0;
            const ew = w > 0 ? w : (r.article_count || 1);
            wSum += parseFloat(r.news_score) * ew;
            tW   += ew;
          });
          intradayNewsMap[sym] = tW > 0
            ? parseFloat(Math.max(0, Math.min(10, wSum / tW)).toFixed(2))
            : null;
        }
        logger.info(`  📰 Intraday news loaded for ${Object.keys(intradayNewsMap).length} symbols (1 query)`);
      }
    } catch (e) {
      logger.warn(`Batch intraday news query threw: ${e.message} — using neutral 5.0 for all`);
    }

    for (const stock of stocks) {
      try {
        logger.info(`\n${'─'.repeat(60)}`);
        logger.info(`Analyzing: ${stock.symbol}`);

        const intradayNewsScore = intradayNewsMap[stock.symbol] ?? null;
        if (intradayNewsScore !== null) {
          logger.info(`  📰 Intraday news score: ${intradayNewsScore.toFixed(2)}`);
        } else {
          logger.info(`  ⚪ No intraday news logged today — using neutral 5.0`);
        }

        const instrumentProfile   = await fetchInstrumentType(stock.symbol, process.env.FINNHUB_API_KEY);
        const profileExpenseRatio = instrumentProfile.expenseRatio;

        let fmpIsEtf = false;
        if (!instrumentProfile.isETF && stock.type !== 'ETF') {
          fmpIsEtf = await checkFmpIsEtf(stock.symbol);
        }

        const instrumentIsETF = (
          instrumentProfile.isETF ||
          fmpIsEtf              ||
          stock.type === 'ETF'
        );
        const instrumentIsADR = !instrumentIsETF && instrumentProfile.raw === 'DR';
        const instrumentTypeName = instrumentIsETF ? 'ETF' : instrumentProfile.raw;

        let accountingStandard = 'US-GAAP';
        if (instrumentIsADR) {
          accountingStandard = await detectAccountingStandard(stock.symbol);
          if (accountingStandard === 'IFRS') {
            logger.warn(`  🌍 ADR (${instrumentProfile.raw}) — IFRS filer: XBRL cash flow data may be unavailable`);
          }
        }

        if (instrumentIsETF) {
          logger.info(`  ℹ️  ETF (${instrumentProfile.raw}) — skipping fundamental/insider/filing calls`);
        } else if (instrumentIsADR) {
          logger.info(`  ℹ️  ADR (${instrumentProfile.raw}) — ${accountingStandard} — 6-K monitoring active`);
        } else {
          logger.info(`  ℹ️  ${instrumentTypeName}`);
        }

        if (!instrumentIsETF && (stock.sector === 'Unknown' || !stock.sector || stock.name === stock.symbol)) {
          try {
            const fhName     = instrumentProfile.name     ?? null;
            const fhIndustry = instrumentProfile.industry ?? null;
            const needsFix   = (stock.name === stock.symbol && fhName) || ((stock.sector === 'Unknown' || !stock.sector) && fhIndustry);
            if (needsFix) {
              const portfolio = await storage.getPortfolio();
              const idx = portfolio.stocks.findIndex(s => s.symbol === stock.symbol);
              if (idx >= 0) {
                if (fhName && portfolio.stocks[idx].name === stock.symbol) {
                  portfolio.stocks[idx].name = fhName;
                  stock.name = fhName;
                  logger.info(`  📛 Name auto-fixed: ${stock.symbol} → "${fhName}"`);
                }
                if (fhIndustry && (portfolio.stocks[idx].sector === 'Unknown' || !portfolio.stocks[idx].sector)) {
                  portfolio.stocks[idx].sector = fhIndustry;
                  stock.sector = fhIndustry;
                  logger.info(`  🏭 Sector auto-fixed: ${stock.symbol} → "${fhIndustry}"`);
                }
                await storage.writeData(portfolio);
              }
            }
          } catch (e) { /* non-critical */ }
        }

        // E7/F07 FIX: fetchFilingSentiment was called AFTER Promise.all, adding ~2s serial latency
        // per stock (2 sequential Finnhub calls). Moved into the parallel block — saves ~36s per run.
        const [priceData, fundamentals, technicals, ratings, insiderData, secCapex, sbcMillions, recent8K, filingSentiment] = await Promise.all([
          analyzer.fetchPrice(stock.symbol),
          instrumentIsETF ? Promise.resolve(null) : analyzer.fetchFundamentals(stock.symbol),
          analyzer.fetchTechnicals(stock.symbol),
          instrumentIsETF ? Promise.resolve(null) : analyzer.fetchRatings(stock.symbol),
          instrumentIsETF ? Promise.resolve(null) : fetchInsiderCached(stock.symbol, storage),
          instrumentIsETF ? Promise.resolve(null) : (typeof quantEngine.fetchSECCashFlow === 'function' ? quantEngine.fetchSECCashFlow(stock.symbol) : Promise.resolve(null)),
          instrumentIsETF ? Promise.resolve(null) : fetchSECStockBasedComp(stock.symbol),
          instrumentIsETF ? Promise.resolve(null) : fetchRecent8K(stock.symbol, instrumentProfile.raw === 'DR'),
          instrumentIsETF ? Promise.resolve(null) : fetchFilingSentiment(stock.symbol),
        ]);

        if (fundamentals && sbcMillions != null && sbcMillions > 0
            && fundamentals.marketCapM > 0 && fundamentals.fcfMargin > 0) {
          fundamentals.sbcMillions    = sbcMillions;
          fundamentals.sbcToMarketCap = parseFloat((sbcMillions / fundamentals.marketCapM).toFixed(4));
        }

        const capexException       = secCapex?.capexException       ?? false;
        const earningsQualityFlag  = secCapex?.earningsQualityFlag  ?? null;
        const debtMaturityFlag     = secCapex?.debtMaturityFlag      ?? null;
        if (capexException) logger.info(`  ⚠️  CAPEX EXCEPTION: FCF penalty forgiven.`);
        if (earningsQualityFlag === 'risk') logger.warn(`  🚨 EARNINGS QUALITY RISK: positive GAAP income but negative OCF — ROIC suspect.`);

        if (fundamentals) {
          fundamentals._earningsQualityFlag = earningsQualityFlag;
        }

        // TDZ FIX: maxDrawdown declared before calculateScore to avoid temporal dead zone crash.
        const maxDrawdown = technicals ? computeMaxDrawdown(technicals.historyAsc) : null;

        const scoreObj = analyzer.calculateScore(
          priceData, fundamentals, technicals,
          ratings, null, insiderData, capexException,
          intradayNewsScore,
          instrumentIsETF,
          instrumentIsETF ? (profileExpenseRatio ?? null) : null,
          recent8K
        );

        // B5 FIX: Capture raw GAAP FCF margin BEFORE mutating fundamentals.fcfMargin.
        // Previously the raw value was permanently overwritten, meaning Supabase
        // stored only the SBC-adjusted figure with no way to recover the GAAP original.
        // Now both are available: raw for the DB column, adjusted for the scoring column.
        const _rawFcfMarginForDB = fundamentals?.fcfMargin ?? null;
        if (fundamentals && scoreObj._adjFcfMargin !== null) {
          fundamentals.fcfMargin = scoreObj._adjFcfMargin;
        }

        const realizedVol   = technicals ? quantEngine.computeVolatility(technicals.historyAsc) : null;
        const momentumLabel = technicals ? quantEngine.evaluateMomentum(technicals.historyAsc) : 'NEUTRAL';

        const moatScore = fundamentals?._moatScore ?? null;
        const fcfYield  = fundamentals?.fcfYield   ?? null;
        const revenueGrowthPct = fundamentals?._raw?.revenueGrowthPct ?? null;
        const grossMarginPct   = fundamentals?._raw?.grossMarginPct   ?? null;

        if (instrumentIsETF) {
          logger.info(`  📊 [ETF] Tech(${scoreObj.tech.toFixed(1)}) Analyst(${scoreObj.rating.toFixed(1)}) News(${scoreObj.news.toFixed(1)}) → Total(${scoreObj.total.toFixed(1)}) | MaxDD: ${maxDrawdown ?? '—'}%`);
        } else {
          logger.info(`  📊 Fund(${scoreObj.fund.toFixed(1)}) Tech(${scoreObj.tech.toFixed(1)}) Analyst(${scoreObj.rating.toFixed(1)}) News(${scoreObj.news.toFixed(1)}) Insider(${scoreObj.insider.toFixed(1)}) → Total(${scoreObj.total.toFixed(1)})`);
          if (moatScore != null) logger.info(`  🏰 Moat: ${moatScore.toFixed(1)}/10 | RevGrowth3Y: ${(fundamentals?._raw?.revenueGrowth3YPct ?? 0).toFixed(1)}% | YoY: ${(revenueGrowthPct ?? 0).toFixed(1)}% | GrossMargin: ${(grossMarginPct ?? 0).toFixed(1)}% | MaxDD: ${maxDrawdown ?? '—'}%`);
        }
        if (filingSentiment) logger.info(`  📄 Filing tone (${filingSentiment.form}): ${filingSentiment.score.toFixed(1)}/10 | pos:${(filingSentiment.positive*100).toFixed(2)}% neg:${(filingSentiment.negative*100).toFixed(2)}%`);
        if (sbcMillions != null) logger.info(`  💸 SBC: $${sbcMillions.toFixed(1)}M | as % mktcap: ${((fundamentals?.sbcToMarketCap ?? 0)*100).toFixed(2)}%`);
        if (recent8K) logger.info(`  📋 ${recent8K.item === '6-K' ? '6-K' : '8-K'}${recent8K.isAmendment ? '/A' : ''}: ${recent8K.icon} ${recent8K.label} (${recent8K.filedDate}, ${(recent8K.daysOld ?? 0).toFixed(0)}d old) — ${recent8K.hint}${recent8K.scoreAdj ? ` [adj ${recent8K.scoreAdj >= 0 ? '+' : ''}${recent8K.scoreAdj}]` : ''}`);

        let beta = 1.0, excessReturn = 0, noiseDecay = 'INSUFFICIENT_DATA';
        let regimeStatus = 'HOLD', action = 'HOLD';
        let springSignal = false, springDays = 0, addSignal = false;
        let w1 = false, w2 = false, w3 = false, w4 = false;
        let sharpDrop = false, scoreDelta = 0;

        if (technicals && spyTechnicals) {
          beta = quantEngine.calculateBeta(technicals.historyAsc, spyTechnicals.historyAsc);
          // BUG-002: compute21dReturn now returns null for insufficient history.
          // Stock-level null → 0 is acceptable (stock may be new/thin data); SPY null is fatal (aborted above).
          const stockReturn21d = compute21dReturn(technicals.historyAsc) ?? 0;
          excessReturn = quantEngine.calculateExcessReturn(stockReturn21d, beta, spyReturn21d);
          noiseDecay = excessReturn > -5  ? 'MARKET_NOISE'
                     : excessReturn > -12 ? 'WATCH'
                     : 'IDIOSYNCRATIC_DECAY';

          const { data: supData, error: supError } = await supabase
            .from('daily_metrics')
            .select('fund_score, date')
            .eq('symbol', stock.symbol)
            .order('date', { ascending: false })
            .limit(252);

          if (supError) logger.warn(`Supabase history fetch failed: ${supError.message}`);
          // W5 FIX: explicit date sort — safer than relying on DB ordering + .reverse().
          const history252d = (supData || []).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

          let _moatStrength = null;
          try {
            const _rc2 = await getRedisClient();
            if (_rc2) {
              const _fnRaw = await _rc2.get(`filing_narrative_${stock.symbol}`).catch(() => null);
              if (_fnRaw) {
                const _fn = JSON.parse(_fnRaw);
                const _ms = _fn?.gemini?.regulatory_moat_strength;
                if (typeof _ms === 'number' && _ms >= 1 && _ms <= 5) _moatStrength = _ms;
              }
            }
          } catch (e) { /* moat strength unavailable — use defaults */ }

          const _moatWindows = {
            5: [11, 32], 4: [9, 27], 3: [7, 21], 2: [5, 15], 1: [4, 12]
          };
          const [_w1Days, _w2Days] = _moatWindows[_moatStrength] ?? [7, 21];
          logger.info(`  🏛️  Moat strength: ${_moatStrength ?? 'none'} → W1 window: ${_w1Days}d, W2 window: ${_w2Days}d`);

          regimeStatus = typeof quantEngine.evaluateFractalDecay === 'function'
            ? quantEngine.evaluateFractalDecay(history252d, noiseDecay, { w1: _w1Days, w2: _w2Days })
            : noiseDecay;

          const _hasW = typeof quantEngine._w1Trigger === 'function';
          w1 = (_hasW && history252d.length >= _w1Days) ? quantEngine._w1Trigger(history252d.slice(-_w1Days)) : false;
          w2 = (_hasW && history252d.length >= _w2Days) ? quantEngine._w2Trigger(history252d.slice(-_w2Days)) : false;
          w3 = (_hasW && history252d.length >= 63)      ? quantEngine._w3Trigger(history252d.slice(-63))      : false;
          w4 = (_hasW && history252d.length >= 252)     ? quantEngine._w4Trigger(history252d)                 : false;

          const prevFundScore = history252d.length >= 1
            ? history252d[history252d.length - 1].fund_score
            : null;
          scoreDelta = prevFundScore != null ? scoreObj.fund - prevFundScore : 0;
          sharpDrop  = scoreDelta <= -1.0;
          if (sharpDrop) {
            logger.warn(`  ⚡ SHARP SCORE DROP: ${stock.symbol} fund ${prevFundScore?.toFixed(1)} → ${scoreObj.fund.toFixed(1)} (Δ${scoreDelta.toFixed(1)})`);
          }

          const history20d     = technicals.historyAsc.slice(-20);
          const prevSpringDays = await getPreviousSpringDays(stock.symbol);
          const excessReturn7d = computeNdReturn(technicals.historyAsc, 7);

          // B13: guard — null means < 8 bars of history, spring signal is unreliable
          // B01-ZB: spring required excessReturn > 0, blocking genuine dip scenarios.
          // A beaten-down quality stock has NEGATIVE short-term excess return — that's the point.
          // Allow up to -8% underperformance. Quality threshold lowered for hypergrowth/high-moat.
          const _springQualThreshold = (fundamentals?._hypergrowthMode || (fundamentals?._moatScore ?? 0) > 6.5)
            ? 6.0 : 7.0;
          const _springExcessAdj = excessReturn7d !== null ? Math.max(excessReturn7d, -8) : null;
          // S-001 FIX: removed Math.max(0.001) — the B01-ZB fix allows negative excess returns
          // for spring detection, but the clamp silently converted them to near-zero positive,
          // preventing springs on beaten-down quality stocks (exactly the use case we want).
          springSignal = _springExcessAdj !== null && scoreObj.fund > _springQualThreshold
            ? quantEngine.evaluateSpring(history20d, scoreObj.fund, _springExcessAdj)
            : false;

          if (springSignal) {
            springDays = prevSpringDays + 1;
            action     = springDays >= 3 ? 'SPRING_CONFIRMED' : 'SPRING_CANDIDATE';
          } else {
            springDays = 0;
            action     = regimeStatus;
          }

          const currentWeight = totalPortfolioValue > 0
            ? ((priceData?.price ?? 0) * (stock.quantity ?? 0)) / totalPortfolioValue
            : 0;

          addSignal = quantEngine.evaluateAdd(history252d.slice(-63), excessReturn, technicals.rsi, currentWeight);
          // F10 FIX: Spring signals serve a different purpose than ADD (bounce-recovery vs accumulation).
          // ADD should not silently overwrite SPRING_CANDIDATE or SPRING_CONFIRMED — spring days
          // counter would be lost and the spring-confirmation sequence would break.
          if (addSignal && !['TRIM_25', 'SELL', 'SPRING_CANDIDATE', 'SPRING_CONFIRMED'].includes(action)) action = 'ADD';
        }

        if (scoreObj._8kCriticalOverride) {
          action = 'SELL';
          logger.warn(`  🚨 CRITICAL 8-K OVERRIDE: action forced to SELL (${recent8K?.label})`);
        }

        // ── Tax basis gate (T-001-ZA): protect high-gain positions from premature sells ──
        // Indian investors pay 20% LTCG / 30% STCG on US equity gains.
        // A TRIM_25 on a position with 200% unrealised gain could cost more in tax
        // than the downside risk being hedged. Downgrade aggressive signals when gain is large.
        // This requires quantity, average_price, and current_price on the stock object.
        const _gainPct = stock.average_price > 0 && priceData?.price > 0
          ? ((priceData.price - stock.average_price) / stock.average_price) * 100
          : null;
        if (_gainPct !== null && !scoreObj._8kCriticalOverride) {
          if (action === 'SELL' && _gainPct > 100 && !w4) {
            action = 'TRIM_25';
            logger.info(`  🇮🇳 Tax gate: SELL→TRIM_25 (${_gainPct.toFixed(0)}% gain, no W4 confirmation)`);
          } else if (action === 'TRIM_25' && _gainPct > 200 && !w4) {
            action = 'WATCH';
            logger.info(`  🇮🇳 Tax gate: TRIM_25→WATCH (${_gainPct.toFixed(0)}% gain, no W4 — tax cost likely > protection value)`);
          }
        }

        logger.info(`  🧠 Regime: ${noiseDecay} | Action: ${action} | Beta: ${beta.toFixed(2)} | Excess21d: ${excessReturn.toFixed(2)}%`);
        logger.info(`  📈 Cascade: W1=${w1} W2=${w2} W3=${w3} W4=${w4} | Spring: ${springDays}d`);

        await writeSupabaseDailyMetrics(stock.symbol, scoreObj, priceData, technicals, spyPrice, action);
        await writeSupabaseRegimeFlags({ symbol: stock.symbol, w1, w2, w3, w4, beta, excessReturn, regimeStatus: noiseDecay, action, springDays, capexException, qualityScore: scoreObj.fund, rsi: technicals?.rsi ?? null });

        if (!instrumentIsETF) {
          const _qEnd      = secCapex?.quarterEnd ?? null;
          const _fiscalPeriod = _qEnd
            ? (() => {
                const _d = new Date(_qEnd);
                const _q = Math.ceil((_d.getMonth() + 1) / 3);
                return `Q${_q}-${_d.getFullYear()}`;
              })()
            : null;
          await writeSupabaseQuarterlyFundamentals(
            stock.symbol, fundamentals, secCapex, _fiscalPeriod,
            fundamentals?._raw?.sharesOutstandingM ?? null,
            _rawFcfMarginForDB
          );
        }

        const redisUpdates = {
          latest_score:    Math.round(scoreObj.total * 10) / 10,
          signal:          action,
          // BUG-001 FIX: marketRegime is a plain string, not an object.
          // marketRegime?.regime was always undefined → ?? 'NORMAL' always fired.
          // classic_signal never adjusted for BEAR/STRESSED conditions.
          classic_signal:  analyzer.getSignal(scoreObj.total, marketRegime ?? 'NORMAL'),
          instrument_type:       instrumentIsETF ? 'ETF' : (instrumentIsADR ? 'ADR' : 'Stock'),
          expense_ratio:         profileExpenseRatio ?? null,
          accounting_standard:   accountingStandard,
          is_foreign_filer:      instrumentIsADR,
          current_price:   priceData?.price        ?? stock.current_price,
          change_percent:  priceData?.changePercent ?? stock.change_percent,
          score_breakdown: scoreObj,
          regime:          noiseDecay,
          excess_return:   excessReturn,
          beta,
          spring_days:     springDays,
          w1_signal:       w1,
          w2_confirmed:    w2,
          moat_score:          moatScore,
          fcf_yield:           fcfYield != null ? parseFloat(fcfYield.toFixed(4)) : null,
          ev_fcf:              fundamentals?.evFcf != null ? parseFloat(fundamentals.evFcf.toFixed(1)) : null,
          pe_ttm:              fundamentals?.peTTM       ?? null,
          forward_pe:          fundamentals?.forwardPE   ?? null,
          ps_ttm:              fundamentals?.psTTM       ?? null,
          pb_annual:           fundamentals?.pbAnnual    ?? null,
          ev_ebitda:           fundamentals?.evEbitdaTTM ?? null,
          net_margin_pct:      fundamentals?.netMarginTTM ?? null,
          eps_growth_3y:       fundamentals?.epsGrowth3Y ?? null,
          peg_ratio:           fundamentals?.pegRatio    ?? null,
          max_drawdown:        maxDrawdown,
          revenue_growth_pct:  revenueGrowthPct != null ? parseFloat(revenueGrowthPct.toFixed(1)) : null,
          revenue_growth_3y:   fundamentals?._raw?.revenueGrowth3YPct != null ? parseFloat(fundamentals._raw.revenueGrowth3YPct.toFixed(1)) : null,
          gross_margin_pct:    grossMarginPct   != null ? parseFloat(grossMarginPct.toFixed(1))   : null,
          sbc_millions:        sbcMillions != null ? parseFloat(sbcMillions.toFixed(1)) : null,
          sbc_to_market_cap:   fundamentals?.sbcToMarketCap != null ? parseFloat((fundamentals.sbcToMarketCap * 100).toFixed(2)) : null,
          filing_sentiment:    filingSentiment ? filingSentiment.score : null,
          filing_form:         filingSentiment ? filingSentiment.form  : null,
          event_8k:            recent8K ? recent8K.label      : null,
          event_8k_hint:       recent8K ? recent8K.hint       : null,
          event_8k_icon:       recent8K ? recent8K.icon       : null,
          event_8k_date:       recent8K ? recent8K.filedDate  : null,
          event_8k_item:       recent8K ? recent8K.item       : null,
          event_8k_score_adj:  recent8K ? recent8K.scoreAdj   : null,
          event_8k_days_old:   recent8K ? Math.round(recent8K.daysOld ?? 0) : null,
          event_8k_amendment:  recent8K ? (recent8K.isAmendment ?? false) : null,
          score_fund:          scoreObj.fund    != null ? parseFloat(scoreObj.fund.toFixed(1))    : null,
          score_tech:          scoreObj.tech    != null ? parseFloat(scoreObj.tech.toFixed(1))    : null,
          score_rating:        scoreObj.rating  != null ? parseFloat(scoreObj.rating.toFixed(1))  : null,
          score_news:          scoreObj.news    != null ? parseFloat(scoreObj.news.toFixed(1))    : null,
          score_insider:       scoreObj.insider != null ? parseFloat(scoreObj.insider.toFixed(1)) : null,
          fcf_yield_score:     fcfYield != null ? parseFloat((fcfYield * 100).toFixed(2)) : null,
          w3_confirmed:    w3,
          w4_confirmed:    w4,
          capex_exception:         capexException,
          earnings_quality_flag:   earningsQualityFlag                   ?? null,
          debt_maturity_flag:      debtMaturityFlag                       ?? null,
          dilution_flag:           fundamentals?.dilutionFlag             ?? null,
          shares_yoy_pct:          fundamentals?.sharesYoYPct             ?? null,
          cyclical_peak_flag:      fundamentals?._cyclicalPeakFlag        ?? false,
          hypergrowth_mode:        fundamentals?._hypergrowthMode         ?? false,
          sharp_score_drop:        sharpDrop    ?? false,
          score_delta_1d:          scoreDelta != null ? parseFloat(scoreDelta.toFixed(2)) : null,
          sma50:                   technicals?.sma50   ?? null,
          sma200:                  technicals?.sma200  ?? null,
          realized_vol:            realizedVol         ?? null,
          momentum_label:          momentumLabel       ?? 'NEUTRAL',
          ...(priceData?.price && stock.quantity && { total_value: priceData.price * stock.quantity })
        };
        await storage.updateStock(stock.symbol, redisUpdates);

        appendCsvRow(csvPath, stock.symbol, scoreObj, priceData, spyPrice, noiseDecay, action, beta, excessReturn, w1, w2, w3, w4, springDays, capexException, sharpDrop, scoreDelta);

        logger.info(`  ✅ ${stock.symbol} complete → ${action}`);

      } catch (e) {
        const _eMsg = e instanceof Error ? e.message || e.constructor.name : String(e);
        const _eStack = e instanceof Error && e.stack
          ? ' | ' + e.stack.split(/\r?\n/).slice(1, 3).map(s => s.trim()).join(' > ')
          : '';
        logger.error(`Error processing ${stock.symbol}: ${_eMsg}${_eStack}`);
      }

      await sleep(SLEEP_BETWEEN_STOCKS_MS);
    }

    logger.info('\n╔════════════════════════════════════════════════════════════╗');
    logger.info('║           EOD REGIME AUDIT COMPLETED                       ║');
    logger.info('╚════════════════════════════════════════════════════════════╝');

    const client = await getRedisClient();
    if (client) await client.quit();
    process.exit(0);

  } catch (error) {
    logger.error('FATAL ERROR:', error);
    const client = await getRedisClient();
    if (client) await client.quit().catch(() => {});
    process.exit(1);
  }
}

updateMarketData();
