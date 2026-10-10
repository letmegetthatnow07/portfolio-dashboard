'use strict';
/**
 * MULTIBAGGER / ALPHA-COMPOUNDER SCREEN  (methodology lives here)
 *
 * Dependency-free (global fetch, Node 18+). Used by backend/scripts/multibagger-screen.js
 * (nightly/manual) and api/portfolio/{multibagger,watchlist}.js (single stock, on demand).
 * Individual operating companies only: ETFs/funds return NOT_APPLICABLE.
 *
 * QUESTION: buying today and holding 5 years, after Indian exit tax, does this stock plausibly
 * earn >= 22%/yr (alpha compounder) or >= 3x (multibagger) on growth that is NOT already priced in?
 *
 * 1 FORWARD GROWTH  analyst consensus revenue/EPS CAGR (2-4 fiscal yrs) 65% + history 35%.
 *   No consensus -> 1-yr implied EPS growth + history, flagged BACKWARD_LOOKING, can never be MULTIBAGGER.
 * 2 S-CURVE FADE    growth fades linearly from g0 to 6% over 10 years.
 * 3 EXIT MULTIPLE   P/E = 15 + 1.2 x year-5 growth%, clamped 14-35x, never above current P/E x 1.25.
 * 4 5Y MULTIPLE     EPS multiple x exit P/E / current P/E (loss-makers: revenue x exit P/S).
 * 5 TAX             gain taxed at EXIT_TAX (12.5% LTCG + surcharge/cess, 15% conservative).
 * 6 PRICED-IN       solve the g0 the CURRENT price needs for 22% after tax; ratio > 1 = already priced in.
 * 7 RUNWAY          implied 5y market cap must stay under $5T.
 * 8 SECTOR GATE     slow and two-sided: price (ETF > 200DMA, +RS vs SPY over 6M and 12M) AND
 *                   fundamentals (median revenue/EPS growth + forward-EPS expectation/revision of
 *                   representative constituents). BROKEN needs fundamental evidence; price weakness
 *                   alone is only NOT_CONFIRMED (blocks new PASS, never forces a sell).
 * 9 THESIS vs PRICE "thesis broken" (shrinking, no growth, sector fundamentals broken, filing thesis
 *                   weakening, dilution, balance-sheet damage, critical 8-K) is sell-worthy; "priced in /
 *                   extended / sector price weak" is noise: it only means don't add.
 * 10 HYSTERESIS     exit thresholds are looser than entry thresholds, a PASS never flips on price alone,
 *                   and any flip needs >= 2 runs spanning >= 7 days (critical 8-K excepted).
 */

const PARAMS = {
  HORIZON_YEARS: 5, TERMINAL_GROWTH: 0.06, FADE_YEARS: 10, MAX_G0: 0.40, MAX_RERATE: 1.25,
  EXIT_TAX: Number(process.env.CGT_RATE) || 0.15,
  TARGET_CAGR: 0.22, MULTIBAGGER_MULT: 3.0, MIN_FWD_GROWTH: 0.10,
  SCORE_MULTIBAGGER: 70, SCORE_COMPOUNDER: 55,
  // hysteresis: a held PASS only fails below these
  EXIT_SCORE: 45, EXIT_CAGR: 0.17, EXIT_MIN_GROWTH: 0.08,
  CONFIRM_RUNS: 2, CONFIRM_DAYS: 7, HISTORY_LEN: 12,
  IMPLIED_CAP_LIMIT_M: 5_000_000, CYCLICAL_HAIRCUT: 0.6, CACHE_DAYS: 7,
};
const KEY = 'multibagger_screen';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lin = (x, lo, hi) => (x == null || !isFinite(x) ? null : clamp((x - lo) / (hi - lo), 0, 1) * 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = (o, ...keys) => { for (const k of keys) { const v = o?.[k]; if (typeof v === 'number' && isFinite(v)) return v; } return null; };
const posNum = (o, ...keys) => { const v = num(o, ...keys); return v != null && v > 0 ? v : null; };
const median = a => { const s = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

// ── Sector mapping ───────────────────────────────────────────────────────────
const SECTOR_RULES = [
  [/semiconductor/i, 'SMH'], [/biotech/i, 'XBI'], [/pharma|health|life sciences|medical/i, 'XLV'],
  [/aerospace|defense/i, 'ITA'], [/bank|financial|insurance|capital markets|asset manag/i, 'XLF'],
  [/energy|oil|gas|coal/i, 'XLE'], [/utilit|power|electric/i, 'XLU'], [/real estate|reit/i, 'XLRE'],
  [/metals|mining|chemical|paper|material|steel/i, 'XLB'],
  [/media|telecom|communication|entertainment|interactive/i, 'XLC'],
  [/food|beverage|tobacco|household|personal products|staples/i, 'XLP'],
  [/retail|auto|hotel|restaurant|leisure|apparel|textile|consumer|e-?commerce/i, 'XLY'],
  [/machinery|industrial|construction|building|transport|airline|logistics|trading|commercial services|professional|equipment/i, 'XLI'],
  [/technolog|software|hardware|computer|internet|cyber|it services/i, 'XLK'],
];
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
function sectorEtfFor(...labels) {
  for (const l of labels) { if (!l) continue; for (const [re, etf] of SECTOR_RULES) if (re.test(l)) return etf; }
  return null;
}

/** PRICE leg. bars: [{c}] oldest->newest. Must be above 200DMA AND beat SPY over 6M and 12M. */
function assessSectorPrice(bars, spyBars) {
  if (!bars || bars.length < 130 || !spyBars || spyBars.length < 130) return null;
  const ret = (b, n) => (b.length > n ? b[b.length - 1].c / b[b.length - 1 - n].c - 1 : null);
  const n200 = Math.min(200, bars.length);
  const sma200 = bars.slice(-n200).reduce((a, d) => a + d.c, 0) / n200;
  const above200 = bars[bars.length - 1].c > sma200;
  const r126 = ret(bars, 126), r252 = ret(bars, 252), s126 = ret(spyBars, 126), s252 = ret(spyBars, 252);
  const rel126 = r126 - s126;
  const rel252 = r252 != null && s252 != null ? r252 - s252 : null;
  const priceOk = above200 && rel126 > 0 && (rel252 == null || rel252 > 0);
  return { above200, r126, r252, rel126, rel252, priceOk };
}

/** FUNDAMENTAL leg from constituents' Finnhub metric objects. history = prior [{asOf, medFwdEps}] snapshots. */
function assessSectorFundamentals(metrics, history = []) {
  const rows = (metrics || []).map(m => {
    const p = (...k) => { const v = num(m, ...k); return v == null ? null : v / 100; };
    const peT = posNum(m, 'peTTM', 'peBasicExclExtraTTM'), peF = posNum(m, 'forwardPE');
    const revYoY = p('revenueGrowthTTMYoy'), rev3 = p('revenueGrowth3Y');
    return {
      revYoY, epsYoY: p('epsGrowthTTMYoy'),
      fwdEps: peT && peF ? clamp(peT / peF - 1, -0.5, 0.6) : null,
      accel: revYoY != null && rev3 != null ? revYoY - rev3 : null,
    };
  });
  if (rows.length < 3) return null;
  const medRevYoY = median(rows.map(r => r.revYoY)), medEpsYoY = median(rows.map(r => r.epsYoY));
  const medFwdEps = median(rows.map(r => r.fwdEps)), medAccel = median(rows.map(r => r.accel));
  // revision trend: change in forward-EPS expectation vs a snapshot >= 21 days old (builds up over time)
  const old = [...history].reverse().find(h => Date.now() - new Date(h.asOf).getTime() >= 21 * 86400000);
  const revision = old && medFwdEps != null && old.medFwdEps != null ? medFwdEps - old.medFwdEps : null;
  const broken =
    (medRevYoY != null && medRevYoY < 0) ||
    (medEpsYoY != null && medFwdEps != null && medEpsYoY < 0 && medFwdEps < 0.02) ||
    (revision != null && revision < -0.06 && medFwdEps != null && medFwdEps < 0.08);
  const strong = !broken && medRevYoY != null && medRevYoY > 0.08 && medFwdEps != null && medFwdEps > 0.05;
  return { label: broken ? 'BROKEN' : strong ? 'STRONG' : 'OK', medRevYoY, medEpsYoY, medFwdEps, medAccel, revision, n: rows.length };
}

/** Combine both legs. BROKEN requires fundamental evidence; price-only weakness is NOT_CONFIRMED. */
function combineSector(price, fund) {
  if (!price && !fund) return { label: 'UNKNOWN' };
  const fundBroken = fund?.label === 'BROKEN';
  let label;
  if (fundBroken) label = 'BROKEN';
  else if (price && price.priceOk) label = 'INTACT';
  else if (price) label = 'NOT_CONFIRMED';
  else label = fund?.label === 'STRONG' || fund?.label === 'OK' ? 'INTACT' : 'UNKNOWN';
  return { label, price, fund, priceOnly: !!price && !fund, fundOnly: !price && !!fund };
}

// ── Entry-timing overlay (advisory only, never changes PASS/FAIL) ────────────
function weeklyCloses(bars) {
  const map = new Map();
  for (const b of bars) {
    if (b.t == null) continue;
    const d = new Date(b.t), dow = (d.getUTCDay() + 6) % 7;
    map.set(Math.floor((b.t - dow * 86400000) / 86400000), b.c);
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
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
/** bars: daily [{c,t}] (>= ~1y). Weekly RSI(14) + MACD(12,26,9) + distance from 200DMA -> staggered-entry plan. */
function timingOverlay(bars) {
  if (!bars || bars.length < 150) return null;
  const w = weeklyCloses(bars);
  if (w.length < 35) return null;
  const rsiW = rsiWilder(w);
  const macd = ema(w, 12).map((v, i) => v - ema(w, 26)[i]);
  const sig = ema(macd, 9);
  const hist = macd.map((v, i) => v - sig[i]);
  const h = hist[hist.length - 1], hPrev = hist[hist.length - 2];
  const n200 = Math.min(200, bars.length);
  const sma200 = bars.slice(-n200).reduce((a, d) => a + d.c, 0) / n200;
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
function growthPath(g0, years = PARAMS.HORIZON_YEARS) {
  const gT = PARAMS.TERMINAL_GROWTH, F = PARAMS.FADE_YEARS, out = [];
  for (let t = 1; t <= years; t++) out.push(gT + (g0 - gT) * ((F - t + 1) / F));
  return out;
}
const fairExitPE = gExit => clamp(15 + 1.2 * gExit * 100, 14, 35);
const afterTaxMult = m => (m > 1 ? 1 + (m - 1) * (1 - PARAMS.EXIT_TAX) : m);
const cagr = m => (m > 0 ? Math.pow(m, 1 / PARAMS.HORIZON_YEARS) - 1 : -1);

function makeProjector(route, base, matureMargin) {
  const N = PARAMS.HORIZON_YEARS;
  return g0 => {
    const path = growthPath(g0, N), gExit = path[N - 1], fair = fairExitPE(gExit);
    if (route === 'REVENUE') {
      const revMult = path.reduce((a, g) => a * (1 + g), 1);
      const exitPS = Math.min(fair * matureMargin, base * PARAMS.MAX_RERATE);
      return { mult: (revMult * exitPS) / base, exitMultiple: exitPS, gExit };
    }
    const used = route === 'EPS_FWD' ? path.slice(1) : path;
    const epsMult = used.reduce((a, g) => a * (1 + g), 1);
    const exit = Math.min(fair, base * PARAMS.MAX_RERATE);
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
const ETF_TYPES = new Set(['ETP', 'ETF', 'Closed-End Fund', 'Open-End Fund', 'REIT']);
const isEtfProfile = profile => !!profile && ETF_TYPES.has(profile.type);

function parseEstimates(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const y0 = new Date().getUTCFullYear();
  const rows = arr
    .map(r => ({ y: new Date(r.date).getUTCFullYear(), rev: r.revenueAvg ?? r.estimatedRevenueAvg, eps: r.epsAvg ?? r.estimatedEpsAvg }))
    .filter(r => isFinite(r.y) && r.y >= y0).sort((a, b) => a.y - b.y).slice(0, 5);
  if (rows.length < 3) return null;
  const first = rows[0], last = rows[rows.length - 1], n = last.y - first.y;
  if (n < 2) return null;
  const g = (a, b) => (a > 0 && b > 0 ? Math.pow(b / a, 1 / n) - 1 : null);
  const revCagr = g(first.rev, last.rev), epsCagr = g(first.eps, last.eps);
  return revCagr == null && epsCagr == null ? null : { revCagr, epsCagr, years: n, from: first.y, to: last.y };
}
async function fetchEstimates(symbol, fmpKey) {
  if (!fmpKey) return null;
  const urls = [
    `https://financialmodelingprep.com/stable/analyst-estimates?symbol=${symbol}&period=annual&limit=8&apikey=${fmpKey}`,
    `https://financialmodelingprep.com/api/v3/analyst-estimates/${symbol}?limit=8&apikey=${fmpKey}`,
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

// ── The screen ───────────────────────────────────────────────────────────────
function screen({ symbol, metric = {}, profile = {}, stock = null, filing = null, earnings = null, sectorHealth = null, estimates = null, prev = null, isETF = false, source = 'watchlist' }) {
  const now = new Date().toISOString();
  const nm = profile.name || stock?.name || symbol;
  if (isETF || stock?.instrument_type === 'ETF' || stock?.type === 'ETF') {
    return { symbol, name: nm, source, asOf: now, verdict: 'NOT_APPLICABLE', status: 'NOT_APPLICABLE', isCompounder: false, score: null, flags: [], reasons: ['ETFs and funds are not screened: the multibagger test applies to individual operating companies.'], confidence: 'LOW' };
  }
  const m = metric;
  const pct = (...k) => { const v = num(m, ...k); return v == null ? null : v / 100; };
  const rev3 = pct('revenueGrowth3Y'), rev5 = pct('revenueGrowth5Y'), revYoY = pct('revenueGrowthTTMYoy', 'revenueGrowthQuarterlyYoy');
  const eps3 = pct('epsGrowth3Y', 'epsGrowth5Y');
  const peTTM = posNum(m, 'peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM'), fwdPE = posNum(m, 'forwardPE'), psTTM = posNum(m, 'psTTM');
  const roic = pct('roicTTM', 'roiTTM', 'roiAnnual');
  const gm = pct('grossMarginTTM', 'grossMarginAnnual'), gm5 = pct('grossMargin5Y');
  const opm = pct('operatingMarginTTM'), opm5 = pct('operatingMargin5Y'), netm = pct('netProfitMarginTTM', 'netMarginTTM');
  const de = num(m, 'longTermDebt/equityAnnual', 'totalDebt/totalEquityAnnual');
  const marketCapM = num(m, 'marketCapitalization') ?? (typeof profile.marketCapitalization === 'number' ? profile.marketCapitalization : null);
  const ret52 = num(m, '52WeekPriceReturnDaily');
  const base = { symbol, name: nm, source, asOf: now, params: { exitTax: PARAMS.EXIT_TAX, horizon: PARAMS.HORIZON_YEARS } };
  const noData = reason => ({ ...base, verdict: 'INSUFFICIENT_DATA', status: 'NO_DATA', isCompounder: false, score: null, flags: [], reasons: [reason], confidence: 'LOW', history: prev?.history || [] });

  // 1. Forward growth (consensus first, history cross-check)
  const est = estimates || null;
  const fwdRev = est?.revCagr != null ? clamp(est.revCagr, -0.3, 0.6) : null;
  const fwdEps = est?.epsCagr != null ? clamp(est.epsCagr, -0.3, 0.6) : null;
  const epsFwdImplied = peTTM && fwdPE ? clamp(peTTM / fwdPE - 1, -0.5, 0.6) : null;
  const histRev = rev3 != null && revYoY != null ? 0.6 * rev3 + 0.4 * revYoY : (rev3 ?? revYoY ?? rev5);
  const histEps = eps3 != null ? clamp(eps3, -0.3, 0.6) : null;
  const mix = (a, b) => (a != null && b != null ? 0.5 * a + 0.5 * b : (a ?? b));
  const histG = mix(histRev, histEps);
  let fwdG = null, forwardSource = 'HISTORY_ONLY';
  if (fwdRev != null || fwdEps != null) { fwdG = mix(fwdRev, fwdEps); forwardSource = 'CONSENSUS'; }
  else if (epsFwdImplied != null) { fwdG = epsFwdImplied; forwardSource = 'IMPLIED_1Y'; }
  let g0 = fwdG != null && histG != null ? (forwardSource === 'CONSENSUS' ? 0.65 * fwdG + 0.35 * histG : 0.4 * fwdG + 0.6 * histG) : (fwdG ?? histG);
  const revG = histRev, epsG = mix(fwdEps ?? epsFwdImplied, histEps);
  if (g0 == null) return noData('Not enough growth data (revenue/EPS) from the data provider to screen this stock.');

  const flags = [], brokenReasons = [];
  const flag = (code, level, text) => flags.push({ code, level, text });
  const broken = (code, text) => { flag(code, 'red', text); brokenReasons.push(code); };

  const cyclical = !!stock?.cyclical_peak_flag;
  if (cyclical) { g0 *= PARAMS.CYCLICAL_HAIRCUT; flag('CYCLICAL_PEAK', 'amber', 'Margins look peak-cycle; growth haircut 40% because it should not be extrapolated.'); }
  g0 = clamp(g0, -0.1, PARAMS.MAX_G0);

  // hysteresis: a held PASS is judged against looser exit thresholds
  const exitMode = prev?.status === 'PASS';
  const T_G = exitMode ? PARAMS.EXIT_MIN_GROWTH : PARAMS.MIN_FWD_GROWTH;
  const T_SCORE = exitMode ? PARAMS.EXIT_SCORE : PARAMS.SCORE_COMPOUNDER;
  const T_MB_SCORE = exitMode ? PARAMS.SCORE_COMPOUNDER : PARAMS.SCORE_MULTIBAGGER;
  const T_CAGR = exitMode ? PARAMS.EXIT_CAGR : PARAMS.TARGET_CAGR;

  // 2-6. Valuation
  const matureMargin = clamp(netm > 0 ? netm : opm > 0 ? opm * 0.75 : gm ? gm * 0.25 : 0.10, 0.08, 0.25);
  let route = null, basePx = null;
  if (peTTM) { route = 'EPS_TTM'; basePx = peTTM; } else if (fwdPE) { route = 'EPS_FWD'; basePx = fwdPE; } else if (psTTM) { route = 'REVENUE'; basePx = psTTM; }
  if (!route) return noData('No usable valuation multiple (P/E or P/S) available.');
  const project = makeProjector(route, basePx, matureMargin);
  const proj = project(g0), mult5y = proj.mult, atMult = afterTaxMult(mult5y), atCagr = cagr(atMult);
  const reqG0 = requiredG0(project);
  const pricedInRatio = reqG0 != null && g0 > 0 ? reqG0 / g0 : null;
  const impliedCapM = marketCapM != null ? marketCapM * mult5y : null;
  const runwayLimited = impliedCapM != null && impliedCapM > PARAMS.IMPLIED_CAP_LIMIT_M;

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

  // Sector gate
  const etf = sectorEtfFor(profile.finnhubIndustry, stock?.sector, stock?.industry);
  const secRaw = etf && sectorHealth ? sectorHealth[etf] : null;
  const sec = secRaw ? combineSector(secRaw.price, secRaw.fund) : null;
  const sectorPass = !sec || sec.label === 'INTACT' || sec.label === 'UNKNOWN';

  // ── Flags: THESIS-BROKEN (sell-worthy) vs PRICE/NOISE (don't add) ──────────
  const critical8K = stock?.event_8k_hint === 'critical';
  if (shrinking) broken('BUSINESS_SHRINKING', 'Revenue or earnings are shrinking: the business is not on a growth curve.');
  else if (marginErosion) flag('MARGIN_EROSION', 'amber', 'Margins are eroding versus their 5-year average (pricing power under pressure).');
  if (g0 < T_G) broken('NO_GROWTH', `Expected growth ${(g0 * 100).toFixed(0)}% is below the ${(T_G * 100).toFixed(0)}% minimum for a compounder.`);
  if (sec?.label === 'BROKEN') broken('SECTOR_BROKEN', `Sector earnings are deteriorating (${etf}: median revenue growth ${sec.fund.medRevYoY != null ? (sec.fund.medRevYoY * 100).toFixed(0) + '%' : 'n/a'}, forward EPS ${sec.fund.medFwdEps != null ? (sec.fund.medFwdEps * 100).toFixed(0) + '%' : 'n/a'}).`);
  else if (sec?.label === 'NOT_CONFIRMED') flag('SECTOR_NOT_CONFIRMED', 'amber', `Sector (${etf}) is not confirmed by price: it needs to be above its 200-day average and beating the market over 6 and 12 months. This blocks a new PASS but is not a sell signal.`);
  else if (sec?.label === 'INTACT') flag('SECTOR_INTACT', 'green', `Sector (${etf}) is intact${sec.priceOnly ? ' (price only; fundamentals not yet available)' : ''}.`);
  if (filing?.gemini?.thesis_status === 'weakening') broken('THESIS_WEAKENING', 'Latest 10-K/10-Q analysis says the thesis is weakening.');
  if (stock?.dilution_flag === 'heavy' || (stock?.sbc_to_market_cap != null && stock.sbc_to_market_cap > 3)) broken('DILUTION', 'Heavy share dilution / stock-based compensation eats owner returns.');
  if (stock?.earnings_quality_flag === 'risk') broken('EARNINGS_QUALITY', 'Reported profit is not backed by operating cash flow.');
  if ((de != null && de > 2.5) || (stock?.debt_maturity_flag === 'wall' && de != null && de > 1.5)) broken('BALANCE_SHEET', `Balance-sheet damage: debt/equity ${de != null ? de.toFixed(1) : 'n/a'}${stock?.debt_maturity_flag === 'wall' ? ' with a near-term debt wall' : ''}.`);
  else if (de != null && de > 2) flag('LEVERAGED', 'amber', `Debt/equity ${de.toFixed(1)} is high.`);
  if (critical8K) broken('CRITICAL_8K', 'Critical 8-K event (bankruptcy/delisting-type) on file.');
  if (stage === 'DECLINING' && !brokenReasons.includes('NO_GROWTH')) broken('DECLINING_STAGE', 'Growth curve is flat or declining.');
  if (stage === 'LATE' && g0 >= T_G) flag('DECELERATING', 'amber', 'Growth is maturing or slowing versus its 3-year trend (late S-curve).');
  if (pricedInRatio != null && pricedInRatio > 1) flag('PRICED_IN', 'amber', `Price already needs ~${(reqG0 * 100).toFixed(0)}% growth for a 22% return; we expect ${(g0 * 100).toFixed(0)}%.`);
  else if (pricedInRatio != null && pricedInRatio <= 0.7) flag('NOT_PRICED_IN', 'green', `Price only needs ~${(reqG0 * 100).toFixed(0)}% growth; we expect ${(g0 * 100).toFixed(0)}% (margin of safety).`);
  if (reqG0 == null) flag('PRICE_UNREACHABLE', 'amber', 'Even 80% growth could not justify a 22% return at this price.');
  if (runwayLimited) flag('RUNWAY_LIMITED', 'red', `A ${mult5y.toFixed(1)}x would imply a ~$${(impliedCapM / 1e6).toFixed(1)}T company.`);
  else if (marketCapM != null && marketCapM > 500_000) flag('LARGE_CAP', 'amber', 'Mega-cap: limited runway for a 3x.');
  if (roic != null && roic < 0.10) flag('WEAK_RETURNS', 'amber', `ROIC ${(roic * 100).toFixed(0)}% is near or below cost of capital.`);
  if (stock?.debt_maturity_flag === 'wall' && !brokenReasons.includes('BALANCE_SHEET')) flag('DEBT_WALL', 'amber', 'Large share of debt matures within 12 months.');
  if (filing?.gemini?.thesis_status === 'strengthening') flag('THESIS_STRENGTHENING', 'green', 'Latest filing analysis says the thesis is strengthening.');
  if (earnings?.gemini?.guidance_direction === 'lowered') flag('GUIDANCE_CUT', 'amber', 'Management lowered guidance at the last earnings report.');
  if (forwardSource !== 'CONSENSUS') flag('BACKWARD_LOOKING', 'amber', forwardSource === 'IMPLIED_1Y' ? 'No analyst multi-year estimates: using 1-year implied growth plus history (less forward-looking).' : 'No analyst estimates available: screen relies on history only.');
  if (timing === 'EXTENDED') flag('EXTENDED', 'amber', 'Price is stretched above its trend; wait for a pullback rather than chase.');
  if (route === 'REVENUE') flag('LOSS_MAKING', 'amber', 'No earnings yet: valued on revenue with an assumed mature margin (lower confidence).');

  // Score
  const stageS = { EARLY: 100, MID: 75, LATE: 25, DECLINING: 0 }[stage];
  let moatS = stock?.moat_score != null ? stock.moat_score * 10 : lin(gm, 0.30, 0.70);
  if (moatS != null && gm != null && gm5 != null && gm > gm5 + 0.02) moatS = Math.min(100, moatS + 10);
  const parts = {
    growth: [lin(g0, 0.10, 0.35), 28], roic: [lin(roic, 0.08, 0.30), 14], valuation: [lin(atCagr, 0.08, 0.30), 25],
    stage: [stageS, 10], moat: [moatS, 8], balance: [de != null && de >= 0 ? lin(2 - de, 0, 2) : null, 5],
    sector: [sec && sec.label !== 'UNKNOWN' ? { INTACT: 100, NOT_CONFIRMED: 35, BROKEN: 0 }[sec.label] : null, 5],
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
  let confidence = route === 'REVENUE' ? 'LOW' : available >= 6 ? 'HIGH' : available >= 4 ? 'MEDIUM' : 'LOW';
  if (forwardSource !== 'CONSENSUS' && confidence === 'HIGH') confidence = 'MEDIUM';

  // ── RAW verdict (this run only) ────────────────────────────────────────────
  const thesisBroken = brokenReasons.length > 0;
  let rawVerdict;
  if (thesisBroken) rawVerdict = 'NOT_MULTIBAGGER';
  else if (!runwayLimited && sectorPass && forwardSource === 'CONSENSUS' && score >= T_MB_SCORE && atMult >= PARAMS.MULTIBAGGER_MULT) rawVerdict = 'MULTIBAGGER';
  else if (!runwayLimited && sectorPass && score >= T_SCORE && atCagr >= T_CAGR) rawVerdict = 'ALPHA_COMPOUNDER';
  else if (g0 >= 0.15 && (roic == null || roic >= 0.10)) rawVerdict = 'WAIT_FOR_PRICE';
  else rawVerdict = 'NOT_MULTIBAGGER';
  const rawStatus = rawVerdict === 'MULTIBAGGER' || rawVerdict === 'ALPHA_COMPOUNDER' ? 'PASS' : 'FAIL';

  // ── HYSTERESIS: stable status only flips on sustained evidence ─────────────
  const prevStable = prev?.status;
  let status = rawStatus, verdict = rawVerdict, pending = null;
  if (prevStable === 'PASS' || prevStable === 'FAIL') {
    if (rawStatus === prevStable) {
      status = prevStable; verdict = rawVerdict;
    } else if (prevStable === 'PASS' && rawVerdict === 'WAIT_FOR_PRICE') {
      // price/sector-price driven: good business, just not buyable now. Never a sell signal.
      status = 'PASS'; verdict = prev.verdict && prev.verdict !== 'WAIT_FOR_PRICE' ? prev.verdict : 'ALPHA_COMPOUNDER';
    } else {
      const same = prev?.pending?.to === rawStatus;
      const since = same ? prev.pending.since : now;
      const runs = same ? prev.pending.runs + 1 : 1;
      const days = (Date.now() - new Date(since).getTime()) / 86400000;
      const immediate = rawStatus === 'FAIL' && critical8K;
      if (immediate || (runs >= PARAMS.CONFIRM_RUNS && days >= PARAMS.CONFIRM_DAYS)) { status = rawStatus; verdict = rawVerdict; }
      else { status = prevStable; verdict = prev.verdict; pending = { to: rawStatus, since, runs, needDays: PARAMS.CONFIRM_DAYS }; }
    }
  }
  const isCompounder = status === 'PASS';

  const pricing = pricedInRatio != null && pricedInRatio > 1 || reqG0 == null ? 'PRICED_IN' : timing === 'EXTENDED' ? 'EXTENDED' : 'OK';
  const thesisState = thesisBroken ? 'BROKEN' : (rawVerdict === 'NOT_MULTIBAGGER' ? 'UNPROVEN' : 'INTACT');
  let action;
  if (thesisBroken && status === 'FAIL') action = 'REVIEW_EXIT';
  else if (thesisBroken) action = 'THESIS_AT_RISK';
  else if (isCompounder && pricing === 'OK' && (sec?.label !== 'NOT_CONFIRMED')) action = 'HOLD_AND_ADD';
  else if (isCompounder || rawVerdict === 'WAIT_FOR_PRICE') action = 'HOLD_DONT_ADD';
  else action = 'HOLD_WATCH';

  const reasons = [
    forwardSource === 'CONSENSUS' ? `Analyst consensus expects revenue ${fwdRev != null ? (fwdRev * 100).toFixed(0) + '%' : 'n/a'} and EPS ${fwdEps != null ? (fwdEps * 100).toFixed(0) + '%' : 'n/a'} annual growth over the next ${est.years} years.` : null,
    `Expected growth ${(g0 * 100).toFixed(0)}%/yr, fading toward ${(PARAMS.TERMINAL_GROWTH * 100).toFixed(0)}% over ~10 years (stage: ${stage}).`,
    `Projected 5-year price multiple ${mult5y.toFixed(1)}x; after ~${(PARAMS.EXIT_TAX * 100).toFixed(0)}% exit tax ${atMult.toFixed(1)}x (${(atCagr * 100).toFixed(0)}%/yr) vs 22% target.`,
    reqG0 != null ? `Current price requires ~${(reqG0 * 100).toFixed(0)}% growth to earn 22% after tax.` : 'Current price cannot reach 22% after tax on any realistic growth.',
    rawVerdict === 'WAIT_FOR_PRICE' ? 'Good business, but the price (or sector confirmation) is not there yet. Not a sell signal.' : null,
    thesisBroken ? `Thesis broken: ${brokenReasons.join(', ')}.` : null,
    pending ? `Status change to ${pending.to} is pending confirmation (run ${pending.runs}/${PARAMS.CONFIRM_RUNS}, needs ${PARAMS.CONFIRM_DAYS} days).` : null,
    status !== rawStatus && !pending ? 'Held at PASS: this run only shows price or sector-price weakness, which is noise for a long-term hold.' : null,
  ].filter(Boolean);

  const history = [...(prev?.history || []), { asOf: now, raw: rawStatus, status, score }].slice(-PARAMS.HISTORY_LEN);

  return {
    ...base, verdict, rawVerdict, status, rawStatus, pending, isCompounder, score, scoreParts, stage, timing, confidence,
    thesis: { state: thesisState, brokenReasons }, pricing, action,
    growth: { g0, revG, epsG, epsFwdImplied, fwdRev, fwdEps, histG, forwardSource, rev3, revYoY, eps3, accel },
    valuation: { route, basePx, exitMultiple: proj.exitMultiple, mult5y, afterTaxMult: atMult, afterTaxCagr: atCagr, requiredG0: reqG0, pricedInRatio, impliedCapM },
    quality: { roic, gm, gm5, opm, netm, de, marketCapM },
    sector: etf ? { etf, label: sec?.label || 'UNKNOWN', priceOnly: !!sec?.priceOnly } : null,
    entryTiming: prev?.entryTiming || null,
    flags, reasons, history,
  };
}

const statusOf = r => (!r ? 'PENDING' : r.status || (r.isCompounder ? 'PASS' : 'FAIL'));
const VERDICT_LABEL = { MULTIBAGGER: 'Multibagger', ALPHA_COMPOUNDER: 'Alpha compounder', WAIT_FOR_PRICE: 'Good business, price/sector not ready', NOT_MULTIBAGGER: 'Not a compounder', INSUFFICIENT_DATA: 'Not enough data', NOT_APPLICABLE: 'ETF: not screened' };
const emptyBlob = () => ({ generatedAt: null, portfolio: {}, watchlist: {} });

module.exports = {
  PARAMS, KEY, VERDICT_LABEL, SECTOR_ETFS, SECTOR_CONSTITUENTS, sectorEtfFor, assessSectorPrice, assessSectorFundamentals, combineSector,
  finnhub, timingOverlay, isEtfProfile, parseEstimates, fetchEstimates, fetchInputs, screen, statusOf, emptyBlob, growthPath, makeProjector, requiredG0, afterTaxMult, cagr, sleep,
};
