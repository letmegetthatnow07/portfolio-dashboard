/**
 * Data Validation & Normalization
 * Ensures all data is valid before storing
 * Normalizes values to consistent ranges
 */

const logger = require('./logger');

class DataValidator {
  /**
   * Validate price data
   */
  validatePriceData(data) {
    if (!data.price || typeof data.price !== 'number') {
      logger.warn(`Invalid price: ${data.price}`);
      return false;
    }

    if (data.price <= 0) {
      logger.warn(`Price must be positive: ${data.price}`);
      return false;
    }

    if (!data.timestamp) {
      logger.warn('Price missing timestamp');
      return false;
    }

    // Check for suspicious price movements (>50% daily = unusual)
    if (data.change && Math.abs(data.change) > 50) {
      logger.warn(`Suspicious price change: ${data.change}%`);
      return true; // Still valid but flagged
    }

    if (data.volume && data.volume < 0) {
      logger.warn(`Invalid volume: ${data.volume}`);
      return false;
    }

    return true;
  }

  /**
   * Validate analyst ratings
   */
  validateRatings(ratings) {
    if (!ratings) return false;

    const total = (ratings.strong_buy || 0) +
                  (ratings.buy || 0) +
                  (ratings.hold || 0) +
                  (ratings.sell || 0) +
                  (ratings.strong_sell || 0);

    if (total === 0) {
      logger.warn('Ratings total is 0');
      return false;
    }

    return true;
  }

  /**
   * Validate news articles
   */
  validateNews(articles) {
    if (!Array.isArray(articles)) return [];

    return articles.filter(article => {
      if (!article.headline) return false;
      if (article.sentiment === null || article.sentiment === undefined) return false;
      if (!article.published_at) return false;
      return true;
    });
  }

  /**
   * Validate stock grades
   */
  validateGrade(grade) {
    const validGrades = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'];
    return validGrades.includes(grade);
  }

  /**
   * Normalize sentiment to -1 to +1 range
   */
  normalizeSentiment(value) {
    if (typeof value !== 'number') return 0;
    return Math.max(-1, Math.min(1, value));
  }

  /**
   * Normalize score to 0-10 range
   */
  normalizeScore(value) {
    if (typeof value !== 'number') return 5;
    return Math.max(0, Math.min(10, value));
  }

  /**
   * Normalize percentage (0-100)
   */
  normalizePercentage(value) {
    if (typeof value !== 'number') return 0;
    return Math.max(0, Math.min(100, value));
  }

  /**
   * Validate all required fields present
   */
  validateRequiredFields(data, requiredFields) {
    const missing = requiredFields.filter(field => !data[field]);
    if (missing.length > 0) {
      logger.warn(`Missing required fields: ${missing.join(', ')}`);
      return false;
    }
    return true;
  }
}

module.exports = new DataValidator();
