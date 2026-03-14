/**
 * Data Storage Module - CLEAN VERSION
 * Only stores user-added stocks, NO dummy data
 * Historical data is reference only
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
    }

    if (!fs.existsSync(this.dataFile)) {
      const initialData = {
        stocks: [], // START EMPTY - user adds stocks via dashboard
        lastUpdated: null,
        metadata: {
          version: '2.0',
          createdAt: new Date().toISOString(),
          note: 'User-added stocks only. Historical data is reference.'
        }
      };
      fs.writeFileSync(this.dataFile, JSON.stringify(initialData, null, 2));
      logger.info('✓ Clean portfolio data file created');
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
      return true;
    } catch (e) {
      logger.error(`Error writing data: ${e.message}`);
      return false;
    }
  }

  /**
   * Add new stock to portfolio
   */
  addStock(symbol, stockData) {
    try {
      const data = this.readData();
      
      // Check if stock already exists
      if (data.stocks.find(s => s.symbol === symbol)) {
        return { success: false, error: 'Stock already in portfolio' };
      }

      const newStock = {
        id: Date.now().toString(),
        symbol: symbol.toUpperCase(),
        name: stockData.name || symbol,
        type: stockData.type || 'Stock',
        region: stockData.region || 'Global',
        quantity: stockData.quantity || 0,
        average_price: stockData.average_price || 0,
        current_price: stockData.current_price || 0,
        change_percent: 0,
        latest_score: 5,
        signal: 'HOLD',
        confidence: 0,
        timestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      data.stocks.push(newStock);
      this.writeData(data);
      
      logger.info(`✓ Stock added: ${symbol}`);
      return { success: true, stock: newStock };
    } catch (e) {
      logger.error(`Error adding stock: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /**
   * Update existing stock
   */
  updateStock(id, updates) {
    try {
      const data = this.readData();
      const index = data.stocks.findIndex(s => s.id === id);

      if (index < 0) {
        return { success: false, error: 'Stock not found' };
      }

      data.stocks[index] = {
        ...data.stocks[index],
        ...updates,
        updatedAt: new Date().toISOString()
      };

      this.writeData(data);
      logger.info(`✓ Stock updated: ${data.stocks[index].symbol}`);
      return { success: true, stock: data.stocks[index] };
    } catch (e) {
      logger.error(`Error updating stock: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /**
   * Delete stock from portfolio
   */
  deleteStock(id) {
    try {
      const data = this.readData();
      const index = data.stocks.findIndex(s => s.id === id);

      if (index < 0) {
        return { success: false, error: 'Stock not found' };
      }

      const deleted = data.stocks.splice(index, 1)[0];
      this.writeData(data);
      
      logger.info(`✓ Stock deleted: ${deleted.symbol}`);
      return { success: true, stock: deleted };
    } catch (e) {
      logger.error(`Error deleting stock: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  /**
   * Get portfolio with stats
   */
  getPortfolioWithScores() {
    try {
      const data = this.readData();
      const stocks = data.stocks || [];

      const stats = {
        totalStocks: stocks.length,
        strongBuys: stocks.filter(s => s.signal === 'STRONG_BUY').length,
        buys: stocks.filter(s => s.signal === 'BUY').length,
        holds: stocks.filter(s => s.signal === 'HOLD').length,
        reduces: stocks.filter(s => s.signal === 'REDUCE').length,
        sells: stocks.filter(s => s.signal === 'SELL').length,
        averageScore: stocks.length > 0
          ? (stocks.reduce((sum, s) => sum + (s.latest_score || 0), 0) / stocks.length).toFixed(2)
          : 0
      };

      return {
        status: 'success',
        timestamp: new Date().toISOString(),
        stats: stats,
        portfolio: stocks
      };
    } catch (e) {
      logger.error(`Error getting portfolio: ${e.message}`);
      return { status: 'error', message: e.message };
    }
  }

  /**
   * Clear all data (for testing only)
   */
  clearAll() {
    try {
      const initialData = {
        stocks: [],
        lastUpdated: null,
        metadata: {
          version: '2.0',
          clearedAt: new Date().toISOString()
        }
      };
      fs.writeFileSync(this.dataFile, JSON.stringify(initialData, null, 2));
      logger.info('✓ All portfolio data cleared');
      return true;
    } catch (e) {
      logger.error(`Error clearing data: ${e.message}`);
      return false;
    }
  }
}

module.exports = new DataStorage();
