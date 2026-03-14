/**
 * SEC Form 4 Insider Transaction Fetcher
 * Scrapes SEC EDGAR for Form 4 filings
 * Tracks insider buying/selling activity
 */

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('./logger');
const dedupeCache = require('./deduplicationCache');
const validator = require('./validateAndNormalize');

class Form4Fetcher {
  /**
   * Get latest Form 4 filings for a symbol
   */
  async getLatestForm4Filings(symbol) {
    try {
      // Check cache first
      if (!dedupeCache.shouldFetch(symbol, 'insider')) {
        logger.debug(`Form 4 cached for ${symbol}`);
        return dedupeCache.getCached(symbol, 'insider');
      }

      logger.debug(`Fetching Form 4 for ${symbol}...`);

      // Get company CIK and Form 4 filings list
      const cikRes = await axios.get(
        `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${symbol}&type=4&dateb=&owner=exclude&count=10&search_text=`,
        { timeout: 10000 }
      );
      
      const $ = cheerio.load(cikRes.data);
      const filings = [];
      
      // Parse Form 4 entries (last 10)
      $('table.tableFile2 tr').slice(1).each((i, row) => {
        const cells = $(row).find('td');
        
        if (cells.length >= 4) {
          const filing = {
            date: $(cells[3]).text().trim(),
            filingUrl: $(cells[1]).find('a').attr('href'),
            symbol: symbol
          };
          
          filings.push(filing);
        }
      });

      if (filings.length === 0) {
        logger.warn(`No Form 4 filings found for ${symbol}`);
        return null;
      }

      logger.debug(`Found ${filings.length} Form 4 filings for ${symbol}`);

      // Get details of most recent filing
      const recentUrl = `https://www.sec.gov${filings[0].filingUrl}`;
      const filingRes = await axios.get(recentUrl, { timeout: 10000 });
      const filingHtml = cheerio.load(filingRes.data);
      
      // Extract transaction details
      const transactions = [];
      filingHtml('.formData tr').each((i, row) => {
        const cells = filingHtml(row).find('td');
        if (cells.length >= 5) {
          const transaction = {
            transactionType: filingHtml(cells[1]).text().trim(),
            quantity: parseInt(filingHtml(cells[2]).text()) || 0,
            price: parseFloat(filingHtml(cells[3]).text()) || 0,
            date: filingHtml(cells[4]).text().trim()
          };
          
          // Validate transaction
          if (transaction.quantity > 0) {
            transactions.push(transaction);
          }
        }
      });

      if (transactions.length === 0) {
        logger.warn(`No valid transactions found in Form 4 for ${symbol}`);
        return null;
      }

      // Analyze transactions
      const isBuying = transactions.some(t => 
        t.transactionType.toUpperCase().includes('BUY') ||
        t.transactionType.toUpperCase().includes('OPEN MARKET')
      );

      const isSelling = transactions.some(t => 
        t.transactionType.toUpperCase().includes('SELL')
      );

      const result = {
        symbol: symbol,
        date: filings[0].date,
        transactionCount: transactions.length,
        isBuying: isBuying,
        isSelling: isSelling,
        sentiment: this.determineInsiderSentiment(isBuying, isSelling, transactions.length),
        transactions: transactions.slice(0, 5), // Top 5 transactions
        fetchedAt: new Date()
      };

      // Cache the result
      dedupeCache.markFetched(symbol, 'insider', result);
      logger.debug(`✓ Form 4 fetched for ${symbol}`);

      return result;

    } catch (error) {
      logger.warn(`Form 4 error for ${symbol}: ${error.message}`);
      return null;
    }
  }

  /**
   * Determine insider sentiment from transaction patterns
   */
  determineInsiderSentiment(isBuying, isSelling, transactionCount) {
    if (isBuying && !isSelling && transactionCount > 1) {
      return 'STRONG_BUY'; // Multiple buys, no sells = very bullish
    }
    if (isBuying && !isSelling) {
      return 'BUY'; // Buying activity
    }
    if (isSelling && !isBuying) {
      return 'SELL'; // Selling activity
    }
    if (isBuying && isSelling) {
      return 'NEUTRAL'; // Mixed activity
    }
    return 'NEUTRAL';
  }

  /**
   * Get insider sentiment score for composite calculation
   */
  getInsiderScore(insiderData) {
    if (!insiderData) return 5;

    const sentimentScores = {
      'STRONG_BUY': 8,
      'BUY': 7,
      'NEUTRAL': 5,
      'SELL': 3,
      'STRONG_SELL': 1
    };

    return sentimentScores[insiderData.sentiment] || 5;
  }
}

module.exports = new Form4Fetcher();
