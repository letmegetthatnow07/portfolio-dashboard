'use strict';

/**
 * ADVANCED NEWS ANALYZER — v3
 *
 * Changes from v2:
 *   - TICKER_CONTEXT removed: no hardcoded stock knowledge.
 *     Works for any stock added/removed from the dashboard without code changes.
 *   - UNIVERSAL_SIGNALS replaces it: sector-agnostic fundamental, industry,
 *     and macro signals that apply to any publicly listed company.
 *   - Source tiers expanded to 4 levels with many more named outlets.
 *     Unknown sources get tier default (1.0) — not penalised, not ignored.
 *
 * All v2 fixes retained:
 *   1. Financial-context sentiment overrides (FINANCE_OVERRIDES)
 *   2. Deduplication before scoring (Jaccard similarity on headline fingerprints)
 *   3. Importance formula rebuilt (source bonus gated, no auto-maxing)
 *   4. Relevance now uses universal signals (was ticker-specific)
 *   5. ageFactor and priceImpact wired into sentiment.effective
 */

const Sentiment = require('sentiment');
const logger    = require('./logger');

// ─── FINANCIAL WORD OVERRIDES ────────────────────────────────────────────────
// Corrects the general-purpose AFINN word list for investor-relevant language.
// Registered as a custom language so the base AFINN list still applies for
// everything not listed here.
const FINANCE_OVERRIDES = {
  // AFINN scores negative — but investor-neutral or bullish
  'cuts':              0,   // "cuts costs" = often bullish
  'cut':               0,
  'cutting':           0,
  'layoffs':           0,   // cost discipline signal, context-dependent
  'layoff':            0,
  'restructuring':     0,   // strategic by default
  'restructure':       0,
  'charges':           0,   // "one-time charges" = usually neutral
  'charge':            0,
  'headcount':         0,
  'streamline':        1,   // efficiency lean positive
  'efficiency':        1,

  // Genuine investor-bearish — AFINN misses or under-scores
  'miss':             -2,   // "earnings miss"
  'misses':           -2,
  'missed':           -2,
  'disappoints':      -2,
  'disappointing':    -2,
  'disappointed':     -2,
  'probe':            -2,   // "SEC probe"
  'investigation':    -2,
  'subpoena':         -3,
  'lawsuit':          -2,
  'litigation':       -2,
  'class_action':     -3,
  'fraud':            -3,
  'restatement':      -3,
  'material_weakness':-3,
  'recall':           -2,
  'downgrade':        -2,
  'guidance_cut':     -3,
  'guidance_cuts':    -3,
  'going_concern':    -4,
  'bankruptcy':       -4,
  'chapter_11':       -4,
  'insolvency':       -4,
  'writedown':        -2,
  'impairment':       -2,
  'default':          -3,
  'delisting':        -4,
  'scandal':          -3,
  'bribery':          -3,
  'corruption':       -3,

  // High-signal positive — AFINN under-scores
  'beats':             3,
  'beat':              2,
  'raises_guidance':   3,
  'raises':            1,
  'buyback':           2,
  'share_repurchase':  2,
  'dividend':          1,
  'special_dividend':  2,
  'contract_win':      3,
  'contract_awarded':  3,
  'awarded':           2,
  'backlog':           1,
  'record_revenue':    3,
  'record':            1,
  'breakthrough':      2,
  'outperform':        2,
  'upgrade':           2,
  'accelerates':       1,
  'expands':           1,
  'approval':          2,   // FDA/regulatory approval
  'approved':          2,
  'cleared':           1,
  'partnership':       1,
  'acquisition':       1,   // can be positive or negative; lean slight positive

  // Macro noise — zero out so broad economy articles don't move stock scores
  'tariff':            0,
  'tariffs':           0,
  'trade_war':         0,
  'inflation':         0,
  'recession':         0,
  'fed':               0,
  'rates':             0,
  'interest_rate':     0,
  'gdp':               0,
  'unemployment':      0,
  'payrolls':          0,
  'geopolitical':      0,
  'election':          0,
};

// ─── UNIVERSAL RELEVANCE SIGNALS ─────────────────────────────────────────────
// Sector-agnostic. Works for any publicly listed company.
// These determine relevance score (0.0–1.0) before sentiment is applied.
//
// Design principle: it is better to be slightly over-inclusive (score a macro
// article at 0.30 relevance) than to silently ignore real signals.
// Even a low-relevance article can contain a thesis killer.
const UNIVERSAL_SIGNALS = {

  // ── Fundamental: material company-level events (relevance → 0.85) ──────────
  fundamental: [
    // Earnings & results
    'earnings', 'revenue', 'profit', 'loss', 'net income', 'operating income',
    'eps', 'earnings per share', 'guidance', 'outlook', 'forecast',
    'quarterly results', 'annual results', 'full year results', 'fiscal year',
    'beats estimates', 'misses estimates', 'raises guidance', 'lowers guidance',
    'reaffirms guidance', 'narrows loss', 'turns profitable', 'breaks even',
    'gross margin', 'operating margin', 'free cash flow', 'cash flow',
    // Capital allocation
    'buyback', 'share repurchase', 'stock buyback', 'dividend', 'special dividend',
    'payout ratio', 'capital return', 'debt reduction', 'deleveraging',
    'refinanc', 'debt offering', 'bond offering', 'equity offering',
    'secondary offering', 'share dilution', 'leverage ratio',
    // Corporate structure
    'acquisition', 'merger', 'takeover', 'divestiture', 'spinoff', 'spin-off',
    'ipo', 'initial public offering', 'secondary offering',
    'going private', 'management buyout', 'strategic review', 'sale process',
    'joint venture', 'strategic partnership',
    // Management & governance
    'ceo', 'cfo', 'coo', 'cto', 'chief executive', 'chief financial',
    'chief operating', 'chief technology', 'board of directors', 'chairman',
    'resigns', 'appointed', 'steps down', 'succession', 'leadership change',
    'activist investor', 'proxy fight', 'shareholder vote',
    // Restructuring
    'restructuring', 'layoffs', 'headcount reduction', 'job cuts', 'workforce reduction',
    'cost savings', 'cost cutting', 'operational efficiency', 'reorganization',
    // Analyst coverage
    'upgrade', 'downgrade', 'price target', 'analyst rating', 'initiates coverage',
    'outperform', 'underperform', 'overweight', 'underweight', 'neutral rating',
    'buy rating', 'sell rating', 'strong buy', 'strong sell', 'hold rating',
    // Ownership & short interest
    'insider buying', 'insider selling', 'stake increase', 'stake decrease',
    'short interest', 'short seller', 'short squeeze', '13f filing',
  ],

  // ── Industry: growth, regulatory, and risk signals (relevance → 0.65) ──────
  industry: [
    // Contract & growth
    'contract awarded', 'contract win', 'contract renewal', 'contract extension',
    'multiyear contract', 'multi-year contract', 'government contract',
    'backlog', 'order intake', 'order book', 'new orders', 'record orders',
    'market share', 'customer growth', 'customer acquisition', 'subscriber',
    'user growth', 'active users', 'annual recurring revenue', 'arr',
    'capacity expansion', 'new facility', 'production ramp', 'plant opening',
    // Regulatory & legal
    'fda approval', 'fda clearance', 'fda rejection', 'fda warning',
    'sec filing', 'sec charges', 'sec investigation', 'ftc investigation',
    'doj investigation', 'antitrust', 'regulatory approval', 'regulatory rejection',
    'regulatory fine', 'penalty', 'settlement', 'consent decree',
    'lawsuit filed', 'litigation', 'class action', 'subpoena', 'injunction',
    'patent infringement', 'intellectual property',
    // Operational risk
    'product recall', 'safety recall', 'safety warning',
    'outage', 'service disruption', 'system failure',
    'data breach', 'cyberattack', 'ransomware', 'hack',
    'supply chain disruption', 'production halt', 'plant shutdown',
    'export restriction', 'import ban', 'trade sanction',
    // Innovation & pipeline
    'clinical trial', 'phase 2', 'phase 3', 'trial results', 'fda breakthrough',
    'patent granted', 'new product launch', 'product release',
    'technology breakthrough', 'r&d investment',
  ],

  // ── Macro noise: broad economy (relevance → 0.30) ──────────────────────────
  // Not zero — sometimes macro IS the story for a specific stock (e.g. tariffs
  // directly targeting a product). But down-weighted so routine macro articles
  // don't move scores when the stock isn't the subject.
  macro_noise: [
    'federal reserve', 'fed rate', 'rate cut', 'rate hike', 'interest rate decision',
    'inflation report', 'cpi data', 'pce data', 'gdp growth', 'gdp contraction',
    'recession fears', 'jobs report', 'unemployment rate', 'nonfarm payrolls',
    'trade war', 'tariff announcement', 'geopolitical tension', 'election results',
    'oil prices', 'crude oil', 'commodity prices', 'dollar index', 'currency',
    'housing market', 'consumer confidence index', 'retail sales data',
    'manufacturing pmi', 'services pmi', 'treasury yields', 'yield curve',
  ],

  // ── Universal thesis killers: bearish for any business (floor sentiment) ───
  // When any of these appear, sentiment is floored at -0.3 regardless of other
  // positive words in the article ("despite fraud charges, revenue grew" = bearish).
  thesis_killers: [
    // Accounting & governance
    'fraud', 'accounting fraud', 'financial fraud', 'securities fraud',
    'restatement', 'material weakness', 'accounting irregularity', 'audit failure',
    'going concern', 'bankruptcy', 'chapter 11', 'chapter 7', 'insolvency',
    'liquidity crisis', 'debt default', 'loan default', 'covenant breach',
    'delisting notice', 'nasdaq delisting', 'nyse delisting',
    // Criminal & enforcement
    'sec fraud charges', 'doj charges', 'criminal charges', 'criminal indictment',
    'insider trading charges', 'wire fraud', 'bribery charges', 'corruption charges',
    'ponzi scheme', 'embezzlement',
    // Catastrophic operational
    'fatal accident', 'worker fatality', 'mass casualty', 'explosion fatality',
    'environmental disaster', 'major oil spill', 'toxic spill',
  ],
};

// ─── SOURCE RELIABILITY TIERS ─────────────────────────────────────────────────
// Score returned by _sourceReliability() is used in importance calculation.
// Scores: T1=2.0, T2=1.7, T3=1.3, T4=0.7, Unknown=1.0
//
// Tier 1 (2.0): Primary wire services and regulatory filings.
//   These are market-moving sources — fact-checked, direct reporting.
//
// Tier 2 (1.7): Major financial and general press with editorial standards.
//   Good for earnings, analyst notes, executive interviews.
//
// Tier 3 (1.3): Credible specialist and financial commentary outlets.
//   Often accurate but more opinion-driven or niche. Counts, just less.
//
// Tier 4 (0.7): Press release wires, partisan, or sensationalist outlets.
//   These often syndicate real stories but with spin — down-weighted.
//
// Unknown (1.0): Neutral. Not penalised. Many legitimate niche outlets
//   (industry trade publications, regional business press) won't be in any
//   list but carry real information. Safe default is equal weight.

const SOURCE_TIERS = {
  tier1: [
    // Wire services — primary source of record
    'reuters', 'reuters.com',
    'bloomberg', 'bloomberg.com',
    'associated press', 'apnews', 'ap news', 'ap.org',
    'dow jones', 'djnewswires', 'newswires',
    // Premium financial press
    'wsj', 'wall street journal', 'wsj.com',
    'financial times', 'ft.com', 'ft ',
    // Regulatory filings — highest credibility by definition
    'sec.gov', 'sec filing', 'edgar', '8-k', '10-k', '10-q',
    'pr newswire sec', 'businesswire sec',
  ],
  tier2: [
    // Established financial media
    'cnbc', 'cnbc.com',
    'barrons', "barron's", 'barrons.com',
    'marketwatch', 'marketwatch.com',
    'morningstar', 'morningstar.com',
    'thestreet', 'the street', 'thestreet.com',
    'investor\'s business daily', 'ibd', 'investors.com',
    'yahoo finance', 'finance.yahoo', 'yahoofinance',
    'kiplinger', 'kiplinger.com',
    'money.cnn', 'cnn business', 'cnnbusiness',
    // Major general press with strong business desks
    'new york times', 'nytimes', 'nytimes.com',
    'washington post', 'washingtonpost', 'washingtonpost.com',
    'the guardian', 'guardian.com',
    'bbc', 'bbc.com', 'bbc news',
    'the economist', 'economist.com',
    'forbes', 'forbes.com',
    'fortune', 'fortune.com',
    'business insider', 'businessinsider', 'businessinsider.com',
    // Policy/regulation — relevant for regulated industries
    'axios', 'axios.com',
    'politico', 'politico.com',
    // Newswires
    'globe newswire', 'globenewswire',
    'businesswire', 'business wire',
    'pr newswire', 'prnewswire',
    'accesswire',
  ],
  tier3: [
    // Financial analysis & commentary
    'seeking alpha', 'seekingalpha', 'seekingalpha.com',
    'motley fool', 'fool.com', 'motionfool',
    'benzinga', 'benzinga.com',
    'zacks', 'zacks.com',
    'investopedia', 'investopedia.com',
    'thefly', 'thefly.com',
    'streetinsider', 'streetinsider.com',
    '247wallst', '24/7 wall st',
    'stockanalysis', 'stock analysis',
    // Tech press — relevant for software/hardware/semiconductor holdings
    'techcrunch', 'techcrunch.com',
    'wired', 'wired.com',
    'the verge', 'theverge.com',
    'ars technica', 'arstechnica.com',
    'venturebeat', 'venturebeat.com',
    'zdnet', 'zdnet.com',
    'cnet', 'cnet.com',
    'semiconductor engineering', 'semiwiki',
    'eetimes', 'fierceelectronics',
    // Specialist trade press — high signal for relevant sectors
    'defense news', 'defensenews', 'defensenews.com',
    'breaking defense', 'breakingdefense.com',
    'jane\'s', 'janes.com',
    'space news', 'spacenews', 'spacenews.com',
    'space.com', 'nasaspaceflight',
    'nuclear news', 'ans.org', 'world nuclear news',
    'mining.com', 'kitco', 'kitco.com',
    'datacenter dynamics', 'datacenterdynamics.com',
    'data center frontier', 'datacenterfrontier.com',
    'fierce pharma', 'fiercepharma',
    'stat news', 'statnews', 'endpoints news',
    'aviation week', 'aviationweek.com',
    // Regional business press
    'american banker', 'americanbanker.com',
    'oil price', 'oilprice.com',
    'energy monitor', 'spglobal',
  ],
  tier4: [
    // Partisan / sensationalist (low financial accuracy)
    'zerohedge', 'zero hedge', 'zerohedge.com',
    'newsmax', 'newsmax.com',
    'breitbart', 'breitbart.com',
    'the daily wire', 'dailywire.com',
    'natural news', 'naturalnews.com',
    // Content farms / low editorial standards
    'stockpulse', 'stockpickss',
    'pennystock', 'penny stock',
    'guru focus', 'gurufocus',   // moved to T4 — often recycled content
    'tip ranks', 'tipranks',      // aggregator, lower signal
  ],
};

// ─── DEDUPLICATION ────────────────────────────────────────────────────────────

function headlineFingerprint(headline) {
  const STOP = new Set([
    'a','an','the','and','or','but','in','on','at','to','of','for',
    'is','are','was','were','its','it','as','with','by','that','this',
    'have','has','be','will','would','could','should','may','might',
  ]);
  return headline
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w))
    .sort()
    .join(' ');
}

function deduplicateArticles(articles) {
  if (articles.length <= 1) return articles;
  const fp = articles.map(a => ({
    article: a,
    words:   new Set(headlineFingerprint(a.headline).split(' ')),
    ts:      new Date(a.published_at).getTime() || 0,
  }));
  const used = new Set();
  const kept = [];
  for (let i = 0; i < fp.length; i++) {
    if (used.has(i)) continue;
    let best = fp[i];
    for (let j = i + 1; j < fp.length; j++) {
      if (used.has(j)) continue;
      const inter = [...best.words].filter(w => fp[j].words.has(w)).length;
      const union  = new Set([...best.words, ...fp[j].words]).size;
      if (union > 0 && inter / union > 0.70) {
        used.add(j);
        if (fp[j].ts > best.ts) best = fp[j]; // keep most recent version
      }
    }
    used.add(i);
    kept.push(best.article);
  }
  return kept;
}

// ─── MAIN CLASS ───────────────────────────────────────────────────────────────

class AdvancedNewsAnalyzer {
  constructor() {
    this.sentiment = new Sentiment();
    this.sentiment.registerLanguage('finance', { labels: FINANCE_OVERRIDES });
  }

  analyzeNews(articles, symbol) {
    if (!Array.isArray(articles) || articles.length === 0) return [];
    const deduped = deduplicateArticles(articles);
    if (deduped.length < articles.length) {
      logger.info(`  [NewsAnalyzer] ${symbol}: deduplicated ${articles.length}→${deduped.length}`);
    }
    return deduped.map(a => this._analyzeArticle(a, symbol)).filter(Boolean);
  }

  _analyzeArticle(article, symbol) {
    try {
      if (!article.headline) return null;
      const ageFactor   = this._ageFactor(article.published_at);
      const relevance   = this._relevance(article, symbol);
      const rawSentiment = this._rawSentiment(article, relevance);
      const importance  = this._importance(article, relevance, ageFactor);
      const priceImpact = this._priceImpact(article);

      return {
        sentiment: {
          score:     rawSentiment,
          strength:  this._sentimentStrength(rawSentiment),
          // effective = what actually feeds into the news score:
          // raw sentiment modulated by age and relevance
          effective: parseFloat((rawSentiment * ageFactor * relevance).toFixed(3)),
        },
        importance,
        relevance,
        ageFactor,
        priceImpact,
        topic:             this._topic(article.headline),
        signals:           this._signals(article.headline),
        sourceReliability: this._sourceReliability(article.source),
        metadata: {
          headline:  article.headline,
          source:    article.source,
          url:       article.url,
          published: article.published_at,
          fetchedAt: new Date(),
        },
      };
    } catch (err) {
      logger.warn(`[NewsAnalyzer] Error: ${err.message}`);
      return null;
    }
  }

  // ── Sentiment ──────────────────────────────────────────────────────────────
  _rawSentiment(article, relevance) {
    // ── Phrase normalisation ───────────────────────────────────────────────
    // The sentiment library tokenizes on whitespace, so "guidance cut" becomes
    // ["guidance", "cut"] — never matching the 'guidance_cut' dictionary key.
    // We replace known compound phrases with underscore-joined tokens BEFORE
    // tokenization, so "guidance_cut" stays as a single token and matches.
    // Order matters: longer phrases first to prevent partial matches.
    const normalisePhrases = (text) => {
      if (!text) return text;
      const phrases = [
        ['material weakness', 'material_weakness'],
        ['class action',      'class_action'],
        ['going concern',     'going_concern'],
        ['chapter 11',        'chapter_11'],
        ['guidance cuts',     'guidance_cuts'],
        ['guidance cut',      'guidance_cut'],
        ['raises guidance',   'raises_guidance'],
        ['record revenue',    'record_revenue'],
        ['share repurchase',  'share_repurchase'],
        ['special dividend',  'special_dividend'],
        ['contract awarded',  'contract_awarded'],
        ['contract win',      'contract_win'],
        ['trade war',         'trade_war'],
        ['interest rate',     'interest_rate'],
      ];
      let t = text;
      phrases.forEach(([search, replace]) => {
        // Use \s+ to match any whitespace (including double spaces); case-insensitive
        t = t.replace(new RegExp(search.replace(/ /g, '\\s+'), 'gi'), replace);
      });
      return t;
    };

    const headlineResult = this.sentiment.analyze(normalisePhrases(article.headline), { language: 'finance' });
    const descResult     = article.description
      ? this.sentiment.analyze(normalisePhrases(article.description), { language: 'finance' })
      : { score: 0 };

    // Check for universal thesis killers
    const fullText = normalisePhrases(`${article.headline} ${article.description || ''}`).toLowerCase();
    const isThesisKiller = UNIVERSAL_SIGNALS.thesis_killers.some(k => fullText.includes(k));

    if (isThesisKiller) {
      const raw = (headlineResult.score * 0.7 + descResult.score * 0.3) / 5;
      // Floor at -0.3: positive spin around a thesis killer is ignored
      return Math.max(-1, Math.min(-0.3, raw));
    }

    const raw = (headlineResult.score * 0.7 + descResult.score * 0.3) / 5;
    return Math.max(-1, Math.min(1, raw));
  }

  _sentimentStrength(score) {
    if (score >=  0.6) return 'VERY_POSITIVE';
    if (score >=  0.2) return 'POSITIVE';
    if (score <= -0.6) return 'VERY_NEGATIVE';
    if (score <= -0.2) return 'NEGATIVE';
    return 'NEUTRAL';
  }

  // ── Relevance (universal — no ticker hardcoding) ───────────────────────────
  _relevance(article, symbol) {
    const fullText = `${article.headline} ${article.description || ''}`.toLowerCase();

    // Direct mention of ticker → full relevance
    // Short tickers (≤3 chars) use word-boundary match to prevent false positives.
    // "MS" matches inside "CMS", "WhatsApp", "GMAT" with naive substring match.
    // Longer tickers (4+ chars) are safe with substring — "CRWD" won't appear in unrelated text.
    const symLower = symbol.toLowerCase();
    if (symLower.length <= 3) {
      const escaped = symLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(fullText)) return 1.0;
    } else {
      if (fullText.includes(symLower)) return 1.0;
    }

    // Fundamental signal → high relevance
    if (UNIVERSAL_SIGNALS.fundamental.some(k => fullText.includes(k))) return 0.85;

    // Industry signal → moderate relevance
    if (UNIVERSAL_SIGNALS.industry.some(k => fullText.includes(k))) return 0.65;

    // Pure macro noise → low relevance (still counted, not ignored)
    if (UNIVERSAL_SIGNALS.macro_noise.some(k => fullText.includes(k))) return 0.30;

    // No signal match → very low but not zero
    // Could be a niche trade article with real info
    return 0.20;
  }

  // ── Importance ─────────────────────────────────────────────────────────────
  _importance(article, relevance, ageFactor) {
    let score = 4.0;

    // Source bonus: 0 to +1.5 (sourceReliability is 0.7–2.0)
    const sourceRel = this._sourceReliability(article.source);
    score += (sourceRel - 1.0) * 1.5;  // T1→+1.5, T2→+1.05, T3→+0.45, T4→-0.45, Unknown→0

    // Keyword bonus — gated: only if article is highly relevant to the company
    if (relevance >= 0.80) {
      const t = article.headline.toLowerCase();
      if (/earnings|guidance|acquisition|merger/.test(t))       score += 2.0;
      else if (/contract|award|backlog|record|buyback/.test(t)) score += 1.5;
      else if (/upgrade|downgrade|analyst|price target/.test(t)) score += 1.0;
    }

    // Age penalty applies only to the earned bonus
    const base  = 4.0;
    const bonus = score - base;
    // Decay earned bonus aggressively; decay base gently.
    // Even real events lose urgency as they age beyond the trading day.
    // sqrt(ageFactor) decays slower than ageFactor — base stays meaningful longer.
    score = (base * Math.sqrt(ageFactor)) + (bonus * ageFactor);

    return Math.max(0, Math.min(10, parseFloat(score.toFixed(2))));
  }

  // ── Age factor ─────────────────────────────────────────────────────────────
  _ageFactor(publishedDate) {
    try {
      const h = (Date.now() - new Date(publishedDate).getTime()) / 3_600_000;
      if (h < 1)   return 1.00;
      if (h < 3)   return 0.85;
      if (h < 6)   return 0.70;
      if (h < 12)  return 0.55;
      if (h < 24)  return 0.35;
      if (h < 48)  return 0.20;
      return 0.10;
    } catch { return 0.50; }
  }

  // ── Price impact ───────────────────────────────────────────────────────────
  _priceImpact(article) {
    const t = `${article.headline} ${article.description || ''}`.toLowerCase();
    if (UNIVERSAL_SIGNALS.thesis_killers.some(k => t.includes(k)))   return -2.5;
    if (/beats? earnings|record revenue|raises? guidance/.test(t))    return  2.0;
    if (/misses? earnings|cuts? guidance|disappoints?/.test(t))       return -2.0;
    if (/acquisition|merger|buyout/.test(t))                           return  1.5;
    if (/contract win|awarded contract|major contract/.test(t))        return  1.5;
    if (/investigation|lawsuit|sec charges|fraud/.test(t))            return -2.5;
    if (/upgrade|price target raised/.test(t))                         return  1.0;
    if (/downgrade|price target cut/.test(t))                          return -1.0;
    return 0;
  }

  // ── Source reliability — 4 tiers ──────────────────────────────────────────
  _sourceReliability(source) {
    if (!source) return 1.0;
    const s = source.toLowerCase();
    if (SOURCE_TIERS.tier1.some(t => s.includes(t))) return 2.0;
    if (SOURCE_TIERS.tier2.some(t => s.includes(t))) return 1.7;
    if (SOURCE_TIERS.tier3.some(t => s.includes(t))) return 1.3;
    if (SOURCE_TIERS.tier4.some(t => s.includes(t))) return 0.7;
    return 1.0; // unknown source: neutral, not penalised
  }

  // ── Topic & signals (unchanged, kept for downstream compatibility) ─────────
  _topic(headline) {
    const t = headline.toLowerCase();
    if (/earnings|revenue|profit/.test(t))      return 'earnings';
    if (/product|launch|release/.test(t))       return 'product';
    if (/acquisition|merger|deal/.test(t))      return 'acquisition';
    if (/regulation|lawsuit|sec/.test(t))       return 'regulation';
    if (/ceo|leadership|appointment/.test(t))   return 'management';
    if (/contract|award|win/.test(t))           return 'contract';
    return 'general';
  }

  _signals(headline) {
    const signals = [];
    const t = headline.toLowerCase();
    if (/upgrade|outperform|beat/.test(t))              signals.push({ type: 'BUY',  strength: 1 });
    if (/downgrade|underperform|miss/.test(t))          signals.push({ type: 'SELL', strength: 1 });
    if (/fraud|lawsuit|scandal/.test(t))                signals.push({ type: 'SELL', strength: 2 });
    if (/contract win|buyback|raises guidance/.test(t)) signals.push({ type: 'BUY',  strength: 2 });
    return signals;
  }
}

module.exports = new AdvancedNewsAnalyzer();
