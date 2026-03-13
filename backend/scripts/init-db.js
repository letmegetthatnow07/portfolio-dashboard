const initDatabase = require('../lib/initDatabase');

console.log('🚀 Initializing database...\n');

try {
  const db = initDatabase();
  
  // Verify tables were created
  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
  `).all();
  
  console.log('\n📊 Tables created:');
  tables.forEach(t => console.log(`   ✅ ${t.name}`));
  
  const tableCount = tables.length;
  console.log(`\n✨ Total: ${tableCount} tables created`);
  console.log('✨ Database is ready!\n');
  
  db.close();
  process.exit(0);
  
} catch (error) {
  console.error('\n❌ Error:', error.message);
  console.error(error.stack);
  process.exit(1);
}
