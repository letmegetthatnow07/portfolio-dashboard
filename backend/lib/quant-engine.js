'use strict';
const axios = require('axios');
const logger = require('./logger');

/**
 * QUANT ENGINE — Regime Analysis & Signal Cascade
 *
 * Array convention throughout: index 0 = OLDEST, index N-1 = MOST RECENT (today).
 * All history arrays must follow this convention before being passed in.
 */
class QuantEngine {

  // ─── 1. ROLLING BETA (63-day) ──────────────────────────────────────────────
  // stockHistory / spyHistory: arrays of { c: closePrice } sorted OLDEST→NEWEST
  calculateBeta(stockHistory, spyHistory) {
    if (!stockHistory || !spyHistory
        || stockHistory.length < 64
        || spyHistory.length < 64) return 1.0;

    const stockReturns = [];
    const spyReturns   = [];

    // i+1 is newer than i (oldest→newest convention)
    for (let i = 0; i < 63; i++) {
      stockReturns.push((stockHistory[i+1].c - stockHistory[i].c) / stockHistory[i].c);
      spyReturns.push((spyHistory[i+1].c   - spyHistory[i].c)   / spyHistory[i].c);
    }

    const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const meanSpy   = mean(spyReturns);
    const meanStock = mean(stockReturns);

    let covariance = 0, varianceSpy = 0;
    for (let i = 0; i < 63; i++) {
      covariance  += (stockReturns[i] - meanStock) * (spyReturns[i] - meanSpy);
      varianceSpy += Math.pow(spyReturns[i] - meanSpy, 2);
    }

    return varianceSpy === 0 ? 1.0 : covariance / varianceSpy;
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
    if (arr7.length < 7) return false;
    const recent = (arr7[4].fund_score + arr7[5].fund_score + arr7[6].fund_score) / 3;
    const older  = (arr7[0].fund_score + arr7[1].fund_score + arr7[2].fund_score) / 3;
    return (recent - older) < -0.5; // declining 0.5+ points = bearish
  }

  // W2: ≥ 2 of 3 seven-day blocks within 21 days triggered W1
  _w2Trigger(arr21) {
    if (arr21.length < 21) return false;
    const b1 = this._w1Trigger(arr21.slice(0,  7));
    const b2 = this._w1Trigger(arr21.slice(7,  14));
    const b3 = this._w1Trigger(arr21.slice(14, 21));
    return [b1, b2, b3].filter(Boolean).length >= 2;
  }

  // W3: ≥ 2 of 3 twenty-one-day blocks within 63 days triggered W2
  _w3Trigger(arr63) {
    if (arr63.length < 63) return false;
    const b1 = this._w2Trigger(arr63.slice(0,  21));
    const b2 = this._w2Trigger(arr63.slice(21, 42));
    const b3 = this._w2Trigger(arr63.slice(42, 63));
    return [b1, b2, b3].filter(Boolean).length >= 2;
  }

  // W4: ≥ 3 of 4 sixty-three-day blocks within 252 days triggered W3
  _w4Trigger(arr252) {
    if (arr252.length < 252) return false;
    const b1 = this._w3Trigger(arr252.slice(0,   63));
    const b2 = this._w3Trigger(arr252.slice(63,  126));
    const b3 = this._w3Trigger(arr252.slice(126, 189));
    const b4 = this._w3Trigger(arr252.slice(189, 252));
    return [b1, b2, b3, b4].filter(Boolean).length >= 3;
  }

  evaluateFractalDecay(history252d, regime) {
    // Market noise overrides cascade — hold regardless of window signals
    if (regime === 'MARKET_NOISE') return 'HOLD_NOISE';

    const w4 = this._w4Trigger(history252d);
    const w3 = w4 || this._w3Trigger(history252d.slice(-63));
    const w2 = w3 || this._w2Trigger(history252d.slice(-21));

    // Only escalate if regime confirms idiosyncratic decay
    if (w4 && regime === 'IDIOSYNCRATIC_DECAY') return 'SELL';
    if (w3 && regime !== 'MARKET_NOISE')        return 'TRIM_25';
    if (w2)                                      return 'WATCH';
    return 'HOLD';
  }

  // ─── 4. SEC EDGAR — CAPEX EXCEPTION ───────────────────────────────────────
  async fetchSECCashFlow(symbol) {
    try {
      const mapRes = await axios.get('https://www.sec.gov/files/company_tickers.json', {
        headers: { 'User-Agent': 'AlphaDashboard/1.0 (your-email@example.com)' }
      });

      const company = Object.values(mapRes.data).find(c => c.ticker === symbol);
      if (!company) return null;

      const cikStr  = company.cik_str.toString().padStart(10, '0');
      const factsRes = await axios.get(
        `https://data.sec.gov/api/xbrl/companyfacts/CIK${cikStr}.json`,
        { headers: { 'User-Agent': 'AlphaDashboard/1.0 (your-email@example.com)' } }
      );

      const gaap = factsRes.data.facts['us-gaap'];
      if (!gaap) return null;

      // Filter to TRUE quarterly filings only (not YTD cumulative, not annual)
      const quarterlyOnly = arr =>
        (arr || [])
          .filter(e => e.form === '10-Q' && e.fp && e.fp.startsWith('Q'))
          .sort((a, b) => new Date(b.end) - new Date(a.end));

      const ocfQ   = quarterlyOnly(gaap.NetCashProvidedByUsedInOperatingActivities?.units?.USD);
      const capexQ = quarterlyOnly(gaap.PaymentsToAcquirePropertyPlantAndEquipment?.units?.USD);

      if (!ocfQ.length || !capexQ.length) return null;

      const latestOcf    = ocfQ[0].val;
      const latestCapex  = Math.abs(capexQ[0].val);  // always positive
      const priorOcf     = ocfQ[4]?.val;              // same Q, prior year
      const priorCapex   = capexQ[4] ? Math.abs(capexQ[4].val) : null;

      // Capex Exception: heavy investment + healthy operating cash
      let capexException = false;
      if (priorCapex !== null && latestOcf > 0) {
        const capexGrowthYoY = (latestCapex - priorCapex) / priorCapex;
        if (capexGrowthYoY > 0.20) {
          capexException = true; // ≥20% YoY capex surge + positive OCF = strategic investment
        }
      }

      return {
        ocf:             latestOcf,
        capex:           latestCapex,
        fcf:             latestOcf - latestCapex,
        capexException,
        capexGrowthYoY:  priorCapex ? (latestCapex - priorCapex) / priorCapex : null
      };

    } catch (e) {
      logger.warn(`SEC Edgar fetch failed for ${symbol}: ${e.message}`);
      return null;
    }
  }

  // ─── 5. SPRING SIGNAL (3-day confirmed, data-over-opinion) ────────────────
  // history20d: [{ c, v, rsi }] sorted OLDEST→NEWEST. Index 19 = today.
  evaluateSpring(history20d, qualityScore, excessReturn7d) {
    if (!history20d || history20d.length < 20) return false;
    if (qualityScore <= 8.0)  return false;  // elite business required
    if (excessReturn7d <= 0)  return false;  // must be outperforming market over 7d

    const avgVol20d = history20d.reduce((sum, d) => sum + d.v, 0) / 20;
    const anchor    = history20d[16]; // 3 trading days before today (index 19-3=16)

    // All 3 of the last 3 days must independently confirm the signal
    for (let i = 17; i <= 19; i++) {
      const day = history20d[i];
      const rsiOk   = day.rsi < 40;
      const priceOk = day.c > anchor.c;   // above the 3-day-ago anchor
      const volOk   = day.v > avgVol20d;
      if (!(rsiOk && priceOk && volOk)) return false;
    }

    return true; // SPRING CONFIRMED
  }

  // ─── 6. ADD SIGNAL ────────────────────────────────────────────────────────
  // quality63d: [{ fund_score }] sorted OLDEST→NEWEST, 63 entries
  // currentWeight: (position_market_value / total_portfolio_value), computed fresh upstream
  evaluateAdd(quality63d, excessReturnPct, currentRsi, currentWeight) {
    if (!quality63d || quality63d.length < 63) return false;

    const qualityStart    = quality63d[0].fund_score;   // 63 days ago
    const qualityNow      = quality63d[62].fund_score;  // today
    const qualityImproving = qualityNow > qualityStart;

    const crushingBeta   = excessReturnPct > 5.0;  // outperforming by 5%+
    const notOverbought  = currentRsi < 70;
    const underMaxWeight = currentWeight < 0.10;

    return qualityImproving && crushingBeta && notOverbought && underMaxWeight;
  }
}

module.exports = new QuantEngine();
