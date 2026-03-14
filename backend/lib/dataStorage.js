/**
 * Data Storage Module
 * Stores/retrieves portfolio data from JSON file
 * Professional data management without compilation
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class DataStorage {
  constructor() {
    this.dataDir = path.join(process.cwd(), 'data');
    this.dataFile = path.join(this.dataDir, 'portfolio-data.json');
    this.initializeDataDirectory();
  }

  initializeDataDirectory() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      logger.info('✓ Data directory created');
    }

    if (!fs.existsSync(this.dataFile)) {
      const initialData = {
        stocks: [],
        lastUpdated: null,
        metadata: {
          version: '1.0',
          createdAt: new Date().toISOString()
        }
      };
      fs.writeFileSync(this.dataFile, JSON.stringify(initialData, null, 2));
      logger.info('✓ Portfolio data file created');
    }
  }

  /**
   * Read all portfolio data
   */
  readData() {
    try {
      const data = fs.readFileSync(this.dataFile, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      logger.warn(`Error reading data: ${e.message}`);
      return { stocks: [], lastUpdated: null };
    }
  }

  /**
   * Write portfolio data
   */
  writeData(data) {
    try {
      data.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2));
      logger.info('✓ Portfolio data saved');
      return true;
    } catch (e) {
      logger.error(`Error writing data: ${e.message}`);
      return false;
    }
  }

  /**
   * Add or update stock
   */
  upsertStock(symbol, stockData) {
    try {
      const data = this.readData();
      const index = data.stocks.findIndex(s => s.symbol === symbol);

      if (index >= 0) {
        data.stocks[index] = { ...data.stocks[index], ...stockData };
      } else {
        data.stocks.push({ symbol, ...stockData });
      }

      this.writeData(data);
      return true;
    } catch (e) {
      logger.error(`Error upserting stock: ${e.message}`);
      return false;
    }
  }

  /**
   * Get portfolio with scores
   */
  getPortfolioWithScores() {
    try {
      const data = this.readData();
      
      // Calculate stats
      const stats = {
        totalStocks: data.stocks.length,
        strongBuys: data.stocks.filter(s => s.signal === 'STRONG_BUY').length,
        buys: data.stocks.filter(s => s.signal === 'BUY').length,
        holds: data.stocks.filter(s => s.signal === 'HOLD').length,
        reduces: data.stocks.filter(s => s.signal === 'REDUCE').length,
        sells: data.stocks.filter(s => s.signal === 'SELL').length,
        averageScore: data.stocks.length > 0
          ? (data.stocks.reduce((sum, s) => sum + (s.latest_score || 0), 0) / data.stocks.length).toFixed(2)
          : 0
      };

      return {
        status: 'success',
        timestamp: new Date().toISOString(),
        stats: stats,
        portfolio: data.stocks
      };
    } catch (e) {
      logger.error(`Error getting portfolio: ${e.message}`);
      return { status: 'error', message: e.message };
    }
  }

  /**
   * Clear all data (for testing)
   */
  clearData() {
    try {
      const initialData = {
        stocks: [],
        lastUpdated: null,
        metadata: {
          version: '1.0',
          clearedAt: new Date().toISOString()
        }
      };
      fs.writeFileSync(this.dataFile, JSON.stringify(initialData, null, 2));
      logger.info('✓ Portfolio data cleared');
      return true;
    } catch (e) {
      logger.error(`Error clearing data: ${e.message}`);
      return false;
    }
  }
}

module.exports = new DataStorage();
