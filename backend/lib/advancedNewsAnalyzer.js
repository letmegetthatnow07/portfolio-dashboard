/**
 * Advanced News Analyzer
 * 8-layer analysis of news articles
 * Provides sentiment, importance, and impact scoring
 */

const Sentiment = require('sentiment');
const logger = require('./logger');

class AdvancedNewsAnalyzer {
  constructor() {
    this.sentiment = new Sentiment();
  }

  /**
   * Analyze multiple articles
   */
  analyzeNews(articles, symbol) {
    if (!Array.isArray(articles)) {
      logger.warn(`Invalid articles format for ${symbol}`);
      return [];
    }

    return articles.map(article => this.analyzeArticle(article, symbol))
      .filter(item => item !== null);
  }

  /**
   * Comprehensive article analysis (8 layers)
   */
  analyzeArticle(article, symbol) {
    try {
      if (!article.headline) return null;

      return {
        // 1. SENTIMENT ANALYSIS
        sentiment: {
          score: this.calculateSentiment(article.headline, article.description),
          confidence: this.calculateConfidence(article.headline),
          strength: this.determineSentimentStrength(article.headline)
        },

        // 2. IMPORTANCE SCORING
        importance: this.calculateImportance(article),

        // 3. TOPIC CLASSIFICATION
        topic: this.classifyTopic(article.headline),

        // 4. ACTION SIGNALS
        signals: this.extractSignals(article.headline),

        // 5. SOURCE RELIABILITY
        sourceReliability: this.getSourceReliability(article.source),

        // 6. TIME RELEVANCE
        ageFactor: this.calculateAgeFactor(article.published_at),

        // 7. PRICE IMPACT ESTIMATE
        estimatedPriceImpact: this.estimatePriceImpact(article.headline),

        // 8. KEY ENTITIES
        entities: this.extractEntities(article.headline),

        // METADATA
        metadata: {
          headline: article.headline,
          source: article.source,
          url: article.url,
          published: article.published_at,
          fetchedAt: new Date()
        }
      };
    } catch (error) {
      logger.warn(`Error analyzing article: ${error.message}`);
      return null;
    }
  }

  // ========== LAYER 1: SENTIMENT ==========

  calculateSentiment(headline, description) {
    const headlineSentiment = this.sentiment.analyze(headline);
    const descSentiment = description ? this.sentiment.analyze(description) : { score: 0 };

    const score = (headlineSentiment.score * 0.7) + (descSentiment.score * 0.3);
    return Math.max(-1, Math.min(1, score / 5));
  }

  calculateConfidence(headline) {
    const words = headline.split(' ').length;
    const lengthScore = Math.min(1, words / 20);
    const hasKeywords = this.hasStrongKeywords(headline) ? 0.9 : 0.6;
    return (lengthScore * 0.3 + hasKeywords * 0.7);
  }

  determineSentimentStrength(headline) {
    const text = headline.toLowerCase();
    if (/fraud|scandal|collapse|crash|plunge/.test(text)) return 'VERY NEGATIVE';
    if (/soar|surge|beat|breakthrough|record/.test(text)) return 'VERY POSITIVE';
    const score = this.sentiment.analyze(headline).score;
    if (score > 2) return 'POSITIVE';
    if (score < -2) return 'NEGATIVE';
    return 'NEUTRAL';
  }

  // ========== LAYER 2: IMPORTANCE ==========

  calculateImportance(article) {
    let score = 5;
    score += this.getSourceReliability(article.source);
    if (this.hasStrongKeywords(article.headline)) score += 2;
    if (/earnings|guidance|acquisition/.test(article.headline.toLowerCase())) score += 1.5;
    return Math.min(10, score);
  }

  // ========== LAYER 3: TOPIC ==========

  classifyTopic(headline) {
    const text = headline.toLowerCase();
    if (/earnings|revenue|profit/.test(text)) return 'earnings';
    if (/product|launch|release/.test(text)) return 'product';
    if (/acquisition|merger|deal/.test(text)) return 'acquisition';
    if (/regulation|lawsuit|sec/.test(text)) return 'regulation';
    if (/ceo|leadership|appointment/.test(text)) return 'management';
    return 'general';
  }

  // ========== LAYER 4: SIGNALS ==========

  extractSignals(headline) {
    const signals = [];
    const text = headline.toLowerCase();

    if (/upgrade|outperform|beat/.test(text)) {
      signals.push({ type: 'BUY', strength: 1 });
    }
    if (/downgrade|underperform|miss/.test(text)) {
      signals.push({ type: 'SELL', strength: 1 });
    }
    if (/fraud|lawsuit|scandal/.test(text)) {
      signals.push({ type: 'SELL', strength: 2 });
    }

    return signals;
  }

  // ========== LAYER 5: SOURCE ==========

  getSourceReliability(source) {
    const reliable = ['reuters', 'bloomberg', 'wsj', 'financial times', 'cnbc'];
    if (reliable.some(s => source?.toLowerCase().includes(s))) return 2;
    return 1;
  }

  // ========== LAYER 6: TIME ==========

  calculateAgeFactor(publishedDate) {
    const age = (Date.now() - new Date(publishedDate)) / (1000 * 60 * 60);
    if (age < 1) return 1.0;
    if (age < 6) return 0.9;
    if (age < 24) return 0.7;
    if (age < 72) return 0.5;
    return 0.2;
  }

  // ========== LAYER 7: IMPACT ==========

  estimatePriceImpact(headline) {
    const text = headline.toLowerCase();
    if (/beat earnings/.test(text)) return 2;
    if (/miss earnings/.test(text)) return -2;
    if (/acquisition/.test(text)) return 1.5;
    if (/fraud|lawsuit/.test(text)) return -2.5;
    return 0;
  }

  // ========== LAYER 8: ENTITIES ==========

  extractEntities(headline) {
    const entities = [];
    if (/ceo|chief|founder/.test(headline.toLowerCase())) {
      entities.push({ type: 'person', category: 'management' });
    }
    if (/product|innovation|technology/.test(headline.toLowerCase())) {
      entities.push({ type: 'product', category: 'technology' });
    }
    return entities;
  }

  // ========== HELPERS ==========

  hasStrongKeywords(headline) {
    const strong = ['earnings', 'acquisition', 'breach', 'fraud', 'ceo', 'innovation'];
    return strong.some(kw => headline.toLowerCase().includes(kw));
  }
}

module.exports = new AdvancedNewsAnalyzer();
