'use strict';

/**
 * ADVANCED NEWS ANALYZER — v2
 *
 * Fixes from v1:
 *   1. Financial-context sentiment: word list overrides for investor-relevant
 *      terms that the general `sentiment` library scores incorrectly.
 *   2. Deduplication: syndicated copies of the same story are collapsed before
 *      scoring so one Reuters wire doesn't count 3 times.
 *   3. Importance formula rebuilt: source and keyword bonuses are gated so
 *      a Bloomberg earnings article doesn't auto-max regardless of content.
 *   4. Ticker-specific keyword dictionaries: each holding has a small set of
 *      signals that matter for its thesis (backlog for AGX, contract for BWXT,
 *      etc.). These gate relevance so macro noise is filtered out.
 *   5. ageFactor and estimatePriceImpact are now wired into the final score
 *      instead of being orphaned computed-but-unused values.
 */

const Sentiment = require('sentiment');
const logger    = require('./logger');

// ─── FINANCIAL WORD OVERRIDES ────────────────────────────────────────────────
// The `sentiment` library uses a general-purpose AFINN word list that
// mis-scores investor-relevant language. These overrides correct the most
// common false signals for equity analysis.
//
// Positive (+2): investor-bullish terms
// Negative (-2): investor-bearish terms
// Zero (0): words AFINN scores wrong that should be neutral in finance context
//
const FINANCE_OVERRIDES = {
  // Terms AFINN scores negative but are often investor-bullish
  'cuts':           0,   // "cuts costs" = bullish; AFINN = -1
  'cut':            0,
  'layoffs':        0,   // "layoffs signal cost discipline" context-dependent
  'restructuring':  0,   // strategic, not distress by default
  'charges':        0,   // "one-time charges" = neutral
  'writedown':     -2,   // genuine impairment — keep negative
  'impairment':    -2,
  'miss':          -2,   // "earnings miss" — genuinely bad
  'misses':        -2,
  'disappoints':   -2,
  'disappointing': -2,

  // Terms AFINN scores positive but are investor-bearish
  'probe':         -2,   // "SEC probe" — AFINN misses this
  'investigation': -2,
  'subpoena':      -3,
  'lawsuit':       -2,
  'class action':  -3,
  'fraud':         -3,
  'restatement':   -3,   // accounting restatement = serious
  'recall':        -2,
  'downgrade':     -2,
  'guidance cut':  -3,

  // High-signal positive finance terms AFINN under-scores
  'beats':          3,   // "beats earnings"
  'beat':           2,
  'raises guidance': 3,
  'raises':         1,   // context-dependent but lean positive
  'buyback':        2,   // share repurchase = bullish signal
  'dividend':       1,
  'contract win':   3,
  'awarded':        2,   // "awarded contract"
  'backlog':        1,   // order backlog growth
  'record revenue': 3,
  'record':         1,
  'breakthrough':   2,
  'outperform':     2,
  'upgrade':        2,
  'accelerates':    1,
  'expands':        1,

  // Macro noise words — should not move individual stock scores
  'tariff':         0,
  'tariffs':        0,
  'trade war':      0,
  'inflation':      0,
  'recession':      0,   // macro context, not company-specific
  'fed':            0,
  'rates':          0,
  'interest rate':  0,
};

// ─── TICKER-SPECIFIC SIGNAL DICTIONARIES ─────────────────────────────────────
// Maps each holding to the terms that actually matter for its thesis.
// An article scores as "relevant" only if it contains at least one of these
// terms OR contains the company name/ticker directly.
// If no match, relevance is reduced (article is probably sector/macro noise).
//
// Also contains "thesis_killers" — terms that should heavily penalise
// a stock regardless of general sentiment (thesis-specific red flags).
//
const TICKER_CONTEXT = {
  AGX: {
    name: 'Argan',
    sector: 'EPC / Power Construction',
    key_signals: ['backlog', 'contract', 'power plant', 'construction', 'epc', 'revenue', 'project', 'awarded', 'completion', 'natural gas', 'data center power'],
    thesis_killers: ['project delay', 'cost overrun', 'contract cancellation', 'backlog decline', 'backlog decreased'],
  },
  ASTS: {
    name: 'AST SpaceMobile',
    sector: 'Satellite Connectivity',
    key_signals: ['satellite', 'launch', 'bluebird', 'coverage', 'broadband', 'spectrum', 'fcc', 'partner', 'subscriber'],
    thesis_killers: ['launch failure', 'fcc denied', 'funding', 'dilution', 'going concern'],
  },
  BWXT: {
    name: 'BWX Technologies',
    sector: 'Nuclear Defense / Energy',
    key_signals: ['nuclear', 'contract', 'navy', 'naval', 'reactor', 'doe', 'department of energy', 'defense', 'microreactor', 'propulsion'],
    thesis_killers: ['contract loss', 'safety violation', 'regulatory', 'nuclear incident'],
  },
  CRWD: {
    name: 'CrowdStrike',
    sector: 'Cybersecurity',
    key_signals: ['arr', 'annual recurring revenue', 'endpoint', 'threat', 'breach', 'platform', 'falcon', 'customer', 'module', 'net retention'],
    thesis_killers: ['breach', 'outage', 'customer churn', 'arr decline', 'competition wins'],
  },
  FTAI: {
    name: 'FTAI Aviation',
    sector: 'Aviation Leasing / MRO',
    key_signals: ['lease', 'aircraft', 'engine', 'cfm', 'maintenance', 'mro', 'fleet', 'utilization', 'aftermarket'],
    thesis_killers: ['lease default', 'aircraft grounding', 'engine recall', 'fleet reduction'],
  },
  GEV: {
    name: 'GE Vernova',
    sector: 'Power / Energy Transition',
    key_signals: ['grid', 'turbine', 'wind', 'gas turbine', 'electrification', 'backlog', 'order', 'power', 'data center', 'nuclear'],
    thesis_killers: ['wind cancellation', 'backlog decline', 'turbine defect', 'project write'],
  },
  KTOS: {
    name: 'Kratos Defense',
    sector: 'Defense / Drones',
    key_signals: ['drone', 'contract', 'dod', 'department of defense', 'tactical', 'missile', 'hypersonic', 'radar', 'space'],
    thesis_killers: ['contract loss', 'program cancelled', 'budget cut'],
  },
  LLY: {
    name: 'Eli Lilly',
    sector: 'Pharmaceuticals',
    key_signals: ['mounjaro', 'zepbound', 'glp-1', 'obesity', 'diabetes', 'fda', 'approval', 'trial', 'pipeline', 'revenue'],
    thesis_killers: ['fda rejection', 'trial failure', 'safety recall', 'patent loss', 'biosimilar'],
  },
  MU: {
    name: 'Micron',
    sector: 'Semiconductors / Memory',
    key_signals: ['dram', 'nand', 'hbm', 'high bandwidth memory', 'ai', 'data center', 'bit growth', 'pricing', 'inventory'],
    thesis_killers: ['inventory glut', 'price decline', 'china ban', 'export restriction', 'customer pushout'],
  },
  RKLB: {
    name: 'Rocket Lab',
    sector: 'Space Launch',
    key_signals: ['launch', 'electron', 'neutron', 'contract', 'manifest', 'satellite', 'space systems', 'backlog'],
    thesis_killers: ['launch failure', 'rocket anomaly', 'contract loss', 'neutron delay'],
  },
  SCCO: {
    name: 'Southern Copper',
    sector: 'Mining / Copper',
    key_signals: ['copper', 'production', 'mine', 'peru', 'mexico', 'output', 'expansion', 'commodity'],
    thesis_killers: ['mine closure', 'strike', 'production halt', 'environmental shutdown', 'nationalization'],
  },
  TPL: {
    name: 'Texas Pacific Land',
    sector: 'Land / Royalties',
    key_signals: ['royalty', 'water', 'permian', 'oil', 'gas', 'acreage', 'surface', 'production'],
    thesis_killers: ['production decline', 'permian slowdown', 'water dispute'],
  },
  VRT: {
    name: 'Vertiv',
    sector: 'Data Center Infrastructure',
    key_signals: ['data center', 'cooling', 'power', 'hyperscaler', 'backlog', 'order', 'ai infrastructure', 'thermal'],
    thesis_killers: ['order cancellation', 'backlog decline', 'hyperscaler pullback', 'supply chain'],
  },
  // Generic fallback for tickers not explicitly listed
  _DEFAULT: {
    name: '',
    sector: '',
    key_signals: ['revenue', 'earnings', 'profit', 'growth', 'guidance', 'contract', 'acquisition'],
    thesis_killers: ['fraud', 'restatement', 'sec investigation', 'going concern', 'bankruptcy'],
  },
};

// ─── DEDUPLICATION HELPERS ───────────────────────────────────────────────────

/**
 * Normalise a headline to a fingerprint for deduplication.
 * Strips punctuation, lowercases, removes very common words, sorts remaining
 * words alphabetically so "X beats Y estimates" == "Y estimates beaten by X".
 */
function headlineFingerprint(headline) {
  const STOP = new Set(['a','an','the','and','or','but','in','on','at','to','of','for','is','are','was','were','its','it','as','with','by','that','this','have','has','be']);
  return headline
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w))
    .sort()
    .join(' ');
}

/**
 * Deduplicate articles by headline fingerprint similarity.
 * Two articles with > 70% word overlap are treated as the same story.
 * Returns the deduplicated array, keeping the most recent version of each story.
 */
function deduplicateArticles(articles) {
  if (articles.length <= 1) return articles;

  const fingerprints = articles.map(a => ({
    article: a,
    fp: headlineFingerprint(a.headline),
    words: new Set(headlineFingerprint(a.headline).split(' ')),
    ts: new Date(a.published_at).getTime() || 0,
  }));

  const kept = [];
  const used = new Set();

  for (let i = 0; i < fingerprints.length; i++) {
    if (used.has(i)) continue;
    let canonical = fingerprints[i];

    for (let j = i + 1; j < fingerprints.length; j++) {
      if (used.has(j)) continue;
      const fj = fingerprints[j];
      // Jaccard similarity between word sets
      const intersection = [...canonical.words].filter(w => fj.words.has(w)).length;
      const union        = new Set([...canonical.words, ...fj.words]).size;
      const similarity   = union > 0 ? intersection / union : 0;

      if (similarity > 0.70) {
        used.add(j);
        // Keep the more recent version
        if (fj.ts > canonical.ts) canonical = fj;
      }
    }
    used.add(i);
    kept.push(canonical.article);
  }

  return kept;
}

// ─── MAIN ANALYZER CLASS ──────────────────────────────────────────────────────

class AdvancedNewsAnalyzer {
  constructor() {
    this.sentiment = new Sentiment();
    // Register financial overrides with the sentiment library
    this.sentiment.registerLanguage('finance', {
      labels: FINANCE_OVERRIDES,
    });
  }

  // ── Public entry point ─────────────────────────────────────────────────────
  analyzeNews(articles, symbol) {
    if (!Array.isArray(articles) || articles.length === 0) return [];

    // Step 1: deduplicate before scoring (fixes Problem 2)
    const deduped = deduplicateArticles(articles);

    if (deduped.length < articles.length) {
      logger.info(`  [NewsAnalyzer] ${symbol}: deduplicated ${articles.length} → ${deduped.length} articles`);
    }

    return deduped
      .map(article => this._analyzeArticle(article, symbol))
      .filter(Boolean);
  }

  // ── Per-article analysis ───────────────────────────────────────────────────
  _analyzeArticle(article, symbol) {
    try {
      if (!article.headline) return null;

      const context     = TICKER_CONTEXT[symbol] || TICKER_CONTEXT._DEFAULT;
      const ageFactor   = this._ageFactor(article.published_at);           // 0.10–1.0
      const relevance   = this._relevance(article, symbol, context);        // 0.0–1.0
      const sentiment   = this._sentiment(article, context);                // -1.0–1.0
      const importance  = this._importance(article, relevance, ageFactor);  // 0–10 (fixed formula)
      const priceImpact = this._priceImpact(article, context);             // -3 to +3

      return {
        sentiment: {
          score:     sentiment,
          strength:  this._sentimentStrength(sentiment),
          // ageFactor now modulates the effective sentiment (fixes Problem 5)
          effective: parseFloat((sentiment * ageFactor * relevance).toFixed(3)),
        },
        importance,
        relevance,
        ageFactor,
        priceImpact,
        topic:             this._topic(article.headline),
        signals:           this._signals(article.headline),
        sourceReliability: this._sourceReliability(article.source),
        metadata: {
          headline:    article.headline,
          source:      article.source,
          url:         article.url,
          published:   article.published_at,
          fetchedAt:   new Date(),
        },
      };
    } catch (err) {
      logger.warn(`[NewsAnalyzer] Article analysis error: ${err.message}`);
      return null;
    }
  }

  // ── Sentiment (fixes Problem 1) ────────────────────────────────────────────
  // Uses financial override labels via the registered language.
  // Scores headline at 0.7 weight, description at 0.3.
  _sentiment(article, context) {
    const headlineScore = this.sentiment.analyze(article.headline, { language: 'finance' });
    const descScore     = article.description
      ? this.sentiment.analyze(article.description, { language: 'finance' })
      : { score: 0 };

    // Check for thesis killers — these override positive sentiment
    const fullText = `${article.headline} ${article.description || ''}`.toLowerCase();
    const hasThesisKiller = context.thesis_killers?.some(k => fullText.includes(k.toLowerCase()));
    if (hasThesisKiller) {
      // Hard floor: thesis killer can't score above -0.3 regardless of other words
      const raw = (headlineScore.score * 0.7 + descScore.score * 0.3) / 5;
      return Math.max(-1, Math.min(-0.3, raw));
    }

    const raw = (headlineScore.score * 0.7 + descScore.score * 0.3) / 5;
    return Math.max(-1, Math.min(1, raw));
  }

  _sentimentStrength(score) {
    if (score >=  0.6) return 'VERY_POSITIVE';
    if (score >=  0.2) return 'POSITIVE';
    if (score <= -0.6) return 'VERY_NEGATIVE';
    if (score <= -0.2) return 'NEGATIVE';
    return 'NEUTRAL';
  }

  // ── Relevance (fixes Problem 4) ────────────────────────────────────────────
  // An article is fully relevant if it mentions the company/ticker directly
  // or contains one of the ticker's key signal terms.
  // Macro-only articles (tariffs, fed, etc.) get reduced relevance.
  _relevance(article, symbol, context) {
    const fullText = `${article.headline} ${article.description || ''}`.toLowerCase();

    // Direct mention of ticker or company name = full relevance
    if (
      fullText.includes(symbol.toLowerCase()) ||
      (context.name && fullText.includes(context.name.toLowerCase()))
    ) return 1.0;

    // Contains a thesis-relevant signal term = high relevance
    const hasKeySignal = context.key_signals?.some(k => fullText.includes(k.toLowerCase()));
    if (hasKeySignal) return 0.8;

    // General financial keywords (earnings, revenue, etc.) = moderate
    const GENERAL_FINANCE = ['earnings', 'revenue', 'profit', 'guidance', 'analyst', 'upgrade', 'downgrade'];
    if (GENERAL_FINANCE.some(k => fullText.includes(k))) return 0.5;

    // Macro-only article (tariff, Fed, inflation) = low relevance
    // The stock score shouldn't move much from broad macro news
    return 0.25;
  }

  // ── Importance (fixes Problem 3) ───────────────────────────────────────────
  // Rebuilt to avoid double-counting and auto-maxing.
  // Base = 4 (not 5, leaving more room to move)
  // Source bonus = max +1.5 (not +2)
  // Keyword bonus = max +2 (gated: only if relevance >= 0.8)
  // Age factor reduces importance for old articles
  // Final range: 0–10
  _importance(article, relevance, ageFactor) {
    let score = 4.0;

    // Source quality bonus: scaled from reliability score
    // Tier 1 (2.0) → +1.5 bonus | Tier 2 (1.7) → +1.05 | Tier 3 (1.3) → +0.45
    // Tier 4 (0.7) → -0.45 (slight penalty) | Unknown (1.0) → 0 (no change)
    const sourceRel = this._sourceReliability(article.source);
    score += (sourceRel - 1.0) * 1.5;  // maps 0.7–2.0 → -0.45 to +1.5

    // High-signal keywords: only if the article is actually relevant to the thesis
    if (relevance >= 0.8) {
      const text = article.headline.toLowerCase();
      if (/earnings|guidance|acquisition|merger/.test(text)) score += 2.0;
      else if (/contract|award|win|backlog|record/.test(text)) score += 1.5;
      else if (/upgrade|downgrade|analyst/.test(text)) score += 1.0;
    }

    // Age penalty: stale articles matter less
    // ageFactor ranges 0.10–1.0; multiply the bonus portion only
    const bonus = score - 4.0;
    score = 4.0 + (bonus * ageFactor);

    return Math.max(0, Math.min(10, parseFloat(score.toFixed(2))));
  }

  // ── Age factor (now wired in — fixes Problem 5) ───────────────────────────
  // Returns 0.10–1.00. Breaking (<1h) = 1.0. Day-old = 0.30. Stale (>48h) = 0.10.
  _ageFactor(publishedDate) {
    try {
      const ageHours = (Date.now() - new Date(publishedDate).getTime()) / 3_600_000;
      if (ageHours < 1)   return 1.00;
      if (ageHours < 3)   return 0.85;
      if (ageHours < 6)   return 0.70;
      if (ageHours < 12)  return 0.55;
      if (ageHours < 24)  return 0.35;
      if (ageHours < 48)  return 0.20;
      return 0.10;
    } catch {
      return 0.50;
    }
  }

  // ── Price impact estimate (now wired in — fixes Problem 5) ────────────────
  // Used as a tiebreaker signal, not a primary score driver.
  _priceImpact(article, context) {
    const text = `${article.headline} ${article.description || ''}`.toLowerCase();

    if (context.thesis_killers?.some(k => text.includes(k))) return -2.5;
    if (/beats? earnings|record revenue|raises? guidance/.test(text)) return 2.0;
    if (/misses? earnings|cuts? guidance|disappoints?/.test(text))    return -2.0;
    if (/acquisition|merger|buyout/.test(text))                        return 1.5;
    if (/fraud|investigation|lawsuit|restatement/.test(text))         return -2.5;
    if (/contract win|awarded contract/.test(text))                    return 1.5;
    return 0;
  }

  // ── Supporting classifiers (unchanged logic, kept for compatibility) ───────
  _topic(headline) {
    const t = headline.toLowerCase();
    if (/earnings|revenue|profit/.test(t)) return 'earnings';
    if (/product|launch|release/.test(t))  return 'product';
    if (/acquisition|merger|deal/.test(t)) return 'acquisition';
    if (/regulation|lawsuit|sec/.test(t))  return 'regulation';
    if (/ceo|leadership|appointment/.test(t)) return 'management';
    if (/contract|award|win/.test(t))      return 'contract';
    return 'general';
  }

  _signals(headline) {
    const signals = [];
    const t = headline.toLowerCase();
    if (/upgrade|outperform|beat/.test(t))      signals.push({ type: 'BUY',  strength: 1 });
    if (/downgrade|underperform|miss/.test(t))  signals.push({ type: 'SELL', strength: 1 });
    if (/fraud|lawsuit|scandal/.test(t))        signals.push({ type: 'SELL', strength: 2 });
    if (/contract win|buyback|raises guidance/.test(t)) signals.push({ type: 'BUY', strength: 2 });
    return signals;
  }

  _sourceReliability(source) {
    if (!source) return 1.0;
    const s = source.toLowerCase();

    // Tier 1 (score: 2.0) — Primary financial wire services and institutional press.
    // These are the sources that move markets. Direct reporting, fact-checked,
    // first to break material company news.
    const TIER1 = [
      'reuters', 'bloomberg', 'wsj', 'wall street journal',
      'financial times', 'ft.com', 'ft ',
      'associated press', 'ap news', 'apnews',
      'dow jones', 'newswires',
      'sec.gov', 'sec filing', 'edgar',       // regulatory filings = highest credibility
    ];

    // Tier 2 (score: 1.7) — Major financial media with editorial standards.
    // Good for earnings coverage, analyst notes, CEO interviews.
    const TIER2 = [
      'cnbc', 'barrons', "barron's",
      'marketwatch', 'morningstar',
      'forbes', 'fortune', 'business insider', 'businessinsider',
      'the economist', 'economist',
      'new york times', 'nytimes',
      'washington post', 'washingtonpost',
      'axios', 'politico',                    // policy/regulation coverage
      'yahoo finance', 'finance.yahoo',
      'investor\'s business daily', 'ibd',
      'thestreet', 'the street',
    ];

    // Tier 3 (score: 1.3) — Credible financial commentary and specialist outlets.
    // Often accurate but more opinion-driven or niche. Still worth counting.
    const TIER3 = [
      'seeking alpha', 'seekingalpha',
      'motley fool', 'fool.com',
      'benzinga',
      'zacks', 'zacks.com',
      'investopedia',
      'techcrunch',                           // relevant for tech holdings
      'wired',
      'defense news', 'defensenews',          // relevant for KTOS, BWXT
      'space news', 'spacenews',              // relevant for RKLB, ASTS
      'nuclear news', 'ans.org',              // relevant for BWXT
      'mining.com', 'kitco',                  // relevant for SCCO
      'datacenter dynamics', 'datacenter',   // relevant for VRT, GEV
      'fierceelectronics', 'eetimes',         // relevant for MU
    ];

    // Tier 4 (score: 0.7) — Low-credibility, aggregators, content farms, or
    // unknown sources. Still scored (not ignored) because even a low-quality
    // source can syndicate a real story — but weighted down significantly.
    // Any source not matched above also falls here as the safe default.
    const TIER4 = [
      'prweb', 'pr newswire', 'prnewswire',   // press releases — company spin
      'globe newswire', 'globenewswire',
      'businesswire', 'business wire',
      'accesswire',
      'newsmax', 'breitbart',                  // partisan, low financial accuracy
      'zerohedge', 'zero hedge',               // sensationalist
    ];

    if (TIER1.some(t => s.includes(t))) return 2.0;
    if (TIER2.some(t => s.includes(t))) return 1.7;
    if (TIER3.some(t => s.includes(t))) return 1.3;
    if (TIER4.some(t => s.includes(t))) return 0.7;

    // Unknown source: return 1.0 (neutral weight, not penalised, not boosted)
    // This prevents unknown stock-specific outlets from being silently ignored
    return 1.0;
  }
}

// ─── UPDATED SCORE FORMULA ─────────────────────────────────────────────────
// The calling code in news-update.js uses item.sentiment.score.
// This is now replaced by item.sentiment.effective which already has
// ageFactor and relevance baked in. The news-update.js scoring loop
// should use .effective instead of .score for better signal quality.
//
// For backward compat, .score is still set to the raw value.
// The effective score is the one that should drive news_score calculation.

module.exports = new AdvancedNewsAnalyzer();
