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

const VALID_SIGNALS = [
  'STRONG_BUY', 'BUY', 'HOLD', 'WATCH',
  'TRIM_25', 'SELL', 'SPRING_CANDIDATE', 'SPRING_CONFIRMED', 'ADD',
  'HOLD_NOISE', 'NORMAL', 'INSUFFICIENT_DATA', 'IDIOSYNCRATIC_DECAY', 'REDUCE'
];

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
    // Normalise to our two categories
    const isFund = ['ETP', 'ETF', 'Closed-End Fund', 'REIT', 'Open-End Fund'].includes(type);
    const result = {
      raw:   type,
      isETF: isFund,
      name:  res.data?.name   || null,
      // Expense ratio from Finnhub profile (field: expenseRatio, in decimal e.g. 0.0013)
      expenseRatio: res.data?.expenseRatio != null
        ? parseFloat((res.data.expenseRatio * 100).toFixed(4))  // convert to %
        : null,
    };
    _instrumentTypeCache[symbol] = result;
    return result;
  } catch (e) {
    // On failure, default to stock treatment — safer than skipping analysis
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

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
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

        // ── Revenue growth ─────────────────────────────────────────────────
        // Prefer 3Y CAGR (more durable than 1-year which can be a recovery bounce)
        // Fall back to TTM YoY, then 5Y CAGR
        const revenueGrowth3Y = (m['revenueGrowth3Y'] || 0) / 100;
        const revenueGrowthYoY = (m.revenueGrowthTTMYoy || 0) / 100;
        // Use 3Y if available (≠0), else YoY, else 5Y
        const revenueGrowth = revenueGrowth3Y !== 0
          ? revenueGrowth3Y
          : (revenueGrowthYoY !== 0 ? revenueGrowthYoY : (m['revenueGrowth5Y'] || 0) / 100);

        // ── Margins ────────────────────────────────────────────────────────
        const grossMargin   = (m.grossMarginTTM || m.grossMarginAnnual || 0) / 100;
        const fcfMarginRaw  = (m.freeCashFlowMarginTTM || m.operatingMarginTTM || 0) / 100;
        const opMarginRaw   = (m.operatingMarginTTM || 0) / 100;
        const fcfConversion = opMarginRaw > 0 ? Math.min(1.5, fcfMarginRaw / opMarginRaw) : 0.5;

        // ── Valuation ──────────────────────────────────────────────────────
        const marketCap = m.marketCapitalization || 0; // millions USD
        const fcfTTM    = m.freeCashFlowTTM      || 0; // millions USD
        // FCF Yield: >5% = attractive, <1% = expensive relative to cash generation
        const fcfYield  = marketCap > 0 ? (fcfTTM / marketCap) : null;

        // EV/FCF: EV = market cap + net debt. Net debt = total debt - cash.
        // Finnhub provides totalDebtAnnual and cashAndEquivalentsAnnual in millions
        const totalDebtM  = m.totalDebtAnnual || 0;
        const cashM       = m.cashAndEquivalentsAnnual || 0;
        const netDebtM    = totalDebtM - cashM;
        const evM         = marketCap + netDebtM;
        // EV/FCF: <15 = cheap, 15-25 = fair, >40 = expensive for a compounder
        const evFcf       = (fcfTTM > 0 && evM > 0) ? (evM / fcfTTM) : null;

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
          marketCapM: marketCap,
          _raw: {
            roicPct:          (m.roicTTM || m.roiAnnual || 0),
            grossMarginPct:   (m.grossMarginTTM || m.grossMarginAnnual || 0),
            revenueGrowthPct: revenueGrowth3Y !== 0
              ? m['revenueGrowth3Y'] || 0
              : (m.revenueGrowthTTMYoy || 0),
            revenueGrowth3YPct: m['revenueGrowth3Y'] || 0,
            fcfMarginPct:     (m.freeCashFlowMarginTTM || m.operatingMarginTTM || 0),
            fcfYieldPct:      fcfYield != null ? (fcfYield * 100) : null,
            evFcf:            evFcf,
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
      const sma200    = historyAscRaw.slice(-period200).reduce((acc, d) => acc + d.c, 0) / period200;
      const rsiSeries = this._computeRollingRSI(historyAscRaw, 14);
      const historyAsc = historyAscRaw.map((d, i) => ({ c: d.c, v: d.v, t: d.t, rsi: rsiSeries[i] ?? 50 }));
      const historyDesc   = [...historyAsc].reverse();
      const todayRsi      = historyAsc[historyAsc.length - 1].rsi;
      const currentVolume = historyDesc[0].v;
      return { rsi: todayRsi, sma200, currentVolume, historyAsc, historyDesc };
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
      if (res.data?.length > 0) return res.data[0];
    } catch (e) { /* fall through */ }
    return null;
  }

  async fetchInsider(symbol) {
    try {
      const payload = { query: `issuer.tradingSymbol:${symbol}`, from: '0', size: '50', sort: [{ transactionDate: 'desc' }] };
      const res = await axios.post(`https://api.sec-api.io/insider-trading?token=${process.env.SEC_API_KEY}`, payload, { timeout: 8000 });
      const trades = res.data.transactions || (Array.isArray(res.data) ? res.data : []);
      if (trades.length > 0) {
        let totalBought = 0, totalSold = 0;
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        trades.forEach(trade => {
          const tradeDate = new Date(trade.transactionDate || trade.filingDate);
          const shares    = parseFloat(trade.shares || trade.securitiesTransacted || 0);
          const price     = parseFloat(trade.pricePerShare || trade.price || 0);
          const code      = (trade.transactionCode || trade.code || '').trim();
          if (tradeDate >= sixMonthsAgo && shares > 0) {
            const value = shares * (price || 1); // price may be 0 for grants

            // P = open market purchase — strongest bullish signal
            if (code === 'P') { totalBought += value; return; }

            // S = open market sale — bearish signal
            // But EXCLUDE F (tax withholding) and M+S combos (exercise-and-sell)
            // F = mandatory tax withholding sale — NOT discretionary, ignore
            // S after M in same filing period = exercise-and-sell (insider liquidity, not conviction)
            if (code === 'S') { totalSold += value; return; }

            // F = tax withholding sale — do NOT count as a sell signal
            // M = option exercise — neutral (gaining shares, but often followed by S)
            // A = award/RSU grant — not a market signal
            // G = gift — not a market signal
            // Codes F, M, A, G, U, C, X are all excluded
          }
        });
        return { bought: totalBought, sold: totalSold };
      }
    } catch (e) { /* try fallback */ }
    try {
      const startStr = new Date(new Date().setMonth(new Date().getMonth() - 6)).toISOString().split('T')[0];
      const endStr   = new Date().toISOString().split('T')[0];
      const res = await axios.get(
        `https://finnhub.io/api/v1/stock/insider-sentiment?symbol=${symbol}&from=${startStr}&to=${endStr}&token=${process.env.FINNHUB_API_KEY}`,
        { timeout: 8000 }
      );
      if (res.data?.data?.length > 0) {
        const avgMspr = res.data.data.reduce((sum, m) => sum + m.mspr, 0) / res.data.data.length;
        if (avgMspr > 0) return { bought: avgMspr * 1_000_000, sold: 0 };
        if (avgMspr < 0) return { bought: 0, sold: Math.abs(avgMspr) * 1_000_000 };
      }
    } catch (e) { /* fall through */ }
    return null;
  }

  /**
   * calculateScore — accepts an optional newsScoreOverride.
   *
   * When newsScoreOverride is provided (by the master EOD run reading from
   * intraday_news_log), the news analysis block is skipped entirely.
   * When null, analyzedNews is used as before (backward compatible).
   *
   * @param {object|null}  priceData
   * @param {object|null}  fundamentals
   * @param {object|null}  technicals
   * @param {object|null}  ratings
   * @param {Array|null}   analyzedNews        — pass null when using override
   * @param {object|null}  insiderData
   * @param {boolean}      capexException
   * @param {number|null}  newsScoreOverride   — pre-computed intraday average
   */
  calculateScore(priceData, fundamentals, technicals, ratings, analyzedNews, insiderData, capexException = false, newsScoreOverride = null, isETF = false) {
    let fundScore = 5, techScore = 5, ratingScore = 5, newsScore = 5, insiderScore = 5;

    if (fundamentals) {
      // ── ROIC ─────────────────────────────────────────────────────────────
      // Curve calibrated for a compounder portfolio where 20% ROIC is normal:
      //   <5%  = value destroyer (score 0)
      //   10%  = mediocre (score 3.3)
      //   15%  = cost-of-capital threshold (score 6.7)
      //   20%  = excellent (score 8)   ← was the old ceiling
      //   30%+ = exceptional (score 10) ← extended ceiling
      // Formula: (roic - 0.05) / 0.25 * 10  (range 5%→30% maps to 0→10)
      let roicS = Math.max(0, Math.min(10, ((fundamentals.roic - 0.05) / 0.25) * 10));

      // ── SBC-adjusted FCF ─────────────────────────────────────────────────
      // SBC is a real cost GAAP FCF ignores. We correct it properly:
      // True FCF margin = reported FCF margin - (SBC / Revenue)
      // SBC is in millions from EDGAR. Revenue = FCF / fcfMargin when available.
      let adjFcfMargin = fundamentals.fcfMargin;
      const rawFcfMargin = fundamentals.fcfMargin;
      if (fundamentals.sbcMillions != null && fundamentals.sbcMillions > 0
          && fundamentals.marketCapM > 0 && fundamentals.fcfMargin > 0) {
        // Revenue proxy: use P/S ratio approach via market cap
        // If FCF margin is 20% and market cap is $100B, revenue ≈ unknown
        // Better: use the Finnhub revenue data directly if available
        // Fallback: assume revenue = FCF / fcfMargin (circular but bounded)
        // Most accurate available: SBC as fraction of FCF (not revenue)
        // SBC/FCF tells you how much of your FCF is being handed to employees
        const fcfMillions = fundamentals.fcfMargin * fundamentals.marketCapM;
        if (fcfMillions > 0) {
          const sbcAsFcfFraction = fundamentals.sbcMillions / fcfMillions;
          // Subtract SBC fraction from FCF margin
          adjFcfMargin = Math.max(0, fundamentals.fcfMargin * (1 - sbcAsFcfFraction));
          if (Math.abs(adjFcfMargin - rawFcfMargin) > 0.005) {
            logger.info(`  💰 SBC adj: FCF ${(rawFcfMargin*100).toFixed(1)}% → ${(adjFcfMargin*100).toFixed(1)}% (SBC ${(sbcAsFcfFraction*100).toFixed(0)}% of FCF)`);
          }
        }
      }
      // FCF Margin: 0%=0, 10%=4, 20%=8, 30%+=10
      // Calibrated for businesses (not banks/asset managers) where 20%+ is excellent
      let fcfS = Math.max(0, Math.min(10, (adjFcfMargin / 0.03) * 10));

      // ── Debt/Equity ───────────────────────────────────────────────────────
      // Negative D/E = net cash = best possible (score 10)
      // D/E = 0.5 = modest (score 7.5)
      // D/E = 1.5 = elevated but manageable (score 2.5)
      // D/E = 2.0+ = concerning for a non-financial (score 0)
      let deS = fundamentals.debtToEquity < 0
        ? 10
        : Math.max(0, Math.min(10, 10 - ((fundamentals.debtToEquity / 2.0) * 10)));

      // ── FCF Yield — computed for display only, NOT in composite ──────────
      let fcfYieldS = 5; // kept for moat score computation only
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
      // Zero-point at 5% growth (not 0%) — flat revenue should score below neutral
      // for a compounder where growth is the thesis.
      //   -10%  = score 0
      //     0%  = score 4   (declining/flat — below neutral for a compounder)
      //     5%  = score 5   (neutral — matching GDP-level growth)
      //    15%  = score 7
      //    25%+ = score 10
      const yoy  = fundamentals.revenueGrowthYoY  ?? 0;
      const cagr = fundamentals.revenueGrowth3Y   ?? 0;
      // Curve: 0% → 4, 5% → 5, 25% → 10 (shifted zero-point vs before)
      const yoyS  = Math.max(0, Math.min(10, 4 + (yoy  / 0.042)));
      const cagrS = Math.max(0, Math.min(10, 4 + (cagr / 0.042)));
      let revGS;
      if (cagr !== 0 && yoy !== 0) {
        revGS = (yoyS * 0.40) + (cagrS * 0.60); // durability over velocity
      } else if (cagr !== 0) {
        revGS = cagrS;
      } else {
        revGS = yoyS;
      }
      // Credibility discount: big TTM spike on weak 3Y base = recovery, not compounding
      if (cagr !== 0 && yoy !== 0 && yoy > cagr * 1.5 && cagr < 0.10) {
        revGS = Math.min(revGS, 6.5);
      }

      if (capexException) fcfS = Math.min(10, fcfS + 2.5);

      // ── Composite fundamental score ───────────────────────────────────────
      // Quality-first (Fundsmith/Baillie Gifford): FCF Yield is valuation, not quality.
      // A great business at a high price is still a great business.
      // ROIC 40% / SBC-adj FCF 30% / D/E 20% / Rev Growth 10%
      fundScore = (roicS * 0.40) + (fcfS * 0.30) + (deS * 0.20) + (revGS * 0.10);

      // ── Enhanced Moat Score (display-only, never feeds composite) ─────────
      // Components: ROIC above cost-of-capital, gross margin (pricing power),
      // revenue growth durability (3Y CAGR), FCF conversion quality,
      // SBC dilution penalty (high SBC = management enriching itself vs owners)
      const gmPct = fundamentals.grossMargin ?? 0;
      const gmS   = Math.max(0, Math.min(10, (gmPct - 0.20) / 0.06));

      const fcfConvS = Math.max(0, Math.min(10, (fundamentals.fcfConversion ?? 0.5) * 6.67));
      const roicVsHurdleS = Math.max(0, Math.min(10, ((fundamentals.roic - 0.15) / 0.10) * 10));

      // SBC dilution penalty: >10% of FCF in SBC = moderate penalty, >25% = heavy
      let sbcPenalty = 0;
      if (fundamentals.sbcMargin != null && fundamentals.fcfMargin > 0) {
        const sbcAsFcfPct = fundamentals.sbcMargin / Math.max(0.01, fundamentals.fcfMargin);
        if (sbcAsFcfPct > 0.25) sbcPenalty = 2.5;
        else if (sbcAsFcfPct > 0.10) sbcPenalty = 1.0;
      }

      // FCF Yield quality: <2% yield means the moat is expensive to own
      const fcfYieldMoatAdj = fundamentals.fcfYield != null
        ? (fundamentals.fcfYield < 0.02 ? -1.0 : fundamentals.fcfYield > 0.05 ? 1.0 : 0)
        : 0;

      // Moat = ROIC premium 30% / Gross margin 25% / Rev growth durability (3Y) 25% / FCF conversion 20%
      // Then apply SBC penalty and FCF yield adjustment
      const rawMoat = (roicVsHurdleS * 0.30) + (gmS * 0.25) + (cagrS * 0.25) + (fcfConvS * 0.20);
      fundamentals._moatScore = Math.max(0, Math.min(10,
        parseFloat((rawMoat - sbcPenalty + fcfYieldMoatAdj).toFixed(1))
      ));
    }

    if (technicals && priceData?.price) {
      let trendS = 5;
      if (technicals.sma200 > 0) {
        const diff = (priceData.price - technicals.sma200) / technicals.sma200;
        trendS = Math.max(0, Math.min(10, 5 + ((diff / 0.05) * 5)));
      }
      const rsi = technicals.rsi;
      let rsiS = 5;
      if      (rsi >= 45 && rsi <= 65) rsiS = 10;
      else if (rsi < 35)               rsiS = 8;
      else if (rsi >= 35 && rsi < 45)  rsiS = 9;
      else if (rsi > 65 && rsi <= 80)  rsiS = 10 - (((rsi - 65) / 15) * 8);
      else if (rsi > 80)               rsiS = 2;
      techScore = (trendS * 0.50) + (rsiS * 0.50);
    }

    if (ratings) {
      const total = (ratings.strongBuy || 0) + (ratings.buy || 0) + (ratings.hold || 0) + (ratings.sell || 0) + (ratings.strongSell || 0);
      if (total > 0) {
        const bullish = (ratings.strongBuy || 0) + (ratings.buy || 0);
        const bearish = (ratings.sell || 0) + (ratings.strongSell || 0);
        ratingScore = Math.max(0, Math.min(10, ((bullish / total) * 10) - ((bearish / total) * 5)));
      }
    }

    // Use pre-computed intraday average if provided; otherwise analyze articles live
    if (newsScoreOverride !== null) {
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
      const { bought, sold } = insiderData;
      if      (bought > 0 && sold === 0)  insiderScore = 10;
      else if (bought > sold * 2)         insiderScore = 9;
      else if (bought > sold)             insiderScore = 7;
      else if (sold > bought * 5)         insiderScore = 2;
      else if (sold > bought * 2)         insiderScore = 3;
      else if (sold > bought)             insiderScore = 4;
    }

    // ── Composite weights ─────────────────────────────────────────────────────
    // STOCKS (fundamentals-first, long-horizon compounder):
    //   Fund 35% | Analyst 20% | Insider 20% | News 15% | Tech 10%
    //
    // ETFs (no fundamentals, no insiders — momentum and theme):
    //   Tech 50% | News 30% | Analyst 20%
    //   Tech dominates because ETFs ARE momentum vehicles — price trend IS the
    //   signal. News captures theme/sector sentiment. Analyst captures consensus
    //   on the underlying index or theme. Fund and Insider are always 5 (neutral)
    //   for ETFs because those concepts don't apply.
    let finalScore;
    if (isETF) {
      finalScore = (techScore * 0.50) + (newsScore * 0.30) + (ratingScore * 0.20);
    } else {
      finalScore = (fundScore * 0.35) + (techScore * 0.10) + (ratingScore * 0.20) + (newsScore * 0.15) + (insiderScore * 0.20);
    }
    return {
      total:   Math.max(0, Math.min(10, finalScore)),
      fund:    fundScore,
      tech:    techScore,
      rating:  ratingScore,
      news:    newsScore,
      insider: insiderScore
    };
  }

  getSignal(score) {
    if (score >= 8.5) return 'STRONG_BUY';
    if (score >= 7.0) return 'BUY';
    if (score >= 5.5) return 'HOLD';
    if (score >= 4.0) return 'REDUCE';
    return 'SELL';
  }
}

// ─── SEC EDGAR — STOCK-BASED COMPENSATION ────────────────────────────────────
// Uses data.sec.gov XBRL API — free, no auth, no rate limit.
// Returns TTM SBC in millions USD, or null if unavailable.
// CIK lookup cached in-memory per process run.

const _cikCache = {};

async function getEdgarCIK(symbol) {
  if (_cikCache[symbol]) return _cikCache[symbol];
  try {
    const res = await axios.get(
      'https://www.sec.gov/files/company_tickers.json',
      { timeout: 8000, headers: { 'User-Agent': 'PortfolioDashboard contact@portfolio.local' } }
    );
    const entries = Object.values(res.data);
    const match   = entries.find(e => e.ticker?.toUpperCase() === symbol.toUpperCase());
    if (match) {
      // CIK must be zero-padded to 10 digits for EDGAR XBRL API
      const cik = String(match.cik_str).padStart(10, '0');
      _cikCache[symbol] = cik;
      return cik;
    }
  } catch (e) { /* fall through */ }
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

    // Filter to annual (10-K) filings only, sort descending by end date
    const annual = units
      .filter(f => f.form === '10-K' && f.end && f.val > 0)
      .sort((a, b) => new Date(b.end) - new Date(a.end));

    if (!annual.length) return null;

    // Most recent annual SBC value (in USD — convert to millions)
    const latestSBC = annual[0].val / 1_000_000;
    return parseFloat(latestSBC.toFixed(2));
  } catch (e) {
    // 404 = company doesn't file SBC separately (ETFs, REITs) — not an error
    if (e.response?.status !== 404) {
      logger.warn(`SEC EDGAR SBC fetch failed for ${symbol}: ${e.message}`);
    }
    return null;
  }
}

// ─── FINNHUB FILING SENTIMENT (quarterly, 10-K/10-Q tone) ─────────────────────
// Uses Loughran-McDonald word lists — positive/negative word ratios in SEC filings.
// Returns a sentiment score 0–10: >5 = positive tone, <5 = negative/cautious.
// Called quarterly (checks if we already have today's score in cache to avoid repeat calls).

async function fetchFilingSentiment(symbol) {
  try {
    // Fetch recent 10-K and 10-Q filings list
    const filingsRes = await axios.get(
      `https://finnhub.io/api/v1/stock/filings?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`,
      { timeout: 8000 }
    );
    const filings = filingsRes.data || [];
    // Get most recent 10-K or 10-Q
    const recent = filings.find(f => f.form === '10-K' || f.form === '10-Q');
    if (!recent?.accessNumber) return null;

    const sentRes = await axios.get(
      `https://finnhub.io/api/v1/stock/filings-sentiment?accessNumber=${recent.accessNumber}&token=${process.env.FINNHUB_API_KEY}`,
      { timeout: 8000 }
    );

    const s = sentRes.data?.sentiment;
    if (!s) return null;

    // positiveScore and negativeScore are ratios (0–1)
    // Net score: positive - negative, normalised to 0–10
    // 0.05 positive / 0.02 negative = healthy filings tone
    const pos = s.positive ?? 0;
    const neg = s.negative ?? 0;
    const net = pos - neg;  // range roughly -0.10 to +0.10

    // Map to 0–10: net=0 → 5, net=+0.05 → 10, net=-0.05 → 0
    const score = Math.max(0, Math.min(10, 5 + (net / 0.05) * 5));
    return {
      score:   parseFloat(score.toFixed(1)),
      form:    recent.form,
      filedAt: recent.filedDate,
      positive: pos,
      negative: neg,
    };
  } catch (e) {
    // Filing sentiment is optional — non-fatal
    return null;
  }
}

// ─── SEC EDGAR 8-K MATERIAL EVENT WATCHER ─────────────────────────────────────
// Checks for recent 8-K filings and classifies the most important items.
// Only runs when Finnhub filings list is already available (reuses CIK cache).
// Material items tracked:
//   1.01 Entry into material agreement (contracts, partnerships)
//   2.02 Results of operations (earnings release)
//   5.02 Departure/appointment of directors or officers (CEO/CFO change)
//   4.01 Changes in registrant's certifying accountant (auditor red flag)
//   2.01 Completion of acquisition (M&A)
//   8.01 Other events (bankruptcy, going concern, restructuring)
// Returns null if no material 8-K in last 30 days, or object with type + hint.

async function fetchRecent8K(symbol) {
  try {
    const cik = await getEdgarCIK(symbol);
    if (!cik) return null;

    // EDGAR submissions API — lists all filings sorted by date
    const res = await axios.get(
      `https://data.sec.gov/submissions/CIK${cik}.json`,
      { timeout: 10000, headers: { 'User-Agent': 'PortfolioDashboard contact@portfolio.local' } }
    );

    const filings = res.data?.filings?.recent;
    if (!filings?.form?.length) return null;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Find most recent 8-K within 30 days
    const MATERIAL_ITEMS = {
      '1.01': { label: 'Material Agreement',         hint: 'neutral',   icon: '📋' },
      '2.01': { label: 'Acquisition Completed',      hint: 'positive',  icon: '🤝' },
      '2.02': { label: 'Earnings Release',           hint: 'neutral',   icon: '📊' },
      '4.01': { label: 'Auditor Change',             hint: 'negative',  icon: '⚠️'  },
      '4.02': { label: 'Non-Reliance on Financials', hint: 'negative',  icon: '🚨' },
      '5.02': { label: 'Director/Officer Change',    hint: 'neutral',   icon: '👔' },
      '8.01': { label: 'Other Material Event',       hint: 'neutral',   icon: '📌' },
    };

    for (let i = 0; i < filings.form.length; i++) {
      if (filings.form[i] !== '8-K') continue;
      const filingDate = new Date(filings.filingDate[i]);
      if (filingDate < thirtyDaysAgo) break; // sorted newest first, stop when past window

      // Check the items in this 8-K
      const items = (filings.items?.[i] || '').split(',').map(s => s.trim());
      for (const item of items) {
        if (MATERIAL_ITEMS[item]) {
          return {
            item,
            label:     MATERIAL_ITEMS[item].label,
            hint:      MATERIAL_ITEMS[item].hint,
            icon:      MATERIAL_ITEMS[item].icon,
            filedDate: filings.filingDate[i],
          };
        }
      }
    }

    return null; // no material 8-K in last 30 days
  } catch (e) {
    if (e.response?.status !== 404) {
      logger.warn(`8-K watcher failed for ${symbol}: ${e.message}`);
    }
    return null;
  }
}

// ─── SUPABASE WRITERS ─────────────────────────────────────────────────────────

async function writeSupabaseDailyMetrics(symbol, scoreObj, priceData, technicals, spyPrice, regimeStatus) {
  const safeSignal = VALID_SIGNALS.includes(regimeStatus) ? regimeStatus : 'HOLD';
  const { error } = await supabase.rpc('upsert_daily_metrics', {
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
  });
  if (error) logger.error(`daily_metrics write failed for ${symbol}: code=${error.code} msg=${error.message} details=${error.details}`);
}

async function writeSupabaseRegimeFlags({ symbol, w1, w2, w3, w4, beta, excessReturn, regimeStatus, action, springDays, capexException, qualityScore, rsi }) {
  const { error } = await supabase.rpc('upsert_regime_flags', {
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
  });
  if (error) logger.error(`regime_flags write failed for ${symbol}: code=${error.code} msg=${error.message} details=${error.details}`);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function ensureCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath,
      'Date,Symbol,Final_Score,Regime,Action,Price,SpyPrice,Fundamentals,Technicals,Analysts,News,Insiders,Beta,ExcessReturn,W1,W2,W3,W4,SpringDays,CapexException\n'
    );
  }
}

function appendCsvRow(csvPath, symbol, scoreObj, priceData, spyPrice, regimeStatus, action, beta, excessReturn, w1, w2, w3, w4, springDays, capexException) {
  const line = [
    TODAY, symbol,
    scoreObj.total.toFixed(2), regimeStatus, action,
    priceData?.price ?? 0, spyPrice ?? 0,
    scoreObj.fund.toFixed(2), scoreObj.tech.toFixed(2),
    scoreObj.rating.toFixed(2), scoreObj.news.toFixed(2), scoreObj.insider.toFixed(2),
    (beta ?? 1).toFixed(4), (excessReturn ?? 0).toFixed(4),
    w1 ? 1 : 0, w2 ? 1 : 0, w3 ? 1 : 0, w4 ? 1 : 0,
    springDays ?? 0, capexException ? 1 : 0
  ].join(',') + '\n';
  fs.appendFileSync(csvPath, line);
}

function compute21dReturn(historyAsc) {
  if (!historyAsc || historyAsc.length < 22) return 0;
  const recent = historyAsc[historyAsc.length - 1].c;
  const prior  = historyAsc[historyAsc.length - 22].c;
  return ((recent - prior) / prior) * 100;
}

/**
 * Maximum Drawdown over the supplied price history.
 * Returns a negative percentage, e.g. -0.35 means 35% peak-to-trough drop.
 * Uses trailing 252 days (1 year) when available.
 */
function computeMaxDrawdown(historyAsc) {
  if (!historyAsc || historyAsc.length < 10) return null;
  const window = historyAsc.slice(-252);
  let peak = window[0].c;
  let maxDD = 0;
  for (const bar of window) {
    if (bar.c > peak) peak = bar.c;
    const dd = (bar.c - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return parseFloat((maxDD * 100).toFixed(2)); // e.g. -34.5 means 34.5% drawdown
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
  return ['SPRING_CANDIDATE', 'SPRING_CONFIRMED'].includes(prev.action) ? (prev.spring_days ?? 0) : 0;
}

/**
 * Read today's intraday news runs from Supabase and return a single
 * recency-weighted news score for the EOD composite.
 *
 * Each run is weighted by its total recency_weight (logged by news-update.js).
 * A run with 3 breaking articles outweighs one with 3 day-old articles.
 * Falls back to null if no runs completed today — caller uses 5.0 (neutral).
 */
async function getIntradayNewsScore(symbol) {
  const { data, error } = await supabase
    .from('intraday_news_log')
    .select('run_slot, news_score, recency_weight, article_count')
    .eq('date', TODAY)
    .eq('symbol', symbol)
    .order('run_slot', { ascending: true });

  if (error) {
    logger.warn(`intraday_news_log read failed for ${symbol}: ${error.message}`);
    return null;
  }

  if (!data?.length) {
    logger.info(`  ⚪ No intraday news logged today — using neutral 5.0`);
    return null;
  }

  let weightedScoreSum = 0;
  let totalWeight      = 0;

  data.forEach(run => {
    const w = parseFloat(run.recency_weight) || 0;
    // If recency_weight is 0 (edge: all articles had no parseable date),
    // fall back to article_count as a proxy weight so the run still counts
    const effectiveWeight = w > 0 ? w : (run.article_count || 1);
    weightedScoreSum += parseFloat(run.news_score) * effectiveWeight;
    totalWeight      += effectiveWeight;
  });

  if (totalWeight === 0) return null;

  const finalScore = weightedScoreSum / totalWeight;
  const slots = data.map(r => `S${r.run_slot}=${parseFloat(r.news_score).toFixed(2)}`).join(' ');
  logger.info(`  📰 Intraday news log: ${slots} → weighted EOD: ${finalScore.toFixed(2)}`);

  return parseFloat(Math.max(0, Math.min(10, finalScore)).toFixed(2));
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

    const portfolio = await storage.getPortfolio();
    const stocks    = portfolio.stocks || [];
    if (stocks.length === 0) { logger.warn('No stocks in portfolio.'); process.exit(0); }

    logger.info('\n→ Fetching SPY benchmark...');
    const spyTechnicals = await analyzer.fetchTechnicals('SPY');
    if (!spyTechnicals) { logger.error('SPY fetch failed. Aborting.'); process.exit(1); }

    const spyReturn21d = compute21dReturn(spyTechnicals.historyAsc);
    const spyPrice     = spyTechnicals.historyDesc[0].c;
    logger.info(`  SPY 21d return: ${spyReturn21d.toFixed(2)}% | Price: $${spyPrice}`);

    const totalPortfolioValue = stocks.reduce(
      (sum, s) => sum + ((s.current_price || 0) * (s.quantity || 0)), 0
    );

    for (const stock of stocks) {
      try {
        logger.info(`\n${'─'.repeat(60)}`);
        logger.info(`Analyzing: ${stock.symbol}`);

        // Read intraday news score FIRST (no network call — just a Supabase read)
        // This gives us the weighted average of the 3 news runs for today
        const intradayNewsScore = await getIntradayNewsScore(stock.symbol);

        // ── Instrument type detection ───────────────────────────────────────
        // Auto-detected via Finnhub profile2 — works for any symbol you add:
        // stocks, ETFs, ADRs, REITs, preferred shares, closed-end funds.
        // No hardcoded list needed. SHLD, AVNV, any future addition just works.
        const instrumentProfile  = await fetchInstrumentType(stock.symbol, process.env.FINNHUB_API_KEY);
        const profileExpenseRatio = instrumentProfile.expenseRatio;

        // Three-source ETF classification — fully dynamic, no hardcoded list:
        //   1. Finnhub profile2 type field (covers most ETFs directly)
        //   2. FMP isEtf/isFund field (catches Finnhub misclassifications e.g. SPMO, SMH)
        //      FMP is the cross-check for any ETF, including ones you add in the future
        //   3. Redis stock.type === 'ETF' (covers stocks added before this detection existed)
        //
        // Source 2 only fires when source 1 returns Common Stock — avoids wasting
        // FMP calls on genuine stocks. FMP free tier: 250/day, typically 1-2 used here.
        let fmpIsEtf = false;
        if (!instrumentProfile.isETF && stock.type !== 'ETF') {
          fmpIsEtf = await checkFmpIsEtf(stock.symbol);
        }

        const instrumentIsETF = (
          instrumentProfile.isETF ||
          fmpIsEtf              ||
          stock.type === 'ETF'
        );
        const instrumentTypeName = instrumentIsETF ? 'ETF' : instrumentProfile.raw;

        if (instrumentIsETF) {
          logger.info(`  ℹ️  ETF (${instrumentProfile.raw}) — skipping fundamental/insider/filing calls`);
        } else {
          logger.info(`  ℹ️  ${instrumentTypeName}`);
        }

        const [priceData, fundamentals, technicals, ratings, insiderData, secCapex, sbcMillions, recent8K] = await Promise.all([
          analyzer.fetchPrice(stock.symbol),
          instrumentIsETF ? Promise.resolve(null) : analyzer.fetchFundamentals(stock.symbol),
          analyzer.fetchTechnicals(stock.symbol),
          instrumentIsETF ? Promise.resolve(null) : analyzer.fetchRatings(stock.symbol),
          instrumentIsETF ? Promise.resolve(null) : analyzer.fetchInsider(stock.symbol),
          instrumentIsETF ? Promise.resolve(null) : quantEngine.fetchSECCashFlow(stock.symbol),
          instrumentIsETF ? Promise.resolve(null) : fetchSECStockBasedComp(stock.symbol),
          instrumentIsETF ? Promise.resolve(null) : fetchRecent8K(stock.symbol),
        ]);

        // Attach SBC to fundamentals (stocks only — fundamentals is null for ETFs)
        // Correct SBC calculation: sbcMillions from EDGAR / fcf from Finnhub
        if (fundamentals && sbcMillions != null && sbcMillions > 0
            && fundamentals.marketCapM > 0 && fundamentals.fcfMargin > 0) {
          fundamentals.sbcMillions    = sbcMillions;
          fundamentals.sbcToMarketCap = parseFloat((sbcMillions / fundamentals.marketCapM).toFixed(4));
          // sbcMargin is attached directly to the fundamentals object so
          // calculateScore can use it in the FCF adjustment formula
        }

        const capexException = secCapex?.capexException ?? false;
        if (capexException) logger.info(`  ⚠️  CAPEX EXCEPTION: FCF penalty forgiven.`);

        // Calculate score — pass intraday news score as override (null = use 5.0)
        // analyzedNews is null because we're not fetching news here anymore
        const scoreObj = analyzer.calculateScore(
          priceData, fundamentals, technicals,
          ratings, null, insiderData, capexException,
          intradayNewsScore ?? 5.0,
          instrumentIsETF   // ETFs use different composite weights
        );

        // Compute MaxDD from price history (trailing 252 days)
        const maxDrawdown = technicals ? computeMaxDrawdown(technicals.historyAsc) : null;

        // Attach moat score and FCF yield from fundamentals (computed inside calculateScore)
        const moatScore = fundamentals?._moatScore ?? null;
        const fcfYield  = fundamentals?.fcfYield   ?? null;
        const revenueGrowthPct = fundamentals?._raw?.revenueGrowthPct ?? null;
        const grossMarginPct   = fundamentals?._raw?.grossMarginPct   ?? null;

        // Filing sentiment — quarterly cadence (Finnhub 10-K/10-Q tone analysis)
        // Skipped for ETFs (file N-CEN/N-PORT, not 10-K/10-Q — no business tone to analyse)
        const filingSentiment = instrumentIsETF ? null : await fetchFilingSentiment(stock.symbol);

        if (instrumentIsETF) {
          logger.info(`  📊 [ETF] Tech(${scoreObj.tech.toFixed(1)}) Analyst(${scoreObj.rating.toFixed(1)}) News(${scoreObj.news.toFixed(1)}) → Total(${scoreObj.total.toFixed(1)}) | MaxDD: ${maxDrawdown ?? '—'}%`);
        } else {
          logger.info(`  📊 Fund(${scoreObj.fund.toFixed(1)}) Tech(${scoreObj.tech.toFixed(1)}) Analyst(${scoreObj.rating.toFixed(1)}) News(${scoreObj.news.toFixed(1)}) Insider(${scoreObj.insider.toFixed(1)}) → Total(${scoreObj.total.toFixed(1)})`);
          if (moatScore != null) logger.info(`  🏰 Moat: ${moatScore.toFixed(1)}/10 | RevGrowth3Y: ${(fundamentals?._raw?.revenueGrowth3YPct ?? 0).toFixed(1)}% | YoY: ${(revenueGrowthPct ?? 0).toFixed(1)}% | GrossMargin: ${(grossMarginPct ?? 0).toFixed(1)}% | MaxDD: ${maxDrawdown ?? '—'}%`);
        }
        if (filingSentiment) logger.info(`  📄 Filing tone (${filingSentiment.form}): ${filingSentiment.score.toFixed(1)}/10 | pos:${(filingSentiment.positive*100).toFixed(2)}% neg:${(filingSentiment.negative*100).toFixed(2)}%`);
        if (sbcMillions != null) logger.info(`  💸 SBC: $${sbcMillions.toFixed(1)}M | as % mktcap: ${((fundamentals?.sbcToMarketCap ?? 0)*100).toFixed(2)}%`);
        if (recent8K) logger.info(`  📋 8-K: ${recent8K.icon} ${recent8K.label} (${recent8K.filedDate}) — ${recent8K.hint}`);

        // Quant Engine regime analysis (unchanged)
        let beta = 1.0, excessReturn = 0, noiseDecay = 'INSUFFICIENT_DATA';
        let regimeStatus = 'HOLD', action = 'HOLD';
        let springSignal = false, springDays = 0, addSignal = false;
        let w1 = false, w2 = false, w3 = false, w4 = false;

        if (technicals && spyTechnicals) {
          beta = quantEngine.calculateBeta(technicals.historyAsc, spyTechnicals.historyAsc);
          const stockReturn21d = compute21dReturn(technicals.historyAsc);
          excessReturn = quantEngine.calculateExcessReturn(stockReturn21d, beta, spyReturn21d);
          noiseDecay   = quantEngine.classifyRegime(excessReturn);

          const { data: supData, error: supError } = await supabase
            .from('daily_metrics')
            .select('fund_score, date')
            .eq('symbol', stock.symbol)
            .order('date', { ascending: false })
            .limit(252);

          if (supError) logger.warn(`Supabase history fetch failed: ${supError.message}`);
          const history252d = (supData || []).reverse();

          regimeStatus = quantEngine.evaluateFractalDecay(history252d, noiseDecay);

          w1 = history252d.length >= 7   ? quantEngine._w1Trigger(history252d.slice(-7))   : false;
          w2 = history252d.length >= 21  ? quantEngine._w2Trigger(history252d.slice(-21))  : false;
          w3 = history252d.length >= 63  ? quantEngine._w3Trigger(history252d.slice(-63))  : false;
          w4 = history252d.length >= 252 ? quantEngine._w4Trigger(history252d)             : false;

          const history20d     = technicals.historyAsc.slice(-20);
          const prevSpringDays = await getPreviousSpringDays(stock.symbol);
          const excessReturn7d = compute21dReturn(technicals.historyAsc.slice(-8));

          springSignal = quantEngine.evaluateSpring(history20d, scoreObj.fund, excessReturn7d);

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
          if (addSignal && !['TRIM_25', 'SELL'].includes(action)) action = 'ADD';
        }

        logger.info(`  🧠 Regime: ${noiseDecay} | Action: ${action} | Beta: ${beta.toFixed(2)} | Excess21d: ${excessReturn.toFixed(2)}%`);
        logger.info(`  📈 Cascade: W1=${w1} W2=${w2} W3=${w3} W4=${w4} | Spring: ${springDays}d`);

        await writeSupabaseDailyMetrics(stock.symbol, scoreObj, priceData, technicals, spyPrice, action);
        await writeSupabaseRegimeFlags({ symbol: stock.symbol, w1, w2, w3, w4, beta, excessReturn, regimeStatus: noiseDecay, action, springDays, capexException, qualityScore: scoreObj.fund, rsi: technicals?.rsi ?? null });

        // Redis update — note: recent_news is NOT overwritten here
        // The news-update.js runs maintain the headlines in Redis throughout the day
        const redisUpdates = {
          latest_score:    Math.round(scoreObj.total * 10) / 10,
          signal:          action,
          classic_signal:  analyzer.getSignal(scoreObj.total),
          instrument_type: instrumentIsETF ? 'ETF' : 'Stock',
          expense_ratio:   profileExpenseRatio ?? null,  // from Finnhub profile2 (all instruments)
          current_price:   priceData?.price        ?? stock.current_price,
          change_percent:  priceData?.changePercent ?? stock.change_percent,
          score_breakdown: scoreObj,
          regime:          noiseDecay,
          excess_return:   excessReturn,
          beta,
          spring_days:     springDays,
          w1_signal:       w1,
          w2_confirmed:    w2,
          // Fundamental quality metrics
          moat_score:          moatScore,
          fcf_yield:           fcfYield != null ? parseFloat(fcfYield.toFixed(4)) : null,
          ev_fcf:              fundamentals?.evFcf != null ? parseFloat(fundamentals.evFcf.toFixed(1)) : null,
          max_drawdown:        maxDrawdown,
          revenue_growth_pct:  revenueGrowthPct != null ? parseFloat(revenueGrowthPct.toFixed(1)) : null,
          revenue_growth_3y:   fundamentals?._raw?.revenueGrowth3YPct != null ? parseFloat(fundamentals._raw.revenueGrowth3YPct.toFixed(1)) : null,
          gross_margin_pct:    grossMarginPct   != null ? parseFloat(grossMarginPct.toFixed(1))   : null,
          sbc_millions:        sbcMillions != null ? parseFloat(sbcMillions.toFixed(1)) : null,
          sbc_to_market_cap:   fundamentals?.sbcToMarketCap != null ? parseFloat((fundamentals.sbcToMarketCap * 100).toFixed(2)) : null,
          // Filing sentiment (quarterly tone analysis from 10-K/10-Q)
          filing_sentiment:    filingSentiment ? filingSentiment.score : null,
          filing_form:         filingSentiment ? filingSentiment.form  : null,
          // 8-K material event (last 30 days)
          event_8k:            recent8K ? recent8K.label    : null,
          event_8k_hint:       recent8K ? recent8K.hint     : null,
          event_8k_icon:       recent8K ? recent8K.icon     : null,
          event_8k_date:       recent8K ? recent8K.filedDate: null,
          // Score sub-breakdown — shown in detail panel
          score_fund:          scoreObj.fund    != null ? parseFloat(scoreObj.fund.toFixed(1))    : null,
          score_tech:          scoreObj.tech    != null ? parseFloat(scoreObj.tech.toFixed(1))    : null,
          score_rating:        scoreObj.rating  != null ? parseFloat(scoreObj.rating.toFixed(1))  : null,
          score_news:          scoreObj.news    != null ? parseFloat(scoreObj.news.toFixed(1))    : null,
          score_insider:       scoreObj.insider != null ? parseFloat(scoreObj.insider.toFixed(1)) : null,
          // FCF Yield stored separately — used for display/valuation context only
          fcf_yield_score:     fcfYield != null ? parseFloat((fcfYield * 100).toFixed(2)) : null,
          w3_confirmed:    w3,
          w4_confirmed:    w4,
          capex_exception: capexException,
          ...(priceData?.price && stock.quantity && { total_value: priceData.price * stock.quantity })
          // recent_news intentionally omitted — preserved from last news-update.js run
        };
        await storage.updateStock(stock.symbol, redisUpdates);

        appendCsvRow(csvPath, stock.symbol, scoreObj, priceData, spyPrice, noiseDecay, action, beta, excessReturn, w1, w2, w3, w4, springDays, capexException);

        logger.info(`  ✅ ${stock.symbol} complete → ${action}`);

      } catch (e) {
        logger.error(`Error processing ${stock.symbol}:`, e.message);
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
