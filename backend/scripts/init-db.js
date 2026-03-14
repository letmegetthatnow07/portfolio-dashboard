#!/usr/bin/env node

/**
 * Initialize Database
 * Creates SQLite database and tables if they don't exist
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config();

console.log('✓ Initializing database...');

try {
  const dbPath = path.resolve(__dirname, '../data/stocks.db');
  const dbDir = path.dirname(dbPath);
  
  // Create data directory if it doesn't exist
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`✓ Created directory: ${dbDir}`);
  }
  
  // Check if database already exists
  if (fs.existsSync(dbPath)) {
    console.log(`✓ Database already exists at: ${dbPath}`);
  } else {
    console.log(`✓ Database will be created at: ${dbPath}`);
  }
  
  console.log('✓ Database initialization ready');
  console.log('Note: Full schema creation will happen in STEP 8');
  
  process.exit(0);
  
} catch (error) {
  console.error('✗ Error initializing database:', error.message);
  process.exit(1);
}
