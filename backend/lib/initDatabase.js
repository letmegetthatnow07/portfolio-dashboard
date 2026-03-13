const Database = require('better-sqlite3');
const path = require('path');

function initDatabase() {
  const dbPath = path.join(__dirname, '../../data/stocks.db');
  
  try {
    const db = new Database(dbPath);
    
    // Enable foreign keys
    db.pragma('foreign_keys = ON');
    
    // Portfolio table
    db.exec(`
      CREATE TABLE IF NOT EXISTS portfolio (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT UNIQUE NOT NULL,
        name TEXT,
        type TEXT CHECK(type IN ('Stock', 'ETF')),
        region TEXT CHECK(region IN ('Global', 'India')),
        quantity REAL NOT NULL,
        average_price REAL NOT NULL,
        added_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        active INTEGER DEFAULT 1
      );
    `);
    
    // Stock data table (updated daily)
    db.exec(`
      CREATE TABLE IF NOT EXISTS stock_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT UNIQUE NOT NULL,
        price REAL NOT NULL,
        change REAL,
        change_percent REAL,
        high_52w REAL,
        low_52w REAL,
        analyst_rating REAL,
        analyst_buy REAL,
        analyst_hold REAL,
        analyst_sell REAL,
        rsi INTEGER,
        moving_avg_20 REAL,
        moving_avg_50 REAL,
        moving_avg_200 REAL,
        volatility REAL,
        pe_ratio REAL,
        earnings_growth REAL,
        dividend_yield REAL,
        market_cap TEXT,
        composite_score REAL,
        recommendation TEXT,
        insider_buying BOOLEAN,
        news_sentiment REAL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (symbol) REFERENCES portfolio(symbol) ON DELETE CASCADE
      );
    `);
    
    // Price history (for charts)
    db.exec(`
      CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        price REAL NOT NULL,
        date DATE NOT NULL,
        UNIQUE(symbol, date),
        FOREIGN KEY (symbol) REFERENCES portfolio(symbol) ON DELETE CASCADE
      );
    `);
    
    // Form 4 filings
    db.exec(`
      CREATE TABLE IF NOT EXISTS form4_filings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        filing_date DATE,
        executive TEXT,
        title TEXT,
        transaction_type TEXT CHECK(transaction_type IN ('Buy', 'Sell', 'Exercise')),
        quantity REAL,
        price REAL,
        percent_of_company REAL,
        FOREIGN KEY (symbol) REFERENCES portfolio(symbol) ON DELETE CASCADE
      );
    `);
    
    // News articles
    db.exec(`
      CREATE TABLE IF NOT EXISTS news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        headline TEXT,
        summary TEXT,
        source TEXT,
        url TEXT,
        sentiment REAL,
        published_at DATETIME,
        FOREIGN KEY (symbol) REFERENCES portfolio(symbol) ON DELETE CASCADE
      );
    `);
    
    // API usage tracking
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date DATE DEFAULT CURRENT_DATE,
        finnhub_calls INTEGER DEFAULT 0,
        yfinance_calls INTEGER DEFAULT 0,
        sec_edgar_calls INTEGER DEFAULT 0,
        newsapi_calls INTEGER DEFAULT 0
      );
    `);
    
    console.log('✅ Database initialized successfully');
    return db;
    
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
    throw error;
  }
}

module.exports = initDatabase;
