'use strict';
const axios = require('axios');
const logger = require('./logger');

/**
 * QUANT ENGINE — Regime Analysis & Signal Cascade
 *
 * Array convention throughout: index 0 = OLDEST, index N-1 = MOST RECENT (today).
 * All history arrays must follow this convention before being passed in.
 *
 * Enhancements over original:
 *   - calculateBeta: uses most recent 63 days, not first 63 days
 *   - evaluateSpring: quality threshold lowered from 8.0 to 7.5 (fewer false negatives)
 *   - evaluateAdd: data-poverty guard — gracefully degrades when < 63 days available
 *   - evaluateFractalDecay: IDIOSYNCRATIC_DECAY now correctly escalates to TRIM_25/SELL
 *   - fetchSECCashFlow: returns richer data including YoY metrics
 *   - new: computeVolatility — annualised 21-day realised volatility for risk context
 *   - new: evaluateMomentum — price momentum relative to 50d and 200d MAs
 */
class QuantEngine {

  // ─── 1. ROLLING BETA (63-day) ──────────────────────────────────────────────
  // stockHistory / spyHistory: arrays of { c: closePrice } sorted OLDEST→NEWEST
  // Uses the MOST RECENT 63 days of whatever history is passed in.
  calculateBeta(stockHistory, spyHistory) {
    if (!stockHistory || !spyHistory) return 1.0;

    // Need at least 64 data points to compute 63 returns
    const minLen = Math.min(stockHistory.length, spyHistory.length);
    if (minLen < 10) return 1.0; // Not enough data — default to market beta

    // Use the most recent available window, up to 63 days
    const window = Math.min(63, minLen - 1);
    const sSlice = stockHistory.slice(-window - 1);
    const mSlice = spyHistory.slice(-window - 1);

    const stockReturns = [];
    const spyReturns   = [];

    for (let i = 0; i < window; i++) {
      stockReturns.push((sSlice[i+1].c - sSlice[i].c) / sSlice[i].c);
      spyReturns.push(  (mSlice[i+1].c - mSlice[i].c) / mSlice[i].c);
    }

    const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const meanSpy   = mean(spyReturns);
    const meanStock = mean(stockReturns);

    let covariance = 0, varianceSpy = 0;
    for (let i = 0; i < window; i++) {
      covariance  += (stockReturns[i] - meanStock) * (spyReturns[i] - meanSpy);
      varianceSpy += (spyReturns[i] - meanSpy) ** 2;
    }

    if (varianceSpy === 0) return 1.0;
    const beta = covariance / varianceSpy;

    // Clamp to reasonable range — extreme beta values indicate data issues
    return Math.max(0.1, Math.min(4.0, beta));
  }

  // ─── 2. EXCESS RETURN & REGIME CLASSIFICATION ──────────────────────────────
  calculateExcessReturn(actualReturnPct, beta, spyReturnPct) {
    return actualReturnPct - (beta * spyReturnPct);
  }

  classifyRegime(excessReturnPct) {
    if (excessReturnPct > -3)  return 'MARKET_NOISE';
    if (excessReturnPct > -8)  return 'WATCH';
    return 'IDIOSYNCRATIC_DECAY';
  }

  // ─── 3. FRACTAL DECAY CASCADE (W1 → W4) ───────────────────────────────────
  // history arrays: [{ fund_score: number }] sorted OLDEST→NEWEST

  // W1: Score is DECLINING within a 7-day window (delta, not absolute)
  _w1Trigger(arr7) {
    if (!arr7 || arr7.length < 7) return false;
    const recent = (arr7[4].fund_score + arr7[5].fund_score + arr7[6].fund_score) / 3;
    const older  = (arr7[0].fund_score + arr7[1].fund_score + arr7[2].fund_score) / 3;
    return (recent - older) < -0.5; // declining 0.5+ points = bearish
  }

  // W2: ≥ 2 of 3 seven-day blocks within 21 days triggered W1
  _w2Trigger(arr21) {
    if (!arr21 || arr21.length < 21) return false;
    const b1 = this._w1Trigger(arr21.slice(0,  7));
    const b2 = this._w1Trigger(arr21.slice(7,  14));
    const b3 = this._w1Trigger(arr21.slice(14, 21));
    return [b1, b2, b3].filter(Boolean).length >= 2;
  }

  // W3: ≥ 2 of 3 twenty-one-day blocks within 63 days triggered W2
  _w3Trigger(arr63) {
    if (!arr63 || arr63.length < 63) return false;
    const b1 = this._w2Trigger(arr63.slice(0,  21));
    const b2 = this._w2Trigger(arr63.slice(21, 42));
    const b3 = this._w2Trigger(arr63.slice(42, 63));
    return [b1, b2, b3].filter(Boolean).length >= 2;
  }

  // W4: ≥ 3 of 4 sixty-three-day blocks within 252 days triggered W3
  _w4Trigger(arr252) {
    if (!arr252 || arr252.length < 252) return false;
    const b1 = this._w3Trigger(arr252.slice(0,   63));
    const b2 = this._w3Trigger(arr252.slice(63,  126));
    const b3 = this._w3Trigger(arr252.slice(126, 189));
    const b4 = this._w3Trigger(arr252.slice(189, 252));
    return [b1, b2, b3, b4].filter(Boolean).length >= 3;
  }

  evaluateFractalDecay(history252d, regime) {
    // Market noise overrides cascade — hold regardless of window signals
    if (regime === 'MARKET_NOISE') return 'HOLD_NOISE';

    // Need sufficient history for cascade signals
    if (!history252d || history252d.length < 7) return 'INSUFFICIENT_DATA';

    const len = history252d.length;

    // Compute only the windows we have enough data for
    const w1 = len >= 7   ? this._w1Trigger(history252d.slice(-7))   : false;
    const w2 = len >= 21  ? this._w2Trigger(history252d.slice(-21))  : false;
    const w3 = len >= 63  ? this._w3Trigger(history252d.slice(-63))  : false;
    const w4 = len >= 252 ? this._w4Trigger(history252d)             : false;

    // Escalation ladder — only trigger if regime also confirms deterioration
    if (w4 && regime === 'IDIOSYNCRATIC_DECAY') return 'SELL';
    if (w3 && regime === 'IDIOSYNCRATIC_DECAY') return 'TRIM_25';
    if (w3 && regime === 'WATCH')               return 'WATCH';
    if (w2 && regime === 'IDIOSYNCRATIC_DECAY') return 'WATCH';
    if (w1 && regime === 'IDIOSYNCRATIC_DECAY') return 'WATCH';

    // Regime shows decay but cascade hasn't confirmed — stay cautious
    if (regime === 'IDIOSYNCRATIC_DECAY') return 'WATCH';

    return 'HOLD';
  }

  // ─── 4. SEC EDGAR — CAPEX EXCEPTION ───────────────────────────────────────
  async fetchSECCashFlow(symbol) {
    try {
      const mapRes = await axios.get('https://www.sec.gov/files/company_tickers.json', {
        headers: { 'User-Agent': 'AlphaDashboard/1.0 (portfolio@example.com)' },
        timeout: 8000,
      });

      const company = Object.values(mapRes.data).find(c => c.ticker === symbol);
      if (!company) return null;

      const cikStr   = company.cik_str.toString().padStart(10, '0');
      const factsRes = await axios.get(
        `https://data.sec.gov/api/xbrl/companyfacts/CIK${cikStr}.json`,
        {
          headers: { 'User-Agent': 'AlphaDashboard/1.0 (portfolio@example.com)' },
          timeout: 12000,
        }
      );

      const gaap = factsRes.data.facts?.['us-gaap'];
      if (!gaap) return null;

      // Filter to true quarterly filings only — exclude YTD cumulative and annual
      const quarterlyOnly = arr =>
        (arr || [])
          .filter(e => e.form === '10-Q' && e.fp && e.fp.startsWith('Q'))
          .sort((a, b) => new Date(b.end) - new Date(a.end));

      const ocfQ   = quarterlyOnly(gaap.NetCashProvidedByUsedInOperatingActivities?.units?.USD);
      const capexQ = quarterlyOnly(gaap.PaymentsToAcquirePropertyPlantAndEquipment?.units?.USD);

      if (!ocfQ.length || !capexQ.length) return null;

      const latestOcf   = ocfQ[0].val;
      const latestCapex = Math.abs(capexQ[0].val);
      // Same quarter, prior year (index 4 = 4 quarters back)
      const priorOcf    = ocfQ[4]?.val   ?? null;
      const priorCapex  = capexQ[4] ? Math.abs(capexQ[4].val) : null;

      const capexGrowthYoY = (priorCapex && priorCapex > 0)
        ? (latestCapex - priorCapex) / priorCapex
        : null;

      // Capex Exception: heavy investment + healthy operating cash
      // ≥20% YoY capex surge + positive OCF = strategic reinvestment, not distress
      const capexException = (capexGrowthYoY !== null && capexGrowthYoY > 0.20 && latestOcf > 0);

      return {
        ocf:            latestOcf,
        capex:          latestCapex,
        fcf:            latestOcf - latestCapex,
        capexException,
        capexGrowthYoY,
        quarterEnd:     ocfQ[0].end,
      };

    } catch (e) {
      logger.warn(`SEC Edgar fetch failed for ${symbol}: ${e.message}`);
      return null;
    }
  }

  // ─── 5. SPRING SIGNAL ─────────────────────────────────────────────────────
  // Requires 3 consecutive days: RSI < 40, price > 3-day-ago anchor, above-avg volume.
  // Quality threshold lowered from 8.0 to 7.5 — the original 8.0 was too restrictive,
  // filtering out excellent businesses with minor FCF or D/E imperfections.
  evaluateSpring(history20d, qualityScore, excessReturn7d) {
    if (!history20d || history20d.length < 20) return false;
    if (qualityScore <= 7.5)  return false;  // high quality required (was 8.0)
    if (excessReturn7d <= 0)  return false;  // must be outperforming market

    const avgVol20d = history20d.reduce((sum, d) => sum + (d.v || 0), 0) / 20;
    const anchor    = history20d[16]; // 3 trading days before today

    for (let i = 17; i <= 19; i++) {
      const day   = history20d[i];
      const rsiOk   = day.rsi < 40;
      const priceOk = day.c > anchor.c;
      const volOk   = avgVol20d > 0 ? day.v > avgVol20d : true; // skip vol check if no data
      if (!(rsiOk && priceOk && volOk)) return false;
    }

    return true;
  }

  // ─── 6. ADD SIGNAL ────────────────────────────────────────────────────────
  // Data-poverty guard: if < 63 days available, use whatever we have.
  // Prevents ADD from being permanently suppressed during early data accumulation.
  evaluateAdd(quality63d, excessReturnPct, currentRsi, currentWeight) {
    if (!quality63d || quality63d.length < 2) return false;

    // Use available window — at least need start and end points
    const qualityStart = quality63d[0].fund_score;
    const qualityNow   = quality63d[quality63d.length - 1].fund_score;
    const qualityImproving = qualityNow > qualityStart;

    // Core conditions — same as original
    const crushingBeta   = excessReturnPct > 5.0;
    const notOverbought  = currentRsi < 70;
    const underMaxWeight = currentWeight < 0.10;

    return qualityImproving && crushingBeta && notOverbought && underMaxWeight;
  }

  // ─── 7. REALISED VOLATILITY (new) ─────────────────────────────────────────
  // Annualised 21-day realised volatility (standard deviation of daily log returns).
  // Returns null if insufficient data.
  // Used for risk context — not a decision driver, displayed alongside beta.
  computeVolatility(historyAsc) {
    if (!historyAsc || historyAsc.length < 22) return null;
    const slice = historyAsc.slice(-22);
    const logReturns = [];
    for (let i = 1; i < slice.length; i++) {
      if (slice[i].c > 0 && slice[i-1].c > 0) {
        logReturns.push(Math.log(slice[i].c / slice[i-1].c));
      }
    }
    if (logReturns.length < 5) return null;
    const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
    const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / logReturns.length;
    const annualised = Math.sqrt(variance * 252) * 100; // as percentage
    return parseFloat(annualised.toFixed(1));
  }

  // ─── 8. MOMENTUM SIGNAL (new) ─────────────────────────────────────────────
  // Three-tier momentum check: price vs 50d MA, 50d vs 200d MA (golden/death cross),
  // and rate-of-change over 21 days.
  // Returns: 'STRONG' | 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'WEAK'
  // Informational only — use alongside regime signal, not as a standalone trigger.
  evaluateMomentum(historyAsc) {
    if (!historyAsc || historyAsc.length < 21) return 'NEUTRAL';

    const price = historyAsc[historyAsc.length - 1].c;

    // 50-day MA (use available if < 50 days)
    const period50 = Math.min(50, historyAsc.length);
    const ma50 = historyAsc.slice(-period50).reduce((s, d) => s + d.c, 0) / period50;

    // 200-day MA (only if enough data)
    let ma200 = null;
    if (historyAsc.length >= 200) {
      ma200 = historyAsc.slice(-200).reduce((s, d) => s + d.c, 0) / 200;
    }

    // 21-day rate of change
    const roc21 = historyAsc.length >= 22
      ? ((price - historyAsc[historyAsc.length - 22].c) / historyAsc[historyAsc.length - 22].c) * 100
      : 0;

    const aboveMa50  = price > ma50;
    const goldenCross = ma200 ? (ma50 > ma200) : null; // null = unknown

    // Classification
    if (aboveMa50 && goldenCross === true  && roc21 > 5)   return 'STRONG';
    if (aboveMa50 && goldenCross !== false && roc21 > 0)   return 'POSITIVE';
    if (!aboveMa50 && goldenCross === false && roc21 < -5) return 'WEAK';
    if (!aboveMa50 && roc21 < 0)                           return 'NEGATIVE';
    return 'NEUTRAL';
  }
}

module.exports = new QuantEngine();
