const Database = require('better-sqlite3');

function initDatabase() {
  const db = new Database('./data/stocks.db');
  
  // Portfolio tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio (
      id INTEGER PRIMARY KEY,
      symbol TEXT UNIQUE,
      type TEXT, -- 'Stock' or 'ETF'
      region TEXT, -- 'Global' or 'India'
      quantity REAL,
      average_price REAL,
      active INTEGER DEFAULT 1,
      added_date DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  // Current stock data (updated daily)
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_data (
      id INTEGER PRIMARY KEY,
      symbol TEXT UNIQUE,
      price REAL,
      change REAL,
      change_percent REAL,
      analyst_rating REAL,
      institutional_ownership TEXT,
      rsi INTEGER,
      moving_avg_20 REAL,
      moving_avg_50 REAL,
      moving_avg_200 REAL,
      pe_ratio REAL,
      earnings_growth REAL,
      dividend_yield REAL,
      composite_score REAL,
      recommendation TEXT,
      insider_buying BOOLEAN,
      updated_at DATETIME
    );
  `);
  
  // Historical prices (for charts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY,
      symbol TEXT,
      price REAL,
      date DATETIME,
      FOREIGN KEY (symbol) REFERENCES portfolio(symbol)
    );
  `);
  
  // Form 4 insider transactions
  db.exec(`
    CREATE TABLE IF NOT EXISTS form4_filings (
      id INTEGER PRIMARY KEY,
      symbol TEXT,
      filing_date DATETIME,
      transaction_type TEXT,
      quantity REAL,
      price REAL,
      executive TEXT,
      FOREIGN KEY (symbol) REFERENCES portfolio(symbol)
    );
  `);
  
  return db;
}

module.exports = initDatabase;
