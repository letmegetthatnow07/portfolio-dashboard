const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function initDatabase() {
  // Create data directory if it doesn't exist
  const dataDir = path.join(__dirname, '../../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log('📁 Created data directory');
  }
  
  const dbPath = path.join(dataDir, 'stocks.db');
  
  try {
    const db = new Database(dbPath);
    
    // Enable foreign keys
    db.pragma('foreign_keys = ON');
    console.log('✅ Foreign keys enabled');
    
    // ============== PORTFOLIO TABLE ==============
    // Stores your stocks/ETFs
    db.exec(`
      CREATE TABLE IF NOT EXISTS portfolio (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT UNIQUE NOT NULL,
        name TEXT,
        type TEXT CHECK(type IN ('Stock', 'ETF')),
        region TEXT CHECK(region IN ('Global', 'India')),
        quantity REAL NOT NULL,
        average_price REAL NOT NULL,
        sector TEXT,
        added_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        active INTEGER DEFAULT 1
      );
    `);
    console.log('✅ Created portfolio table');
    
    // ============== STOCK DATA TABLE ==============
    // Latest data for each stock (updated daily)
    db.exec(`
      CREATE TABLE IF NOT EXISTS stock_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT UNIQUE NOT NULL,
        price REAL NOT NULL,
        change REAL,
        change_percent REAL,
        high_52w REAL,
        low_52w REAL,
        
        -- Analyst Ratings (Finnhub)
        analyst_rating REAL,
        analyst_buy INTEGER DEFAULT 0,
        analyst_hold INTEGER DEFAULT 0,
        analyst_sell INTEGER DEFAULT 0,
        analyst_strong_buy INTEGER DEFAULT 0,
        analyst_strong_sell INTEGER DEFAULT 0,
        
        -- Technical Indicators
        rsi INTEGER,
        moving_avg_20 REAL,
        moving_avg_50 REAL,
        moving_avg_200 REAL,
        volatility REAL,
        
        -- Fundamentals
        pe_ratio REAL,
        earnings_growth REAL,
        revenue_growth REAL,
        dividend_yield REAL,
        market_cap TEXT,
        debt_to_equity REAL,
        roe REAL,
        
        -- Scores & Recommendations
        composite_score REAL,
        recommendation TEXT,
        trim_percentage REAL,
        insider_buying BOOLEAN,
        news_sentiment REAL,
        
        -- Timestamps
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        
        FOREIGN KEY (symbol) REFERENCES portfolio(symbol) ON DELETE CASCADE
      );
    `);
    console.log('✅ Created stock_data table');
    
    // ============== PRICE HISTORY TABLE ==============
    // Daily price tracking for charts
    db.exec(`
      CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        price REAL NOT NULL,
        high REAL,
        low REAL,
        volume INTEGER,
        date DATE NOT NULL,
        UNIQUE(symbol, date),
        FOREIGN KEY (symbol) REFERENCES portfolio(symbol) ON DELETE CASCADE
      );
    `);
    console.log('✅ Created price_history table');
    
    // ============== FORM 4 FILINGS TABLE ==============
    // Insider transactions from SEC
    db.exec(`
      CREATE TABLE IF NOT EXISTS form4_filings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        filing_date DATE,
        executive TEXT,
        title TEXT,
        transaction_type TEXT CHECK(transaction_type IN ('Buy', 'Sell', 'Exercise', 'Gift')),
        quantity REAL,
        price REAL,
        total_value REAL,
        percent_of_company REAL,
        shares_after REAL,
        acquired_date DATE,
        FOREIGN KEY (symbol) REFERENCES portfolio(symbol) ON DELETE CASCADE
      );
    `);
    console.log('✅ Created form4_filings table');
    
    // ============== NEWS ARTICLES TABLE ==============
    // News articles and sentiment scores
    db.exec(`
      CREATE TABLE IF NOT EXISTS news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        headline TEXT,
        summary TEXT,
        source TEXT,
        url TEXT UNIQUE,
        sentiment REAL,
        sentiment_confidence REAL,
        sentiment_method TEXT,
        image_url TEXT,
        published_at DATETIME,
        fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (symbol) REFERENCES portfolio(symbol) ON DELETE CASCADE
      );
    `);
    console.log('✅ Created news table');
    
    // ============== METRICS HISTORY TABLE ==============
    // Track metric changes over time (for trend analysis)
    db.exec(`
      CREATE TABLE IF NOT EXISTS metrics_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        date DATE DEFAULT CURRENT_DATE,
        composite_score REAL,
        analyst_rating REAL,
        news_sentiment REAL,
        rsi INTEGER,
        volatility REAL,
        UNIQUE(symbol, date),
        FOREIGN KEY (symbol) REFERENCES portfolio(symbol) ON DELETE CASCADE
      );
    `);
    console.log('✅ Created metrics_history table');
    
    // ============== API USAGE TRACKING ==============
    // Monitor API consumption to avoid rate limits
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date DATE DEFAULT CURRENT_DATE,
        finnhub_calls INTEGER DEFAULT 0,
        yfinance_calls INTEGER DEFAULT 0,
        sec_edgar_calls INTEGER DEFAULT 0,
        newsapi_calls INTEGER DEFAULT 0,
        UNIQUE(date)
      );
    `);
    console.log('✅ Created api_usage table');
    
    // ============== SETTINGS TABLE ==============
    // Store configuration
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Created settings table');
    
    // ============== LOGS TABLE ==============
    // Error and event logging
    db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT CHECK(level IN ('INFO', 'WARN', 'ERROR')),
        message TEXT,
        details TEXT,
        stock_symbol TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Created logs table');
    
    // ============== CREATE INDICES ==============
    // For faster queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_stock_symbol ON stock_data(symbol);
      CREATE INDEX IF NOT EXISTS idx_price_history_date ON price_history(date);
      CREATE INDEX IF NOT EXISTS idx_form4_date ON form4_filings(filing_date);
      CREATE INDEX IF NOT EXISTS idx_news_date ON news(published_at);
      CREATE INDEX IF NOT EXISTS idx_metrics_history_date ON metrics_history(date);
    `);
    console.log('✅ Created database indices');
    
    // ============== INSERT SAMPLE SETTINGS ==============
    try {
      db.prepare(`
        INSERT OR IGNORE INTO settings (key, value)
        VALUES 
          ('last_update', '2026-03-13T16:30:00Z'),
          ('update_frequency', 'daily'),
          ('market_close_time', '16:00'),
          ('market_timezone', 'America/New_York')
      `).run();
      console.log('✅ Added default settings');
    } catch (e) {
      console.log('ℹ️  Settings already exist');
    }
    
    return db;
    
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
    throw error;
  }
}

module.exports = initDatabase;
