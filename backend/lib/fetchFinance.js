/**
 * Financial Data Fetcher
 * Fetches data from all 6 APIs
 * Implements deduplication to prevent redundant calls
 */

const axios = require('axios');
const dedupeCache = require('./deduplicationCache');
const logger = require('./logger');

class FinanceFetcher {
  constructor() {
    this.alphaVantageKey = process.env.ALPHA_VANTAGE_API_KEY;
    this.finnhubKey = process.env.FINNHUB_API_KEY;
    this.newsdataKey = process.env.NEWSDATA_API_KEY;
    this.fmpKey = process.env.FMP_API_KEY;
    this.secKey = process.env.SEC_API_KEY;
  }

  /**
   * Fetch prices and technical indicators from Alpha Vantage
   */
  async fetchPricesAndTechnicals(symbols) {
    try {
      const toFetch = symbols.filter(s => dedupeCache.shouldFetch(s, 'prices'));

      if (toFetch.length === 0) {
        logger.info('✓ All prices cached (fetched today already)');
        return null;
      }

      logger.info(`Fetching prices for ${toFetch.length} stocks from Alpha Vantage...`);

      const data = {};

      for (const symbol of toFetch) {
        try {
          // Fetch daily prices
          const priceResponse = await axios.get('https://www.alphavantage.co/query', {
            params: {
              function: 'TIME_SERIES_DAILY',
              symbol: symbol,
              apikey: this.alphaVantageKey
            },
            timeout: 10000
          });

          // Fetch RSI
          const rsiResponse = await axios.get('https://www.alphavantage.co/query', {
            params: {
              function: 'RSI',
              symbol: symbol,
              interval: 'daily',
              time_period: 14,
              apikey: this.alphaVantageKey
            },
            timeout: 10000
          });

          data[symbol] = {
            prices: priceResponse.data,
            rsi: rsiResponse.data,
            fetchedAt: new Date()
          };

          dedupeCache.markFetched(symbol, 'prices', data[symbol]);
          logger.debug(`✓ Fetched prices for ${symbol}`);

        } catch (error) {
          logger.warn(`Failed to fetch prices for ${symbol}: ${error.message}`);
        }

        // Rate limiting: Alpha Vantage allows 5 calls/min
        await new Promise(resolve => setTimeout(resolve, 12000));
      }

      return data;

    } catch (error) {
      logger.error('Failed to fetch prices', error);
      return null;
    }
  }

  /**
   * Fetch analyst ratings from Finnhub
   */
  async fetchAnalystRatings(symbols) {
    try {
      const toFetch = symbols.filter(s => dedupeCache.shouldFetch(s, 'ratings'));

      if (toFetch.length === 0) {
        logger.info('✓ All ratings cached (updated bi-weekly)');
        return null;
      }

      logger.info(`Fetching analyst ratings for ${toFetch.length} stocks from Finnhub...`);

      const data = {};

      for (const symbol of toFetch) {
        try {
          const response = await axios.get('https://finnhub.io/api/v1/stock/recommendation', {
            params: {
              symbol: symbol,
              token: this.finnhubKey
            },
            timeout: 10000
          });

          data[symbol] = response.data;
          dedupeCache.markFetched(symbol, 'ratings', data[symbol]);
          logger.debug(`✓ Fetched ratings for ${symbol}`);

        } catch (error) {
          logger.warn(`Failed to fetch ratings for ${symbol}: ${error.message}`);
        }

        // Rate limiting: Wait to avoid hitting limits
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      return data;

    } catch (error) {
      logger.error('Failed to fetch ratings', error);
      return null;
    }
  }

  /**
   * Fetch news from newsdata.io
   */
  async fetchNews(symbols) {
    try {
      const toFetch = symbols.filter(s => dedupeCache.shouldFetch(s, 'news'));

      if (toFetch.length === 0) {
        logger.info('✓ All news cached (updated every 6 hours)');
        return null;
      }

      logger.info(`Fetching news for ${toFetch.length} stocks from newsdata.io...`);

      const data = {};

      for (const symbol of toFetch) {
        try {
          const response = await axios.get('https://newsdata.io/api/1/news', {
            params: {
              q: symbol,
              apikey: this.newsdataKey,
              language: 'en',
              sort: 'published_desc',
              limit: 10
            },
            timeout: 10000
          });

          data[symbol] = response.data.results || [];
          dedupeCache.markFetched(symbol, 'news', data[symbol]);
          logger.debug(`✓ Fetched news for ${symbol}`);

        } catch (error) {
          logger.warn(`Failed to fetch news for ${symbol}: ${error.message}`);
        }

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      return data;

    } catch (error) {
      logger.error('Failed to fetch news', error);
      return null;
    }
  }

  /**
   * Fetch stock grades from FMP
   */
  async fetchStockGrades(symbols) {
    try {
      const toFetch = symbols.filter(s => dedupeCache.shouldFetch(s, 'grades'));

      if (toFetch.length === 0) {
        logger.info('✓ All grades cached (updated monthly)');
        return null;
      }

      logger.info(`Fetching stock grades for ${toFetch.length} stocks from FMP...`);

      const data = {};

      for (const symbol of toFetch) {
        try {
          const response = await axios.get(`https://financialmodelingprep.com/api/v4/grade/${symbol}`, {
            params: {
              apikey: this.fmpKey,
              limit: 5
            },
            timeout: 10000
          });

          data[symbol] = response.data;
          dedupeCache.markFetched(symbol, 'grades', data[symbol]);
          logger.debug(`✓ Fetched grades for ${symbol}`);

        } catch (error) {
          logger.warn(`Failed to fetch grades for ${symbol}: ${error.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      }

      return data;

    } catch (error) {
      logger.error('Failed to fetch grades', error);
      return null;
    }
  }

  /**
   * Fetch quarterly filings from SEC-API.io
   */
  async fetchQuarterlyFilings(symbols) {
    try {
      const toFetch = symbols.filter(s => dedupeCache.shouldFetch(s, 'filings'));

      if (toFetch.length === 0) {
        logger.info('✓ All filings cached (updated monthly)');
        return null;
      }

      logger.info(`Fetching quarterly filings for ${toFetch.length} stocks from SEC-API.io...`);

      const data = {};

      for (const symbol of toFetch) {
        try {
          const response = await axios.get('https://www.sec-api.io/', {
            params: {
              action: 'getCompanyFacts',
              CIK: symbol,
              type: '10-Q',
              apiKey: this.secKey
            },
            timeout: 15000
          });

          data[symbol] = response.data;
          dedupeCache.markFetched(symbol, 'filings', data[symbol]);
          logger.debug(`✓ Fetched filings for ${symbol}`);

        } catch (error) {
          logger.warn(`Failed to fetch filings for ${symbol}: ${error.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      return data;

    } catch (error) {
      logger.error('Failed to fetch filings', error);
      return null;
    }
  }
}

module.exports = new FinanceFetcher();
