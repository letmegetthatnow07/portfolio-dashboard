'use strict';
/**
 * MULTIBAGGER / ALPHA-COMPOUNDER SCREEN  (methodology lives here)
 *
 * Dependency-free (global fetch, Node 18+). Used by backend/scripts/multibagger-screen.js
 * (nightly runner, weekly per-stock cadence) and api/portfolio/{multibagger,watchlist}.js (on demand).
 * Individual operating companies only: ETFs/funds return NOT_APPLICABLE (same classification as the old engine).
 *
 * TWO LAYERS, ONE CONTRACT
 *   Layer 1 = the OLD quality engine (daily-update.js: score_fund, W3/W4 cascade, signal). Untouched.
 *             It owns "is this a quality compounder" and every trim/sell signal.
 *   Layer 2 = this screen. It owns "does the multibagger thesis hold". Portfolio stocks are re-checked weekly
 *             (or sooner when a new filing/earnings analysis lands, a critical 8-K appears, or the old engine turns bearish).
 *   businessVerdict (verdict/status)  = what the business is under the rules.
 *   portfolioAction (action)          = what to do, and it depends on OWNERSHIP (held / not held).
 *   Gate: ALPHA_COMPOUNDER / MULTIBAGGER need layer 1 to pass (score_fund >= 6.0 to enter, >= 5.0 to stay, no structural decay,
 *   no old-engine TRIM_25/SELL/REDUCE). Old-engine WATCH never blocks the verdict but blocks "add".
 *   Watchlist stocks are not in layer 1 yet: gate = UNVERIFIED -> at most a PROVISIONAL candidate, never MULTIBAGGER.
 *
 * QUESTION: buying today and holding 5 years, after Indian exit tax, does this stock plausibly
 * earn >= 22%/yr (alpha compounder) or >= 3x after tax (multibagger) on growth that is NOT already priced in?
 *
 * 1  FORWARD GROWTH  Built per valuation route, never blending revenue and EPS into one number.
 *                    EPS routes: EPS consensus 65% + EPS history 35%, capped at revenue growth + 8pts (15pts if net margin < 8%).
 *                    Blended revenue growth must be >= 8% (10% for MULTIBAGGER). EPS forecasts that cross zero are NOT_MEANINGFUL.
 *                    Loss-making companies (REVENUE route) are shown as an illustrative scenario only: UNPROVEN_PROFITABILITY.
 * 2  S-CURVE FADE    linear from g0 (year 1) to 6% (year 10).
 * 3  EXIT MULTIPLE   P/E = 15 + 1.2 x year-5 growth%, clamped 14-35x, never above current P/E x 1.25.
 *                    Trailing P/E > 1.5x forward P/E (depressed GAAP base) -> the forward P/E is used.
 * 4  5Y MULTIPLE     EPS multiple x exit P/E / current P/E. EPS_TTM: 5 growth steps. EPS_FWD: forward EPS already holds
 *                    year 1, so 4 further steps reach year-5 EPS (exit P/E is a trailing multiple at year 5).
 * 5  TAX             gain taxed at EXIT_TAX (12.5% LTCG + surcharge/cess, 15% conservative default).
 * 6  PRICED-IN       solve the g0 the CURRENT price needs for 22% after tax; ratio > 1 = already priced in.
 * 7  BEAR CASE       growth x0.7 and the exit multiple x0.75 (floored at 14x). MULTIBAGGER needs it to preserve capital after tax.
 * 8  RUNWAY          implied 5y market cap must stay under $5T. Unknown market cap = UNVERIFIED (blocks MULTIBAGGER).
 * 9  SECTOR GATE     price leg (ETF > 200DMA and ahead of SPY over 6M AND 12M, date-aligned, >= 253 sessions) AND
 *                    fundamentals leg (median growth of representative constituents, >= 3 valid readings).
 *                    A NEW pass needs BOTH legs (INTACT). BROKEN needs the deterioration to repeat on two weekly readings.
 *                    An existing holding keeps its pass through missing sector data.
 * 10 BALANCE SHEET   book debt/equity is judged with returns, interest cover, cash flow and maturities (buybacks distort it).
 *                    Missing evidence is UNVERIFIED, never strength.
 * 11 THESIS vs PRICE broken (shrinking, no growth, sector fundamentals broken, filing thesis weakening, dilution,
 *                    balance-sheet damage, critical 8-K) is sell-worthy FOR A HOLDING; priced-in / extended / sector price weak is noise.
 * SCOPE NOTES    REITs stay outside this screen on purpose (same classification as the old engine): they are valued on FFO/AFFO, which
 *                    this model does not have. The 14x bear-case floor is an EPS (P/E) rule only; the revenue route scales P/S directly.
 *                    Estimate rows come from FMP analyst-estimates: a completed year's row is final CONSENSUS, close to but not exactly the
 *                    reported actual, so growth over a single step is approximate (MULTIBAGGER needs 2+ steps).
 * 12 HYSTERESIS      relaxed exit thresholds apply only to an actual holding with a confirmed PASS; any flip needs
 *                    >= 2 runs spanning >= 5 days (critical 8-K excepted). Missing data keeps the last confirmed state, marked STALE.
 */

// CGT_RATE: a decimal in [0,1) such as 0.15, or a percentage string such as "15%". Anything else is a configuration error.
const envRate = (() => {
  const raw = process.env.CGT_RATE;
  if (raw == null || raw === '') return 0.15;
  const txt = String(raw).trim();
  const r = txt.endsWith('%') ? Number(txt.slice(0, -1)) / 100 : Number(txt);
  if (!isFinite(r) || r < 0 || r >= 1) {
    throw new Error(`Invalid CGT_RATE "${raw}": use a decimal from 0 to under 1 (0.15) or a percentage string (15%).`);
  }
  return r;
})();

const PARAMS = {
  HORIZON_YEARS: 5, TERMINAL_GROWTH: 0.06, FADE_YEARS: 10, MAX_G0: 0.40, MAX_RERATE: 1.25,
  EXIT_TAX: envRate,
  TARGET_CAGR: 0.22, MULTIBAGGER_MULT: 3.0, MIN_FWD_GROWTH: 0.10,
  SCORE_MULTIBAGGER: 70, SCORE_COMPOUNDER: 55,
  // hysteresis: an actual holding with a confirmed PASS only fails below these
  EXIT_SCORE: 45, EXIT_CAGR: 0.17, EXIT_MIN_GROWTH: 0.08,
  CONFIRM_RUNS: 2, CONFIRM_DAYS: 5, HISTORY_LEN: 12,
  REFRESH_DAYS: 5,                       // portfolio thesis re-check cadence (weekly)
  STALE_MAX_DAYS: 30,                    // a stale confirmed state is kept this long, then it becomes NO_DATA
  IMPLIED_CAP_LIMIT_M: 5_000_000, CYCLICAL_HAIRCUT: 0.6, CACHE_DAYS: 7,
  // top line: EPS growth must be backed by revenue growth
  REV_FLOOR: 0.08, REV_FLOOR_MB: 0.10, MARGIN_ALLOWANCE: 0.08, MARGIN_ALLOWANCE_LOW_BASE: 0.15,
  NORMALIZE_PE_RATIO: 1.5,
  // bear case
  BEAR_GROWTH_MULT: 0.7, BEAR_EXIT_MULT: 0.75, BEAR_MIN_CAGR: 0,
  // layer-1 (old quality engine) gate
  QUALITY_ENTRY: 6.0, QUALITY_HOLD: 5.0,
  // sector price leg needs 12 months of aligned sessions
  MIN_SECTOR_BARS: 253,
};
const KEY = 'multibagger_screen';
const DAY_MS = 86400000;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lin = (x, lo, hi) => (x == null || !isFinite(x) ? null : clamp((x - lo) / (hi - lo), 0, 1) * 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = (o, ...keys) => { for (const k of keys) { const v = o?.[k]; if (typeof v === 'number' && isFinite(v)) return v; } return null; };
const posNum = (o, ...keys) => { const v = num(o, ...keys); return v != null && v > 0 ? v : null; };
const median = a => { const s = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const iso = d => d.toISOString().split('T')[0];

// ── Sector mapping ───────────────────────────────────────────────────────────
// Order matters: specific patterns first. Tested against Finnhub finnhubIndustry and FMP sector/industry labels.
const SECTOR_RULES = [
  [/semiconductor|semi equipment/i, 'SMH'],
  [/biotech/i, 'XBI'],
  [/pharma|drug manufactur|health|life sciences|medical|diagnostic/i, 'XLV'],
  [/aerospace|defense/i, 'ITA'],
  [/payment|transaction|bank|financial|insurance|capital markets|asset manag|fintech/i, 'XLF'],
  [/industrial gas|specialty chem|metals|mining|chemical|paper|material|steel|container|packaging/i, 'XLB'],
  [/electronic|instrument|communications equip/i, 'XLK'],
  [/electrical equip|electrical component|machinery|industrial|construction|building|transport|airline|logistics|trading|commercial services|professional|road & rail|engineering|conglomerate/i, 'XLI'],
  [/utilit|independent power|electric util|renewable electricity/i, 'XLU'],   // before energy so "Gas Utilities" is a utility
  [/^energy|\boil\b|\bgas\b|coal|energy equipment|consumable fuels|petroleum/i, 'XLE'],
  [/real estate|reit/i, 'XLRE'],
  [/media|telecom|communication|entertainment|interactive/i, 'XLC'],
  [/consumer defensive|food|beverage|tobacco|household|personal products|staples|packaged foods?/i, 'XLP'],
  [/retail|auto|hotel|restaurant|leisure|apparel|footwear|textile|consumer|e-?commerce|homebuild/i, 'XLY'],
  [/technolog|software|hardware|computer|internet|cyber|it services|data processing/i, 'XLK'],
];
const STAPLES_RETAIL = /discount stores|hypermarket|supermarket|grocery|drug retail|food distribution|food retail/i;
// Representative large constituents used for the sector FUNDAMENTAL check (edit freely).
const SECTOR_CONSTITUENTS = {
  SMH: ['NVDA', 'AVGO', 'AMD', 'TSM', 'ASML'], XLK: ['MSFT', 'AAPL', 'ORCL', 'CRM', 'ADBE'],
  XBI: ['VRTX', 'REGN', 'AMGN', 'GILD', 'MRNA'], XLV: ['LLY', 'UNH', 'JNJ', 'ABBV', 'MRK'],
  ITA: ['RTX', 'LMT', 'GD', 'NOC', 'BA'], XLF: ['JPM', 'BAC', 'WFC', 'GS', 'MS'],
  XLE: ['XOM', 'CVX', 'COP', 'EOG', 'SLB'], XLU: ['NEE', 'DUK', 'SO', 'D', 'AEP'],
  XLRE: ['PLD', 'AMT', 'EQIX', 'WELL', 'SPG'], XLB: ['LIN', 'SHW', 'FCX', 'APD', 'ECL'],
  XLC: ['GOOGL', 'META', 'NFLX', 'DIS', 'T'], XLP: ['PG', 'KO', 'PEP', 'COST', 'WMT'],
  XLY: ['AMZN', 'TSLA', 'HD', 'MCD', 'NKE'], XLI: ['GE', 'CAT', 'UNP', 'HON', 'ETN'],
};
const SECTOR_ETFS = Object.keys(SECTOR_CONSTITUENTS);
const CYCLICAL_ETFS = new Set(['SMH', 'XLE', 'XLB', 'XLI', 'XLF']);
/** Every label is tried against every rule; the match with the most specific rule (lowest index) wins, so a generic sector label never outranks a specific industry. */
function sectorEtfFor(...labels) {
  const ls = labels.filter(l => typeof l === 'string' && l.trim());
  if (ls.some(l => STAPLES_RETAIL.test(l))) return 'XLP';
  let best = null;
  for (const l of ls) {
    for (let i = 0; i < SECTOR_RULES.length; i++) {
      if (SECTOR_RULES[i][0].test(l)) { if (!best || i < best.i) best = { i, etf: SECTOR_RULES[i][1] }; break; }
    }
  }
  return best ? best.etf : null;
}

/**
 * PRICE leg. bars/spyBars: [{c,t}] oldest->newest. Sessions are aligned by DATE (not array index).
 * Needs >= 253 common sessions so the 12-month return is real; ETF must be above its own 200DMA
 * and ahead of SPY over 6 AND 12 months. Anything less returns null (unknown), never a pass.
 */
function assessSectorPrice(bars, spyBars) {
  const MIN = PARAMS.MIN_SECTOR_BARS;
  const clean = arr => (Array.isArray(arr) ? arr : []).filter(b => b && Number.isFinite(b.t) && Number.isFinite(b.c) && b.c > 0);
  const etfBars = clean(bars), spy = clean(spyBars);
  if (etfBars.length < MIN || spy.length < MIN) return null;
  const key = t => iso(new Date(t));
  const spyMap = new Map(spy.map(b => [key(b.t), b.c]));
  // ONE shared timeline: trend, 6M and 12M returns all end on the same latest common session
  const common = etfBars.filter(b => spyMap.has(key(b.t))).map(b => ({ c: b.c, s: spyMap.get(key(b.t)) }));
  if (common.length < MIN) return null;
  const n = common.length;
  const ret = (f, k) => common[n - 1][f] / common[n - 1 - k][f] - 1;
  const sma200 = common.slice(-200).reduce((a, d) => a + d.c, 0) / 200;
  const above200 = common[n - 1].c > sma200;
  const r126 = ret('c', 126), r252 = ret('c', 252), s126 = ret('s', 126), s252 = ret('s', 252);
  const rel126 = r126 - s126, rel252 = r252 - s252;
  const priceOk = above200 && rel126 > 0 && rel252 > 0;
  return { above200, r126, r252, rel126, rel252, priceOk, sessions: n };
}

/**
 * FUNDAMENTAL leg from constituents' Finnhub metric objects. history = prior snapshots
 * [{asOf, medFwdEps, medRevYoY, rawBroken}] (one per weekly refresh).
 * Forward expectation (needs forwardPE) and realised growth are kept SEPARATE and never substituted for each other.
 * Fewer than 3 valid revenue readings = UNKNOWN (never "OK").
 */
function assessSectorFundamentals(metrics, history = [], opts = {}) {
  const rows = (metrics || []).map(m => {
    const p = (...k) => { const v = num(m, ...k); return v == null ? null : v / 100; };
    const peT = posNum(m, 'peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM');
    const peF = posNum(m, 'forwardPE');
    return {
      revYoY: p('revenueGrowthTTMYoy', 'revenueGrowthQuarterlyYoy'),
      epsReal: p('epsGrowthTTMYoy', 'epsGrowthQuarterlyYoy') ?? p('epsGrowth3Y'),
      fwdEps: peT && peF ? clamp(peT / peF - 1, -0.5, 0.6) : null,
    };
  });
  const validRev = rows.filter(r => r.revYoY != null).length;
  const validEps = rows.filter(r => r.epsReal != null).length;
  const validFwd = rows.filter(r => r.fwdEps != null).length;
  const counts = { n: rows.length, validRev, validEps, validFwd };
  if (validRev < 3) return { label: 'UNKNOWN', rawBroken: false, medRevYoY: null, medEpsYoY: null, medFwdEps: null, revision: null, ...counts };
  const medRevYoY = median(rows.map(r => r.revYoY));
  const medEpsYoY = validEps >= 3 ? median(rows.map(r => r.epsReal)) : null;
  const medFwdEps = validFwd >= 3 ? median(rows.map(r => r.fwdEps)) : null;
  // revision trend: change in the forward expectation vs a snapshot >= 21 days old (same measure only)
  const old = [...history].reverse().find(h => Date.now() - new Date(h.asOf).getTime() >= 21 * DAY_MS);
  const revision = old && medFwdEps != null && old.medFwdEps != null ? medFwdEps - old.medFwdEps : null;
  // a cyclical group can contract for a while without losing its long-term runway: it needs a deeper, corroborated contraction
  const cyc = !!opts.cyclical;
  const revBreak = cyc ? medRevYoY < -0.05 && (medEpsYoY == null || medEpsYoY < 0) : medRevYoY < 0;
  const rawBroken =
    revBreak ||
    (medEpsYoY != null && medEpsYoY < 0 && (medFwdEps == null || medFwdEps < 0.02) && !cyc) ||
    (revision != null && revision < -0.06 && medFwdEps != null && medFwdEps < 0.08 && !cyc);
  // A sell-worthy break must hold on THREE weekly readings (this one + the previous two, each >= 6 days apart).
  // Company data refreshes quarterly, so this is a persistence rule (time), not proof of new evidence; it keeps one
  // noisy or stale reading from ever starting an exit.
  const [h1, h2] = [history[history.length - 1], history[history.length - 2]];
  const gap = (a, b) => a && b && Number.isFinite(new Date(a).getTime()) && Number.isFinite(new Date(b).getTime()) ? (new Date(a).getTime() - new Date(b).getTime()) / DAY_MS : null;
  const persistent = rawBroken && h1?.rawBroken === true && h2?.rawBroken === true &&
    (gap(new Date().toISOString(), h1.asOf) ?? 0) >= 6 && (gap(h1.asOf, h2.asOf) ?? 0) >= 6;
  const weak = !rawBroken && medRevYoY < 0.03 && (medFwdEps == null || medFwdEps < 0.04);
  const strong = !rawBroken && !weak && medRevYoY >= 0.08 &&
    ((medFwdEps != null && medFwdEps >= 0.08) || (medFwdEps == null && medEpsYoY != null && medEpsYoY >= 0.05));
  const label = persistent ? 'BROKEN' : (rawBroken || weak) ? 'WEAK' : strong ? 'STRONG' : 'OK';
  return { label, rawBroken, unconfirmedBreak: rawBroken && !persistent, medRevYoY, medEpsYoY, medFwdEps, revision, ...counts };
}

/**
 * Combine both legs. A NEW pass needs both (INTACT). One leg alone is PARTIAL (fine for an existing holding, never a new pass).
 * BROKEN needs repeated fundamental deterioration. Stagnant / unconfirmed-break / price-unconfirmed = NOT_CONFIRMED (never a sell signal).
 */
function combineSector(price, fund) {
  const fundOk = fund && fund.label !== 'UNKNOWN' ? fund : null;
  if (!price && !fundOk) return { label: 'UNKNOWN' };
  const partial = !price || !fundOk;
  const meta = { price, fund: fundOk, partial, priceOnly: !!price && !fundOk, fundOnly: !price && !!fundOk };
  if (fundOk?.label === 'BROKEN') return { label: 'BROKEN', ...meta };
  if (fundOk?.label === 'WEAK') return { label: 'NOT_CONFIRMED', stagnant: true, unconfirmedBreak: !!fundOk.unconfirmedBreak, ...meta };
  const fundGood = fundOk && (fundOk.label === 'STRONG' || fundOk.label === 'OK');
  if (price && fundOk) return { label: price.priceOk && fundGood ? 'INTACT' : 'NOT_CONFIRMED', ...meta };
  const good = price ? price.priceOk : fundGood;
  return { label: good ? 'PARTIAL' : 'NOT_CONFIRMED', ...meta };
}

// ── Entry-timing overlay (advisory only, never changes PASS/FAIL) ────────────
function weeklyCloses(bars) {
  const map = new Map();
  for (const b of bars) {
    if (b.t == null) continue;
    const d = new Date(b.t), dow = (d.getUTCDay() + 6) % 7;
    map.set(Math.floor((b.t - dow * DAY_MS) / DAY_MS), b.c);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
}
const ema = (arr, n) => { const k = 2 / (n + 1); let e = arr[0]; const out = [e]; for (let i = 1; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); } return out; };
function rsiWilder(c, n = 14) {
  if (c.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  if (g === 0 && l === 0) return 50;           // flat series: neutral, not overbought
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
/** bars: daily [{c,t}], needs >= 200 sessions for a true 200DMA. Weekly RSI(14) + MACD(12,26,9) -> staggered-entry plan. */
function timingOverlay(bars) {
  if (!bars || bars.length < 200) return null;
  const w = weeklyCloses(bars);
  if (w.length < 35) return null;
  const rsiW = rsiWilder(w);
  const e12 = ema(w, 12), e26 = ema(w, 26);
  const macd = e12.map((v, i) => v - e26[i]);
  const sig = ema(macd, 9);
  const hist = macd.map((v, i) => v - sig[i]);
  const h = hist[hist.length - 1], hPrev = hist[hist.length - 2];
  const sma200 = bars.slice(-200).reduce((a, d) => a + d.c, 0) / 200;
  const last = bars[bars.length - 1].c, ext = last / sma200 - 1;
  let state, plan;
  if (rsiW >= 72 || ext > 0.35 || (h < 0 && h < hPrev && last < sma200)) {
    state = 'WAIT'; plan = 'Do not start yet: overheated or still falling. Set an alert for a pullback toward the 50-day average.';
  } else if (rsiW <= 60 && (h > 0 || h > hPrev) && ext <= 0.25) {
    state = 'ACCUMULATE'; plan = 'Good window: buy 1/3 now, 1/3 in ~4 weeks, 1/3 in ~8 weeks or on a dip.';
  } else {
    state = 'STAGGER'; plan = 'Neutral: start 1/4 now and add the rest monthly or on pullbacks.';
  }
  return { state, plan, rsiWeekly: +rsiW.toFixed(1), macdHist: +h.toFixed(3), macdRising: h > hPrev, extVs200: +ext.toFixed(3) };
}

// ── Core maths ───────────────────────────────────────────────────────────────
/** Linear fade: year 1 = g0, year FADE_YEARS = terminal growth. */
function growthPath(g0, years = PARAMS.HORIZON_YEARS) {
  const gT = PARAMS.TERMINAL_GROWTH, F = PARAMS.FADE_YEARS, out = [];
  for (let t = 1; t <= years; t++) out.push(gT + (g0 - gT) * Math.max(0, (F - t) / (F - 1)));
  return out;
}
const fairExitPE = gExit => clamp(15 + 1.2 * gExit * 100, 14, 35);
const afterTaxMult = m => (m > 1 ? 1 + (m - 1) * (1 - PARAMS.EXIT_TAX) : m);
const cagr = m => (m > 0 ? Math.pow(m, 1 / PARAMS.HORIZON_YEARS) - 1 : -1);

/** exitScale < 1 compresses the exit multiple (bear case) with a floor of 14x (or the current multiple cap if lower). */
function makeProjector(route, base, matureMargin) {
  const N = PARAMS.HORIZON_YEARS;
  return (g0, exitScale = 1) => {
    const path = growthPath(g0, N), gExit = path[N - 1], fair = fairExitPE(gExit);
    if (route === 'REVENUE') {
      const revMult = path.reduce((a, g) => a * (1 + g), 1);
      const exitPS = Math.min(fair * matureMargin, base * PARAMS.MAX_RERATE) * exitScale;
      return { mult: (revMult * exitPS) / base, exitMultiple: exitPS, gExit };
    }
    const used = route === 'EPS_FWD' ? path.slice(1) : path;
    const epsMult = used.reduce((a, g) => a * (1 + g), 1);
    const cap = Math.min(fair, base * PARAMS.MAX_RERATE);
    const floor = Math.min(14, base * PARAMS.MAX_RERATE);
    const exit = exitScale === 1 ? cap : Math.max(floor, cap * exitScale);
    return { mult: (epsMult * exit) / base, exitMultiple: exit, gExit };
  };
}
function requiredG0(project) {
  const ok = g => cagr(afterTaxMult(project(g).mult)) >= PARAMS.TARGET_CAGR;
  if (ok(0)) return 0;
  if (!ok(0.8)) return null;
  let lo = 0, hi = 0.8;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; }
  return hi;
}

// ── Data fetch ───────────────────────────────────────────────────────────────
async function finnhub(path, params, token, tries = 3) {
  const qs = new URLSearchParams({ ...params, token }).toString();
  for (let i = 1; i <= tries; i++) {
    const res = await fetch(`https://finnhub.io/api/v1${path}?${qs}`, { signal: AbortSignal.timeout(10000) });
    if (res.status === 429 && i < tries) { await sleep(2000 * i); continue; }
    if (!res.ok) throw new Error(`Finnhub ${path} HTTP ${res.status}`); // never include the URL (token)
    return res.json();
  }
  return null;
}
const ETF_TYPES = new Set(['ETP', 'ETF', 'Closed-End Fund', 'Open-End Fund', 'REIT']);   // mirrors the old engine's classification
const isEtfProfile = profile => !!profile && ETF_TYPES.has(profile.type);

/**
 * Annual analyst estimates -> revenue / EPS CAGR (+ nearest forward EPS for a forward P/E).
 *  - The latest COMPLETED fiscal year (ended within 400 days) is kept as the growth base, so no forward year is lost;
 *    older years are dropped. Rows backed by fewer than 2 analysts are dropped (stray single-analyst tail years).
 *  - Revenue and EPS are evaluated independently, first row -> furthest valid row.
 *  - EPS series that touch zero or go negative are NOT_MEANINGFUL (null CAGR) instead of being silently dropped.
 *  - breadth is CONFIRMED only when every row states an analyst count >= 2; a missing count is UNKNOWN, not confirmation.
 *  - years = growth steps measured; MULTIBAGGER needs >= 2.
 */
function parseEstimates(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const now = Date.now();
  const cutoff = now - 400 * DAY_MS;
  const rows = arr
    .map(r => ({
      t: new Date(r.date).getTime(),
      rev: r.revenueAvg ?? r.estimatedRevenueAvg,
      eps: r.epsAvg ?? r.estimatedEpsAvg,
      nRev: r.numAnalystsRevenue ?? r.numberAnalystEstimatedRevenue ?? null,
      nEps: r.numAnalystsEps ?? r.numberAnalystsEstimatedEps ?? r.numberAnalystEstimatedEps ?? null,
    }))
    .filter(r => isFinite(r.t) && r.t >= cutoff)
    .sort((a, b) => a.t - b.t)
    .slice(0, 5);                       // completed base year + up to 4 forward years
  const cagrOf = (key, nKey) => {
    const usable = rows.filter(r => typeof r[key] === 'number' && isFinite(r[key]) && (r[nKey] == null || r[nKey] >= 2));
    if (usable.length < 2) return null;
    const first = usable[0], last = usable[usable.length - 1];
    const years = Math.max(1, Math.round((last.t - first.t) / (365.25 * DAY_MS)));
    const meaningful = usable.every(r => r[key] > 0);
    return {
      g: meaningful ? Math.pow(last[key] / first[key], 1 / years) - 1 : null, years, meaningful,
      breadth: usable.every(r => r[nKey] != null) ? 'CONFIRMED' : 'UNKNOWN',
    };
  };
  const rev = cagrOf('rev', 'nRev'), eps = cagrOf('eps', 'nEps');
  const fwdRow = rows.find(r => r.t > now && typeof r.eps === 'number');       // the NEAREST forward year, never a later one
  const firstEps = fwdRow && fwdRow.eps > 0 ? fwdRow.eps : null;               // a loss has no forward P/E
  if (!rev && !eps && !firstEps) return null;
  return {
    revCagr: rev?.g ?? null, epsCagr: eps?.g ?? null,
    revYears: rev?.years ?? null, epsYears: eps?.years ?? null,
    revBreadth: rev?.breadth ?? null, epsBreadth: eps?.breadth ?? null,
    revNotMeaningful: !!rev && !rev.meaningful, epsNotMeaningful: !!eps && !eps.meaningful,
    years: Math.max(rev?.years ?? 0, eps?.years ?? 0),
    firstEps,
  };
}
async function fetchEstimates(symbol, fmpKey) {
  if (!fmpKey) return null;
  const urls = [
    `https://financialmodelingprep.com/stable/analyst-estimates?symbol=${symbol}&period=annual&limit=10&apikey=${fmpKey}`,
    `https://financialmodelingprep.com/api/v3/analyst-estimates/${symbol}?limit=10&apikey=${fmpKey}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const out = parseEstimates(await res.json());
      if (out) return out;
    } catch (_) { /* next */ }
  }
  return null;
}
async function fetchInputs(symbol, token, fmpKey = null) {
  const metric = await finnhub('/stock/metric', { symbol, metric: 'all' }, token);
  const profile = await finnhub('/stock/profile2', { symbol }, token).catch(() => ({}));
  const estimates = await fetchEstimates(symbol, fmpKey);
  return { metric: metric?.metric || {}, profile: profile || {}, estimates };
}

// ── Price bars: Polygon first, FMP as fallback ───────────────────────────────
async function polygonBars(sym, key, timeoutMs = 12000) {
  const end = new Date(), start = new Date(Date.now() - 400 * DAY_MS);   // ~275 sessions: enough for a 12-month aligned return
  const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${iso(start)}/${iso(end)}?adjusted=true&sort=asc&limit=500&apiKey=${key}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Polygon ${sym} HTTP ${res.status}`);
  return ((await res.json()).results || []).map(r => ({ c: r.c, t: r.t }));
}
async function fmpBars(sym, key, timeoutMs = 12000) {
  const to = iso(new Date()), from = iso(new Date(Date.now() - 400 * DAY_MS));
  const urls = [
    `https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${sym}&from=${from}&to=${to}&apikey=${key}`,
    `https://financialmodelingprep.com/api/v3/historical-price-full/${sym}?from=${from}&to=${to}&apikey=${key}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const j = await res.json();
      const rows = Array.isArray(j) ? j.map(r => ({ c: r.price ?? r.close, d: r.date })) : (j.historical || []).map(r => ({ c: r.close, d: r.date }));
      const bars = rows.filter(r => r.c > 0 && r.d).map(r => ({ c: r.c, t: new Date(`${r.d}T00:00:00Z`).getTime() })).sort((a, b) => a.t - b.t);
      if (bars.length >= 200) return bars;
    } catch (_) { /* next */ }
  }
  return null;
}
/** -> { bars, source } or null. keys = { polyKey, fmpKey, timeoutMs } */
async function fetchBars(sym, keys = {}) {
  const { polyKey, fmpKey, timeoutMs } = keys;
  if (polyKey) {
    try { const b = await polygonBars(sym, polyKey, timeoutMs); if (b.length >= 200) return { bars: b, source: 'polygon' }; } catch (_) { /* fall back */ }
  }
  if (fmpKey) { const b = await fmpBars(sym, fmpKey, timeoutMs); if (b) return { bars: b, source: 'fmp' }; }
  return null;
}
/** Adds/refreshes the advisory entry-timing overlay on a PASS result (weekly). screen() itself stays pure (no network). */
async function attachTiming(result, keys) {
  if (!result || result.status !== 'PASS') return { result, fetched: false, source: null };
  const t = result.entryTiming;
  if (t && Date.now() - new Date(t.asOf).getTime() < 6 * DAY_MS) return { result, fetched: false, source: null };
  const got = await fetchBars(result.symbol, keys);
  if (!got) return { result, fetched: true, source: null };
  const o = timingOverlay(got.bars);
  if (o) result.entryTiming = { ...o, asOf: new Date().toISOString() };
  return { result, fetched: true, source: got.source };
}

// ── Debt/equity with verified units ──────────────────────────────────────────
/**
 * Finnhub's debt/equity fields may be a ratio or percent-style. Instead of guessing, the value is checked against
 * total debt / (book value per share x shares). Without that anchor, only values in 0..2.5 are accepted (they are
 * "safe" under either reading); anything larger is UNVERIFIED (de = null) and never treated as proof of distress or strength.
 */
function readDebtToEquity(m, profile = {}) {
  const total = num(m, 'totalDebt/totalEquityAnnual'), lt = num(m, 'longTermDebt/equityAnnual');
  const raw = total ?? lt, field = total != null ? 'total' : lt != null ? 'longTerm' : null;
  if (raw == null) return { de: null, raw: null, field: null, unit: 'MISSING' };
  const debtM = num(m, 'totalDebtAnnual'), bvps = num(m, 'bookValuePerShareAnnual');
  const sh = typeof profile?.shareOutstanding === 'number' && profile.shareOutstanding > 0 ? profile.shareOutstanding : null;
  const equityM = bvps != null && sh != null ? bvps * sh : null;
  if (debtM != null && equityM != null && equityM !== 0) {
    const calc = Math.abs(debtM / equityM);
    const dist = c => Math.abs(Math.log((Math.abs(c) + 0.05) / (calc + 0.05)));
    const asRatio = raw, asPct = raw / 100;
    const best = dist(asRatio) <= dist(asPct) ? asRatio : asPct;
    if (dist(best) <= Math.log(4)) return { de: best, raw, field, unit: best === asRatio ? 'RATIO' : 'PERCENT' };
    return { de: null, raw, field, unit: 'UNVERIFIED' };
  }
  if (raw >= 0 && raw <= 2.5) return { de: raw, raw, field, unit: 'SAFE_EITHER_WAY' };
  return { de: null, raw, field, unit: 'UNVERIFIED' };
}

// ── Stale state: one implementation used by screen() and by the runner's failure path ─────
const validDate = v => Number.isFinite(Date.parse(v ?? ''));
/**
 * Missing/failed data must not erase a confirmed state, and must never leave a buy signal standing:
 *  - a confirmed PASS/FAIL is kept, marked STALE, with its last valid date; sell/trim/exit actions of a holding are kept
 *  - a stale PASS holding shows DATA_STALE; anything not owned shows STALE_NO_BUY
 *  - after STALE_MAX_DAYS the result expires to NO_DATA (the last confirmed status is kept separately for audit)
 * base = { symbol, name, source, held, asOf } used when the result expires.
 */
function preserveOrExpire(prev, held, reason, base = {}) {
  const now = new Date().toISOString();
  const confirmed = !!prev && validDate(prev.asOf) && (prev.status === 'PASS' || prev.status === 'FAIL');
  const staleSince = validDate(prev?.staleSince) ? prev.staleSince : now;
  const staleDays = (Date.now() - Date.parse(staleSince)) / DAY_MS;
  if (confirmed && staleDays <= PARAMS.STALE_MAX_DAYS) {
    const urgent = prev.action === 'REVIEW_EXIT' || prev.action === 'THESIS_AT_RISK';
    const action = !held ? 'STALE_NO_BUY' : (prev.status === 'PASS' && !urgent ? 'DATA_STALE' : prev.action);
    return {
      ...prev, held, stale: true, staleReason: reason, staleSince, lastAttempt: now, action,
      reasons: [`Data unavailable (${reason}). Showing the last valid assessment from ${String(prev.asOf).slice(0, 10)}; no new buying until it is refreshed.`, ...(prev.reasons || []).filter(r => !String(r).startsWith('Data unavailable'))],
    };
  }
  const lastConfirmed = prev && (prev.status === 'PASS' || prev.status === 'FAIL')
    ? { status: prev.status, verdict: prev.verdict, asOf: prev.asOf }
    : prev?.lastConfirmed ?? null;
  return { ...base, held, asOf: base.asOf || now, verdict: 'INSUFFICIENT_DATA', status: 'NO_DATA', isCompounder: false, score: null, flags: [], reasons: [reason], confidence: 'LOW', lastConfirmed, history: prev?.history || [] };
}

// ── Layer-1 gate: the old quality engine decides "is it a quality compounder" ─
const GATE_SELL_SIGNALS = new Set(['TRIM_25', 'SELL', 'REDUCE']);   // old engine wants out
function qualityGate(stock, exitMode) {
  const need = exitMode ? PARAMS.QUALITY_HOLD : PARAMS.QUALITY_ENTRY;
  if (!stock) return { state: 'UNVERIFIED', need, reason: 'Not in the portfolio yet, so the quality engine has not scored it. It is scored after the close once added.' };
  const q = stock.score_fund;
  if (typeof q !== 'number' || !Number.isFinite(q) || q < 0 || q > 10) return { state: 'UNVERIFIED', need, reason: 'The quality engine has no valid score for this stock yet (it runs after the close).' };
  if (GATE_SELL_SIGNALS.has(stock.signal)) return { state: 'FAIL', q, need, structural: true, reason: `The quality engine signal is ${stock.signal}: it wants out of this position. Quality score ${q.toFixed(1)}.` };
  const structural = stock.w4_confirmed === true || (stock.w3_confirmed === true && stock.regime === 'IDIOSYNCRATIC_DECAY');
  if (structural) return { state: 'FAIL', q, need, structural: true, reason: `Quality engine reports structural decay (W3/W4 with idiosyncratic underperformance). Quality score ${q.toFixed(1)}.` };
  if (q < need) return { state: 'FAIL', q, need, reason: `Quality score ${q.toFixed(1)} is below the ${need.toFixed(1)} needed to ${exitMode ? 'stay' : 'qualify as'} an alpha compounder.` };
  return { state: 'PASS', q, need, reason: `Quality score ${q.toFixed(1)} clears the ${need.toFixed(1)} bar.` };
}

// ── The screen ───────────────────────────────────────────────────────────────
/** held: caller states whether the position is actually owned. Ownership is never inferred from prev.status. */
function screen({ symbol, metric = {}, profile = {}, stock = null, filing = null, earnings = null, sectorHealth = null, estimates = null, prev = null, isETF = false, source = 'watchlist', held = false }) {
  const now = new Date().toISOString();
  const nm = profile.name || stock?.name || symbol;
  if (isETF || stock?.instrument_type === 'ETF' || stock?.type === 'ETF') {
    return { symbol, name: nm, source, held, asOf: now, verdict: 'NOT_APPLICABLE', status: 'NOT_APPLICABLE', isCompounder: false, score: null, flags: [], reasons: ['ETFs and funds are not screened: the multibagger test applies to individual operating companies.'], confidence: 'LOW' };
  }
  const m = metric;
  const est = estimates || null;
  const pct = (...k) => { const v = num(m, ...k); return v == null ? null : v / 100; };
  const rev3 = pct('revenueGrowth3Y'), rev5 = pct('revenueGrowth5Y'), revYoY = pct('revenueGrowthTTMYoy', 'revenueGrowthQuarterlyYoy');
  const eps3 = pct('epsGrowth3Y', 'epsGrowth5Y');
  const peTTM = posNum(m, 'peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM'), psTTM = posNum(m, 'psTTM');
  const roic = pct('roicTTM', 'roiTTM', 'roiAnnual');
  const gm = pct('grossMarginTTM', 'grossMarginAnnual'), gm5 = pct('grossMargin5Y');
  const opm = pct('operatingMarginTTM'), opm5 = pct('operatingMargin5Y'), netm = pct('netProfitMarginTTM', 'netMarginTTM');
  const fcfM = pct('freeCashFlowMarginTTM');
  const icov = num(m, 'netInterestCoverageTTM', 'netInterestCoverageAnnual');
  const cashM = num(m, 'cashAndEquivalentsAnnual'), debtM = num(m, 'totalDebtAnnual'), bvps = num(m, 'bookValuePerShareAnnual');
  const { de, raw: deRaw, unit: deUnit } = readDebtToEquity(m, profile);
  const marketCapM = num(m, 'marketCapitalization') ?? (typeof profile.marketCapitalization === 'number' && profile.marketCapitalization > 0 ? profile.marketCapitalization : null);
  const ret52 = num(m, '52WeekPriceReturnDaily');
  // forward P/E: Finnhub rarely supplies one, so derive it from the nearest forward consensus EPS
  const estPrice = stock?.current_price > 0 ? stock.current_price
    : (profile.marketCapitalization > 0 && profile.shareOutstanding > 0 ? profile.marketCapitalization / profile.shareOutstanding : null);
  const fwdPE = posNum(m, 'forwardPE') ?? (estPrice && est?.firstEps > 0 ? estPrice / est.firstEps : null);

  const base = { symbol, name: nm, source, held, asOf: now, params: { exitTax: PARAMS.EXIT_TAX, horizon: PARAMS.HORIZON_YEARS } };
  // Missing data must not erase a confirmed state (see preserveOrExpire): kept, marked STALE, no buying, expires after 30 days
  const noData = reason => preserveOrExpire(prev, held, reason, base);

  const flags = [], brokenReasons = [];
  const flag = (code, level, text) => flags.push({ code, level, text });
  const broken = (code, text) => { flag(code, 'red', text); brokenReasons.push(code); };

  // relaxed thresholds are for an ACTUAL holding with a confirmed PASS, never for a watchlist stock
  const exitMode = held && prev?.status === 'PASS';
  const T_G = exitMode ? PARAMS.EXIT_MIN_GROWTH : PARAMS.MIN_FWD_GROWTH;
  const T_SCORE = exitMode ? PARAMS.EXIT_SCORE : PARAMS.SCORE_COMPOUNDER;
  const T_MB_SCORE = exitMode ? PARAMS.SCORE_COMPOUNDER : PARAMS.SCORE_MULTIBAGGER;
  const T_CAGR = exitMode ? PARAMS.EXIT_CAGR : PARAMS.TARGET_CAGR;

  const gate = qualityGate(stock, exitMode);

  // Sector mapping (most specific label first)
  const etf = sectorEtfFor(stock?.industry, stock?.sector, profile.finnhubIndustry);

  // 1a. Valuation route first, so growth is built from the matching measure
  let route = null, basePx = null, normalizedPE = false;
  if (peTTM && fwdPE && peTTM > PARAMS.NORMALIZE_PE_RATIO * fwdPE) { route = 'EPS_FWD'; basePx = fwdPE; normalizedPE = true; }
  else if (peTTM) { route = 'EPS_TTM'; basePx = peTTM; }
  else if (fwdPE) { route = 'EPS_FWD'; basePx = fwdPE; }
  else if (psTTM) { route = 'REVENUE'; basePx = psTTM; }
  if (!route) return noData('No usable valuation multiple (P/E or P/S) available.');
  const isRevRoute = route === 'REVENUE';

  // 1b. Forward growth, per route. Revenue and EPS are never blended into one number.
  const fwdRev = est?.revCagr != null ? clamp(est.revCagr, -0.3, 0.6) : null;
  const fwdEps = est?.epsCagr != null ? clamp(est.epsCagr, -0.3, 0.6) : null;
  const epsTurnaround = !!est?.epsNotMeaningful;      // EPS forecasts touch/cross zero: CAGR is not meaningful
  const epsFwdImplied = peTTM && fwdPE && !normalizedPE && !epsTurnaround ? clamp(peTTM / fwdPE - 1, -0.5, 0.6) : null;
  const histRev = rev3 != null && revYoY != null ? 0.6 * rev3 + 0.4 * revYoY : (rev3 ?? revYoY ?? rev5);
  const histEps = eps3 != null ? clamp(eps3, -0.3, 0.6) : null;
  const blend = (f, h, wf) => (f != null && h != null ? wf * f + (1 - wf) * h : (f ?? h));
  const revG = blend(fwdRev, histRev, 0.65);          // top-line growth: floor and cap for EPS growth
  const epsG = blend(fwdEps ?? epsFwdImplied, histEps, 0.5);
  const fwdPrimary = isRevRoute ? fwdRev : fwdEps;    // pure consensus on the active route (for change tracking)

  let forwardSource, g0, epsProxy = false, marginCap = null;
  if (isRevRoute) {
    forwardSource = fwdRev != null ? 'CONSENSUS' : 'HISTORY_ONLY';
    g0 = blend(fwdRev, histRev, fwdRev != null ? 0.65 : 0.4);
  } else if (epsTurnaround) {
    // EPS forecasts cross zero: no earnings growth rate exists. Revenue growth is shown for context; the verdict is UNPROVEN.
    forwardSource = 'NOT_MEANINGFUL';
    g0 = revG;
  } else {
    forwardSource = fwdEps != null ? 'CONSENSUS' : epsFwdImplied != null ? 'IMPLIED_1Y' : 'HISTORY_ONLY';
    g0 = blend(fwdEps ?? epsFwdImplied, histEps, forwardSource === 'CONSENSUS' ? 0.65 : 0.4);
    if (g0 == null && revG != null) { g0 = revG; epsProxy = true; }
    // cost-cutting / buyback "EPS mirage": earnings cannot outgrow revenue by more than margin expansion allows
    const allowance = netm != null && netm < 0.08 ? PARAMS.MARGIN_ALLOWANCE_LOW_BASE : PARAMS.MARGIN_ALLOWANCE;
    if (revG != null && g0 != null && g0 > revG + allowance) { marginCap = { from: g0, to: revG + allowance, revG }; g0 = revG + allowance; }
  }
  if (g0 == null) return noData('Not enough growth data (revenue/EPS) from the data provider to screen this stock.');

  const estYears = est ? (isRevRoute ? est.revYears : est.epsYears) : null;
  const consensusDepthOk = estYears != null && estYears >= 2;
  const breadthConfirmed = (isRevRoute ? est?.revBreadth : est?.epsBreadth) === 'CONFIRMED';
  const topLineOk = revG != null && revG >= PARAMS.REV_FLOOR;
  const mbTopLineOk = revG != null && revG >= PARAMS.REV_FLOOR_MB;

  // Peak-cycle margins only make sense for cyclical groups; a high-margin scaler is not "at a peak"
  const spike = (gm5 != null && gm5 > 0.02 && gm != null && gm > gm5 * 1.5) || (opm5 != null && opm5 > 0.02 && opm != null && opm > opm5 * 1.6);
  const cyclical = CYCLICAL_ETFS.has(etf) && (!!stock?.cyclical_peak_flag || spike);
  if (cyclical) { g0 *= PARAMS.CYCLICAL_HAIRCUT; flag('CYCLICAL_PEAK', 'amber', 'Margins look peak-cycle in a cyclical group; growth haircut 40% because it should not be extrapolated.'); }
  g0 = clamp(g0, -0.1, PARAMS.MAX_G0);

  // 2-6. Valuation. A mature margin is only ever assumed for the ILLUSTRATIVE loss-maker scenario, which cannot pass.
  const matureMargin = clamp(netm > 0 ? netm : opm > 0 ? opm * 0.75 : gm ? gm * 0.25 : 0.10, 0.08, 0.25);
  const project = makeProjector(route, basePx, matureMargin);
  const proj = project(g0), mult5y = proj.mult, atMult = afterTaxMult(mult5y), atCagr = cagr(atMult);
  const reqG0 = requiredG0(project);
  const pricedInRatio = reqG0 != null && g0 > 0 ? reqG0 / g0 : null;
  const impliedCapM = marketCapM != null ? marketCapM * mult5y : null;
  const runway = marketCapM == null ? 'UNVERIFIED' : impliedCapM > PARAMS.IMPLIED_CAP_LIMIT_M ? 'FAIL' : 'PASS';
  const bearMult = project(clamp(g0 * PARAMS.BEAR_GROWTH_MULT, -0.1, PARAMS.MAX_G0), PARAMS.BEAR_EXIT_MULT).mult;
  const bearCagr = cagr(afterTaxMult(bearMult));

  // S-curve stage (forward consensus preferred)
  const accelNow = fwdRev ?? revYoY;
  const accel = rev3 != null && rev3 > 0.05 && accelNow != null ? accelNow / rev3 : null;
  let stage;
  if (g0 < 0.05) stage = 'DECLINING'; else if (g0 < 0.15 || (accel != null && accel < 0.7)) stage = 'LATE';
  else if (g0 >= 0.25 && (accel == null || accel >= 1)) stage = 'EARLY'; else stage = 'MID';

  let timing = 'OK';
  const px = stock?.current_price, sma200 = stock?.sma200;
  if (px && sma200 && px / sma200 - 1 > 0.35) timing = 'EXTENDED'; else if (ret52 != null && ret52 > 100) timing = 'EXTENDED';

  // Business-dying test
  const shrinking = (rev3 != null && rev3 < 0) || (revYoY != null && revYoY < -0.02) ||
    (eps3 != null && eps3 < -0.10 && (revYoY ?? 0) < 0.05) || (gm != null && gm5 != null && gm < gm5 - 0.08 && g0 < 0.15);
  const marginErosion = (gm != null && gm5 != null && gm < gm5 - 0.04) || (opm != null && opm5 != null && opm < opm5 - 0.05);

  // Sector gate: a NEW pass needs both legs (INTACT); an actual holding keeps its pass through missing sector data
  const secRaw = etf && sectorHealth ? sectorHealth[etf] : null;
  const sec = secRaw ? combineSector(secRaw.price, secRaw.fund) : null;
  const sectorPass = exitMode ? (!sec || ['INTACT', 'PARTIAL', 'UNKNOWN'].includes(sec.label)) : sec?.label === 'INTACT';
  const sectorFull = sec?.label === 'INTACT';

  // Balance sheet: book D/E is distorted by buybacks, so it is judged with returns, interest cover, cash flow and maturities.
  // Negative interest cover means net interest INCOME when operating profit is positive, but an operating loss otherwise.
  const icovEff = icov == null ? null : icov >= 0 ? icov : (opm == null ? null : opm > 0 ? Infinity : 0);
  const coverStrong = icovEff != null && icovEff >= 5;
  const fcfPos = fcfM != null && fcfM > 0;
  const maturityOk = stock?.debt_maturity_flag !== 'wall';       // maturities are only checked for portfolio stocks; a watchlist candidate stays provisional anyway
  const strongCover = roic != null && roic >= 0.20 && coverStrong && fcfPos && maturityOk;
  const hasDebt = de != null ? de > 0.5 : (debtM != null && debtM > 0);
  const noCover = icovEff != null && icovEff < 1.5 && hasDebt;
  const bookHigh = de != null && de > 2.5;
  const negEquity = ((de != null && de < 0) || (bvps != null && bvps < 0)) && !(cashM != null && debtM != null && cashM > debtM);
  const wallStress = stock?.debt_maturity_flag === 'wall' && de != null && de > 1.5;
  const weakEvidence = (icovEff != null && icovEff < 5) || (roic != null && roic < 0.10) || (fcfM != null && fcfM <= 0) || stock?.debt_maturity_flag === 'wall';
  let leverage;     // OK | HIGH_COVERED | HIGH_UNVERIFIED | UNKNOWN | BROKEN
  if (noCover) leverage = 'BROKEN';
  else if (wallStress && !strongCover) leverage = 'BROKEN';
  else if (bookHigh || negEquity) leverage = strongCover ? 'HIGH_COVERED' : weakEvidence ? 'BROKEN' : 'HIGH_UNVERIFIED';
  else if (de == null) leverage = coverStrong && fcfPos ? 'OK' : 'UNKNOWN';
  else leverage = 'OK';
  const leverageOkNew = leverage === 'OK' || leverage === 'HIGH_COVERED';

  // ── Flags: THESIS-BROKEN (sell-worthy for a holding) vs PRICE/NOISE (don't add) ───────
  const critical8K = stock?.event_8k_hint === 'critical';
  if (shrinking) broken('BUSINESS_SHRINKING', 'Revenue or earnings are shrinking: the business is not on a growth curve.');
  else if (marginErosion) flag('MARGIN_EROSION', 'amber', 'Margins are eroding versus their 5-year average (pricing power under pressure).');
  if (g0 < T_G) broken('NO_GROWTH', `Expected growth ${(g0 * 100).toFixed(0)}% is below the ${(T_G * 100).toFixed(0)}% minimum for a compounder.`);
  if (!topLineOk) flag('NO_REVENUE_ENGINE', 'amber', `Blended revenue growth ${revG != null ? (revG * 100).toFixed(0) + '%' : 'n/a'} is below the ${(PARAMS.REV_FLOOR * 100).toFixed(0)}% a compounder needs. Not a sell signal, but it cannot qualify.`);
  if (marginCap) flag('MARGIN_DRIVEN_GROWTH', 'amber', `Earnings growth ${(marginCap.from * 100).toFixed(0)}% far outruns revenue growth ${(marginCap.revG * 100).toFixed(0)}% (cost cuts, buybacks or a depressed base). Capped at ${(marginCap.to * 100).toFixed(0)}%: margins cannot expand forever.`);
  if (epsProxy) flag('EPS_PROXY_REVENUE', 'amber', 'No usable EPS growth data: revenue growth stands in for earnings growth (low confidence).');
  if (epsTurnaround) flag('TURNAROUND', 'amber', 'EPS forecasts touch or cross zero, so an EPS growth rate is not meaningful. Unproven until a path to sustained profit is verified.');
  if (normalizedPE) flag('NORMALIZED_PE', 'amber', `Trailing P/E ${peTTM.toFixed(0)} is far above forward P/E ${fwdPE.toFixed(0)} (likely a one-off GAAP hit): valued on forward P/E.`);
  if (sec?.label === 'BROKEN') broken('SECTOR_BROKEN', `Sector earnings are deteriorating on repeated readings (${etf}: median revenue growth ${sec.fund?.medRevYoY != null ? (sec.fund.medRevYoY * 100).toFixed(0) + '%' : 'n/a'}).`);
  else if (sec?.label === 'NOT_CONFIRMED') flag('SECTOR_NOT_CONFIRMED', 'amber', sec.stagnant
    ? (sec.unconfirmedBreak
      ? `Sector (${etf}) fundamentals show a first sign of deterioration. It becomes a thesis break only if the next weekly reading confirms it; for now it blocks a new PASS.`
      : `Sector (${etf}) growth is stagnant (median revenue growth ${sec.fund?.medRevYoY != null ? (sec.fund.medRevYoY * 100).toFixed(0) + '%' : 'n/a'}). Blocks a new PASS; not a sell signal.`)
    : `Sector (${etf}) is not confirmed: it needs to be above its 200-day average and ahead of the market over 6 and 12 months, with healthy fundamentals. Blocks a new PASS; not a sell signal.`);
  else if (sec?.label === 'INTACT') flag('SECTOR_INTACT', 'green', `Sector (${etf}) is intact: price trend and fundamentals both confirm.`);
  else if (sec?.label === 'PARTIAL') flag('SECTOR_PARTIAL', 'amber', `Sector (${etf}): only the ${sec.priceOnly ? 'price' : 'fundamentals'} leg is available. Fine for a holding, not enough for a NEW pass.`);
  else flag('SECTOR_UNVERIFIED', 'amber', etf ? `Sector (${etf}) health is not available yet: a new PASS waits for the nightly sector refresh.` : 'Sector could not be mapped to a sector ETF: a new PASS cannot be confirmed.');
  if (filing?.gemini?.thesis_status === 'weakening') broken('THESIS_WEAKENING', 'Latest 10-K/10-Q analysis says the thesis is weakening.');
  if (stock?.dilution_flag === 'heavy' || (stock?.sbc_to_market_cap != null && stock.sbc_to_market_cap > 3)) broken('DILUTION', 'Heavy share dilution / stock-based compensation eats owner returns.');
  if (stock?.earnings_quality_flag === 'risk') broken('EARNINGS_QUALITY', 'Reported profit is not backed by operating cash flow.');
  const eqNote = negEquity ? 'negative book equity' : bookHigh ? `book debt/equity ${de.toFixed(1)}` : null;
  if (leverage === 'BROKEN') broken('BALANCE_SHEET', noCover ? `Operating profit does not cover interest (coverage ${icovEff === 0 ? 'operating loss' : icovEff.toFixed(1) + 'x'}).` : `Balance-sheet damage: ${eqNote || 'near-term debt wall'} without strong interest cover, cash flow and returns${stock?.debt_maturity_flag === 'wall' ? ', plus a near-term debt wall' : ''}.`);
  else if (leverage === 'HIGH_COVERED') flag('BUYBACK_LEVERAGE', 'amber', `${negEquity ? 'Negative book equity' : 'Book debt/equity ' + de.toFixed(1)} looks extreme, but ROIC ${(roic * 100).toFixed(0)}%, interest cover and free cash flow check out (maturities are checked for portfolio stocks): typical of heavy buybacks, not distress.`);
  else if (leverage === 'HIGH_UNVERIFIED') flag('LEVERAGE_UNVERIFIED', 'amber', `${eqNote} but interest cover, cash flow or maturities could not be verified. Blocks a new PASS; not a sell signal.`);
  else if (leverage === 'UNKNOWN') flag('LEVERAGE_UNKNOWN', 'amber', `Debt/equity units could not be verified (raw ${deRaw ?? 'n/a'}) and interest cover is not conclusive. Blocks a new PASS until verified.`);
  else if (de != null && de > 2) flag('LEVERAGED', 'amber', `Debt/equity ${de.toFixed(1)} is high.`);
  if (critical8K) broken('CRITICAL_8K', 'Critical 8-K event (bankruptcy/delisting-type) on file.');
  if (stage === 'DECLINING' && !brokenReasons.includes('NO_GROWTH')) broken('DECLINING_STAGE', 'Growth curve is flat or declining.');
  if (stage === 'LATE' && g0 >= T_G) flag('DECELERATING', 'amber', 'Growth is maturing or slowing versus its 3-year trend (late S-curve).');
  if (pricedInRatio != null && pricedInRatio > 1) flag('PRICED_IN', 'amber', `Price already needs ~${(reqG0 * 100).toFixed(0)}% growth for a 22% return; we expect ${(g0 * 100).toFixed(0)}%.`);
  else if (pricedInRatio != null && pricedInRatio <= 0.7) flag('NOT_PRICED_IN', 'green', `Price only needs ~${(reqG0 * 100).toFixed(0)}% growth; we expect ${(g0 * 100).toFixed(0)}% (margin of safety).`);
  if (reqG0 == null) flag('PRICE_UNREACHABLE', 'amber', 'Even 80% growth could not justify a 22% return at this price.');
  if (bearCagr < PARAMS.BEAR_MIN_CAGR) flag('BEAR_CASE_LOSS', 'amber', `Bear case (growth x${PARAMS.BEAR_GROWTH_MULT}, exit multiple x${PARAMS.BEAR_EXIT_MULT}) loses money after tax (${(bearCagr * 100).toFixed(0)}%/yr).`);
  if (runway === 'FAIL') flag('RUNWAY_LIMITED', 'red', `A ${mult5y.toFixed(1)}x would imply a ~$${(impliedCapM / 1e6).toFixed(1)}T company.`);
  else if (runway === 'UNVERIFIED') flag('RUNWAY_UNVERIFIED', 'amber', 'Market capitalisation is unavailable, so the $5T runway test could not run. Blocks MULTIBAGGER.');
  else if (marketCapM > 500_000) flag('LARGE_CAP', 'amber', 'Mega-cap: limited runway for a 3x.');
  if (roic != null && roic < 0.10) flag('WEAK_RETURNS', 'amber', `ROIC ${(roic * 100).toFixed(0)}% is near or below cost of capital.`);
  if (stock?.debt_maturity_flag === 'wall' && leverage !== 'BROKEN') flag('DEBT_WALL', 'amber', 'Large share of debt matures within 12 months.');
  // thesis tracking from information already gathered (filing + earnings analysis, estimates, quality engine)
  if (filing?.gemini?.thesis_status === 'strengthening') flag('THESIS_STRENGTHENING', 'green', 'Latest filing analysis says the thesis is strengthening.');
  if (earnings?.gemini?.guidance_direction === 'lowered') flag('GUIDANCE_CUT', 'amber', 'Management lowered guidance at the last earnings report.');
  if (earnings?.gemini?.eps_beat === false && earnings?.gemini?.revenue_beat === false) flag('EARNINGS_MISS', 'amber', 'Last earnings report missed both EPS and revenue estimates.');
  const mgmtConf = [earnings?.gemini?.management_confidence, filing?.gemini?.management_confidence].filter(v => typeof v === 'number');
  if (mgmtConf.length && Math.min(...mgmtConf) <= 2) flag('MGMT_HEDGING', 'amber', 'Management language in the latest filing/earnings analysis is heavily hedged.');
  // consensus cut vs the best reading of the last 4 checks (stays visible for about a month, not just one run)
  const priorFwd = (prev?.history || []).slice(-4).map(h => h.fwd).filter(v => typeof v === 'number');
  if (fwdPrimary != null && priorFwd.length) {
    const peak = Math.max(...priorFwd);
    if (peak - fwdPrimary > 0.04) flag('ESTIMATES_CUT', 'amber', `Analyst growth expectations were cut from ${(peak * 100).toFixed(0)}% to ${(fwdPrimary * 100).toFixed(0)}% over the last few checks.`);
  }
  if (forwardSource === 'IMPLIED_1Y' || forwardSource === 'HISTORY_ONLY') flag('BACKWARD_LOOKING', 'amber', forwardSource === 'IMPLIED_1Y' ? 'No analyst multi-year estimates: using 1-year implied growth plus history (less forward-looking).' : 'No analyst estimates available: screen relies on history only.');
  else if (forwardSource === 'CONSENSUS' && !consensusDepthOk) flag('THIN_CONSENSUS', 'amber', 'Only one year of analyst growth is available: enough for ALPHA_COMPOUNDER, not for MULTIBAGGER (needs 2+ years).');
  else if (forwardSource === 'CONSENSUS' && !breadthConfirmed) flag('UNKNOWN_BREADTH', 'amber', 'The number of analysts behind the estimates is not confirmed: enough for ALPHA_COMPOUNDER, not for MULTIBAGGER.');
  if (timing === 'EXTENDED') flag('EXTENDED', 'amber', 'Price is stretched above its trend; wait for a pullback rather than chase.');
  if (isRevRoute) flag('LOSS_MAKING', 'amber', 'No earnings yet: the projection below is an ILLUSTRATIVE scenario with an assumed mature margin. Profitability is unproven, so it cannot pass.');
  if (gate.state === 'FAIL') flag('QUALITY_GATE', gate.structural ? 'red' : 'amber', gate.reason);
  else if (gate.state === 'UNVERIFIED') flag('QUALITY_UNVERIFIED', 'amber', gate.reason);
  else flag('QUALITY_OK', 'green', gate.reason);

  // Score
  const stageS = { EARLY: 100, MID: 75, LATE: 25, DECLINING: 0 }[stage];
  let moatS = stock?.moat_score != null ? stock.moat_score * 10 : lin(gm, 0.30, 0.70);
  if (moatS != null && gm != null && gm5 != null && gm > gm5 + 0.02) moatS = Math.min(100, moatS + 10);
  const balanceS = leverage === 'HIGH_COVERED' ? 60 : (leverage === 'OK' && de != null && de >= 0) ? lin(2 - de, 0, 2) : leverage === 'OK' ? 60 : null;
  const parts = {
    growth: [lin(g0, 0.10, 0.35), 28], roic: [lin(roic, 0.08, 0.30), 14], valuation: [lin(atCagr, 0.08, 0.30), 25],
    stage: [stageS, 10], moat: [moatS, 8], balance: [balanceS, 5],
    sector: [sec && sec.label !== 'UNKNOWN' ? { INTACT: 100, PARTIAL: 60, NOT_CONFIRMED: 35, BROKEN: 0 }[sec.label] : null, 5],
    sentiment: [stock ? ((stock.score_insider ?? 5) + (stock.score_rating ?? 5)) * 5 : null, 5],
  };
  let wSum = 0, sSum = 0; const scoreParts = {};
  for (const [k, [v, w]] of Object.entries(parts)) { scoreParts[k] = v == null ? null : Math.round(v); if (v != null) { wSum += w; sSum += v * w; } }
  let score = wSum ? sSum / wSum : 0;
  if (stock?.earnings_quality_flag === 'risk') score -= 10;
  if (filing?.gemini?.thesis_status === 'weakening') score -= 15;
  if (stock?.dilution_flag === 'heavy') score -= 8;
  if (marginErosion) score -= 5;
  score = Math.round(clamp(score, 0, 100));

  const available = [revG, epsG, basePx, roic, gm, marketCapM, de].filter(v => v != null).length;
  let confidence = isRevRoute ? 'LOW' : available >= 6 ? 'HIGH' : available >= 4 ? 'MEDIUM' : 'LOW';
  if ((forwardSource !== 'CONSENSUS' || gate.state === 'UNVERIFIED' || !breadthConfirmed) && confidence === 'HIGH') confidence = 'MEDIUM';

  // ── RAW verdict (this run only) ────────────────────────────────────────────
  const thesisBroken = brokenReasons.length > 0;
  const gateFail = gate.state === 'FAIL';
  const unproven = isRevRoute || epsTurnaround;
  const entryEvidenceOk = exitMode || leverageOkNew;
  const alphaOk = runway !== 'FAIL' && sectorPass && entryEvidenceOk && topLineOk && score >= T_SCORE && atCagr >= T_CAGR;
  const mbOk = alphaOk && runway === 'PASS' && mbTopLineOk && forwardSource === 'CONSENSUS' && consensusDepthOk && breadthConfirmed
    && gate.state === 'PASS' && bearCagr >= PARAMS.BEAR_MIN_CAGR && score >= T_MB_SCORE && atMult >= PARAMS.MULTIBAGGER_MULT;
  let rawVerdict;
  if (thesisBroken) rawVerdict = 'NOT_MULTIBAGGER';
  else if (gateFail) rawVerdict = 'NOT_MULTIBAGGER';                 // the quality engine vetoes: not a compounder by the old rules
  else if (unproven) rawVerdict = 'UNPROVEN_PROFITABILITY';
  else if (mbOk) rawVerdict = 'MULTIBAGGER';
  else if (alphaOk) rawVerdict = 'ALPHA_COMPOUNDER';
  else if (topLineOk && g0 >= 0.15 && (roic == null || roic >= 0.10) && score >= T_SCORE) rawVerdict = 'WAIT_FOR_PRICE';   // held back by price/sector only, not by weak quality
  else rawVerdict = 'NOT_MULTIBAGGER';
  const rawStatus = rawVerdict === 'MULTIBAGGER' || rawVerdict === 'ALPHA_COMPOUNDER' ? 'PASS' : 'FAIL';

  // ── HYSTERESIS: stable status only flips on sustained evidence ─────────────
  const prevStable = prev?.status;
  let status = rawStatus, verdict = rawVerdict, pending = null;
  if (prevStable === 'PASS' || prevStable === 'FAIL') {
    if (rawStatus === prevStable) {
      status = prevStable; verdict = rawVerdict;
    } else if (held && prevStable === 'PASS' && rawVerdict === 'WAIT_FOR_PRICE') {
      // a holding whose quality still clears the bar and is only held back by price/sector: never a sell signal
      status = 'PASS'; verdict = prev.verdict && prev.verdict !== 'WAIT_FOR_PRICE' ? prev.verdict : 'ALPHA_COMPOUNDER';
    } else {
      const same = prev?.pending?.to === rawStatus;
      const since = same ? prev.pending.since : now;
      const runs = same ? prev.pending.runs + 1 : 1;
      const days = (Date.now() - new Date(since).getTime()) / DAY_MS;
      const immediate = rawStatus === 'FAIL' && critical8K;
      if (immediate || (runs >= PARAMS.CONFIRM_RUNS && days >= PARAMS.CONFIRM_DAYS)) { status = rawStatus; verdict = rawVerdict; }
      else { status = prevStable; verdict = prev.verdict; pending = { to: rawStatus, since, runs, needDays: PARAMS.CONFIRM_DAYS }; }
    }
  }
  const isCompounder = status === 'PASS';

  const pricing = (pricedInRatio != null && pricedInRatio > 1) || reqG0 == null ? 'PRICED_IN' : timing === 'EXTENDED' ? 'EXTENDED' : 'OK';
  const thesisState = thesisBroken ? 'BROKEN' : (rawVerdict === 'NOT_MULTIBAGGER' || unproven ? 'UNPROVEN' : 'INTACT');

  // portfolioAction depends on ownership. "Add" needs a passed quality gate AND a fully confirmed sector.
  const oldCaution = !!stock && (stock.signal === 'WATCH' || gate.state === 'FAIL');
  let action;
  if (held) {
    if (thesisBroken && status === 'FAIL') action = 'REVIEW_EXIT';
    else if (thesisBroken) action = 'THESIS_AT_RISK';
    else if (status === 'PASS' && gate.state === 'PASS' && sectorFull && leverageOkNew && pricing === 'OK' && !oldCaution) action = 'HOLD_AND_ADD';
    else if (status === 'PASS' || rawVerdict === 'WAIT_FOR_PRICE') action = 'HOLD_DONT_ADD';
    else action = 'HOLD_WATCH';
  } else {
    if (status === 'PASS' && gate.state === 'PASS' && sectorFull && leverageOkNew) action = 'CANDIDATE_READY';
    else if (status === 'PASS') action = 'CANDIDATE_PROVISIONAL';
    else action = 'NOT_QUALIFIED';
  }

  const reasons = [
    forwardSource === 'CONSENSUS' ? `Analyst consensus expects ${isRevRoute ? 'revenue' : 'EPS'} ${(fwdPrimary * 100).toFixed(0)}% annual growth over ${estYears} year${estYears === 1 ? '' : 's'}; blended revenue growth ${revG != null ? (revG * 100).toFixed(0) + '%' : 'n/a'}.` : null,
    `Expected growth ${(g0 * 100).toFixed(0)}%/yr, fading toward ${(PARAMS.TERMINAL_GROWTH * 100).toFixed(0)}% over 10 years (stage: ${stage}).`,
    `${unproven ? 'Illustrative: ' : ''}projected 5-year price multiple ${mult5y.toFixed(1)}x; after ~${(PARAMS.EXIT_TAX * 100).toFixed(0)}% exit tax ${atMult.toFixed(1)}x (${(atCagr * 100).toFixed(0)}%/yr) vs 22% target. Bear case ${(bearCagr * 100).toFixed(0)}%/yr.`,
    reqG0 != null ? `Current price requires ~${(reqG0 * 100).toFixed(0)}% growth to earn 22% after tax.` : 'Current price cannot reach 22% after tax on any realistic growth.',
    `Quality engine: ${gate.reason}`,
    unproven ? 'Profitability is not yet proven, so no definitive verdict is given. Re-checked weekly.' : null,
    rawVerdict === 'WAIT_FOR_PRICE' ? 'Good business, but the price (or sector confirmation) is not there yet. Not a sell signal.' : null,
    thesisBroken ? `Thesis broken: ${brokenReasons.join(', ')}.` : null,
    pending ? `Status change to ${pending.to} is pending confirmation (run ${pending.runs}/${PARAMS.CONFIRM_RUNS}, needs ${PARAMS.CONFIRM_DAYS} days).` : null,
    status !== rawStatus && !pending ? 'Held at PASS: this run only shows price or sector-price weakness, which is noise for a long-term hold.' : null,
  ].filter(Boolean);

  const history = [...(prev?.history || []), { asOf: now, raw: rawStatus, status, score, g0: +g0.toFixed(4), fwd: fwdPrimary != null ? +fwdPrimary.toFixed(4) : null, atCagr: +atCagr.toFixed(4) }].slice(-PARAMS.HISTORY_LEN);

  return {
    ...base, verdict, rawVerdict, status, rawStatus, pending, isCompounder, score, scoreParts, stage, timing, confidence, stale: false,
    qualityGate: gate,
    thesis: { state: thesisState, brokenReasons, checkedAt: now },
    pricing, action,
    growth: { g0, revG, epsG, epsFwdImplied, fwdRev, fwdEps, fwdPrimary, histG: blend(histRev, histEps, 0.5), forwardSource, estYears, breadthConfirmed, rev3, revYoY, eps3, accel, marginCapped: !!marginCap },
    valuation: { route, basePx, normalizedPE, illustrative: unproven, exitMultiple: proj.exitMultiple, mult5y, afterTaxMult: atMult, afterTaxCagr: atCagr, bearMult, bearCagr, requiredG0: reqG0, pricedInRatio, impliedCapM, runway },
    quality: { roic, gm, gm5, opm, netm, de, deRaw, deUnit, icov, leverage, marketCapM },
    sector: etf ? { etf, label: sec?.label || 'UNKNOWN', priceOnly: !!sec?.priceOnly, partial: !!sec?.partial } : null,
    entryTiming: prev?.entryTiming || null,
    flags, reasons, history,
  };
}

const statusOf = r => (!r ? 'PENDING' : r.status || (r.isCompounder ? 'PASS' : 'FAIL'));
const VERDICT_LABEL = { MULTIBAGGER: 'Multibagger', ALPHA_COMPOUNDER: 'Alpha compounder', WAIT_FOR_PRICE: 'Good business, price/sector not ready', UNPROVEN_PROFITABILITY: 'Profitability not yet proven', NOT_MULTIBAGGER: 'Not a compounder', INSUFFICIENT_DATA: 'Not enough data', NOT_APPLICABLE: 'ETF: not screened' };
const emptyBlob = () => ({ generatedAt: null, portfolio: {}, watchlist: {} });

module.exports = {
  PARAMS, KEY, VERDICT_LABEL, SECTOR_ETFS, SECTOR_CONSTITUENTS, SECTOR_RULES, CYCLICAL_ETFS, sectorEtfFor, assessSectorPrice, assessSectorFundamentals, combineSector,
  finnhub, timingOverlay, isEtfProfile, parseEstimates, fetchEstimates, fetchInputs, fetchBars, attachTiming, readDebtToEquity, qualityGate, preserveOrExpire, screen, statusOf, emptyBlob,
  growthPath, makeProjector, requiredG0, afterTaxMult, cagr, sleep,
};
