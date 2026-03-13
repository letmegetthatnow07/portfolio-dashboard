const initDatabase = require('../lib/initDatabase');

try {
  const db = initDatabase();
  
  // Test the database
  const tableCount = db.prepare(`
    SELECT COUNT(*) as count FROM sqlite_master WHERE type='table';
  `).get();
  
  console.log(`✅ Created ${tableCount.count} tables`);
  console.log('✅ Ready for data import');
  
  db.close();
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}
