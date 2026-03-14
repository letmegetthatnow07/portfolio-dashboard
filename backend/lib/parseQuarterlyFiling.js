/**
 * Quarterly Filing Parser
 * Parses 10-Q and 10-K filings from SEC
 * Extracts key financial metrics
 */

const logger = require('./logger');

class QuarterlyFilingParser {
  
  /**
   * Parse filing and extract metrics
   */
  async parseFilings(symbol, filingData) {
    try {
      if (!filingData) {
        logger.warn(`No filing data for ${symbol}`);
        return null;
      }

      const metrics = {
        // Financial Health
        revenue: this.extractMetric(filingData, 'Revenue'),
        netIncome: this.extractMetric(filingData, 'NetIncomeLoss'),
        operatingCashFlow: this.extractMetric(filingData, 'OperatingActivitiesCashFlow'),
        
        // Growth
        revenueGrowth: this.calculateGrowth(filingData, 'Revenue'),
        incomeGrowth: this.calculateGrowth(filingData, 'NetIncomeLoss'),
        
        // Debt & Liquidity
        totalDebt: this.extractMetric(filingData, 'LongTermDebt'),
        cashOnHand: this.extractMetric(filingData, 'CashAndCashEquivalents'),
        currentRatio: this.calculateRatio(filingData, 'CurrentAssets', 'CurrentLiabilities'),
        
        // Profitability
        grossMargin: this.calculateMargin(filingData, 'GrossProfit', 'Revenue'),
        operatingMargin: this.calculateMargin(filingData, 'OperatingIncome', 'Revenue'),
        netMargin: this.calculateMargin(filingData, 'NetIncomeLoss', 'Revenue'),
        
        // Efficiency
        roe: this.calculateRatio(filingData, 'NetIncomeLoss', 'StockholdersEquity'),
        roa: this.calculateRatio(filingData, 'NetIncomeLoss', 'Assets'),
        
        // Risk Assessment
        debtToEquity: this.calculateRatio(filingData, 'LongTermDebt', 'StockholdersEquity'),
        interestCoverage: this.calculateRatio(filingData, 'OperatingIncome', 'InterestExpense')
      };

      // Calculate health score
      const healthScore = this.calculateHealthScore(metrics);

      return {
        symbol,
        metrics: metrics,
        health_score: healthScore,
        analyzed_at: new Date(),
        filing_type: '10-Q'
      };

    } catch (error) {
      logger.error(`Error parsing filing for ${symbol}`, error);
      return null;
    }
  }

  /**
   * Extract metric value from filing
   */
  extractMetric(filingData, metricName) {
    try {
      // Handle different API response formats
      if (filingData[metricName]) {
        const value = filingData[metricName];
        if (Array.isArray(value) && value.length > 0) {
          return value[0].value;
        }
        return value;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate growth rate year-over-year
   */
  calculateGrowth(filingData, metric) {
    try {
      const values = filingData[metric];
      if (!Array.isArray(values) || values.length < 2) return null;

      const recent = values[0]?.value;
      const previous = values[1]?.value;

      if (!recent || !previous || previous === 0) return null;

      return ((recent - previous) / Math.abs(previous)) * 100;
    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate financial ratios
   */
  calculateRatio(filingData, numerator, denominator) {
    try {
      const numVal = this.extractMetric(filingData, numerator);
      const denomVal = this.extractMetric(filingData, denominator);

      if (!numVal || !denomVal || denomVal === 0) return null;
      return (numVal / denomVal);
    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate margin percentages
   */
  calculateMargin(filingData, profit, revenue) {
    try {
      const profitVal = this.extractMetric(filingData, profit);
      const revenueVal = this.extractMetric(filingData, revenue);

      if (!profitVal || !revenueVal || revenueVal === 0) return null;
      return (profitVal / revenueVal) * 100;
    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate overall financial health score (0-10)
   */
  calculateHealthScore(metrics) {
    let score = 0;
    let factors = 0;

    // Profitability (3 points)
    if (metrics.netMargin !== null) {
      if (metrics.netMargin > 10) score += 3;
      else if (metrics.netMargin > 0) score += 1.5;
      factors += 3;
    }

    // Growth (2 points)
    if (metrics.revenueGrowth !== null) {
      if (metrics.revenueGrowth > 15) score += 2;
      else if (metrics.revenueGrowth > 0) score += 1;
      factors += 2;
    }

    // Debt Health (2 points)
    if (metrics.debtToEquity !== null) {
      if (metrics.debtToEquity < 1) score += 2;
      else if (metrics.debtToEquity < 2) score += 1;
      factors += 2;
    }

    // Liquidity (2 points)
    if (metrics.currentRatio !== null) {
      if (metrics.currentRatio > 1.5) score += 2;
      else if (metrics.currentRatio > 1) score += 1;
      factors += 2;
    }

    // Efficiency (1 point)
    if (metrics.roe !== null) {
      if (metrics.roe > 0.15) score += 1;
      factors += 1;
    }

    return factors > 0 ? (score / factors) * 10 : 5;
  }
}

module.exports = new QuarterlyFilingParser();
