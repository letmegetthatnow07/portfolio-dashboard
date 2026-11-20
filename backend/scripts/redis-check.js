#!/usr/bin/env node
'use strict';
/**
 * REDIS CHECK: answers "is Redis reachable, and is it storing data?" without a terminal.
 * Run it from GitHub: Actions tab > "Market & News Data Pipeline" > Run workflow > run_type = redis-check.
 * It also runs weekly (Sunday), which counts as activity so Redis Cloud's free database is not deleted for inactivity.
 *
 *   node scripts/redis-check.js            read-only report + a keepalive write
 *   node scripts/redis-check.js --backup   also copies the "portfolio" value into Supabase table app_backups
 *
 * PRIVACY: the repo and its Actions logs are PUBLIC, so this prints counts, versions and timestamps only.
 * It never prints the connection string, key names, tickers or holdings.
 *
 * One-time SQL for --backup (Supabase > SQL editor):
 *   create table if not exists app_backups (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
 *   alter table app_backups enable row level security;   -- no policies: only the service key can read or write it
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { createClient } = require('redis');
const ci = require('../lib/ci-report');

const BACKUP = process.argv.includes('--backup');
const rows = [];
const issues = [];
const say = (k, v) => { rows.push([k, v]); console.log(`${k.padEnd(26)} ${v}`); };

async function connect() {
  const url = process.env.REDIS_URL;
  if (!url) { issues.push('REDIS_URL secret is not set'); return null; }
  try { const u = new URL(url); say('Server', `${u.hostname}:${u.port || '6379'} (${u.protocol.replace(':', '')})`.replace(/^[^ ]+\.(redislabs|redis-cloud)\.com/, m => m.replace(/^[^.]+/, '***'))); } catch (_) { issues.push('REDIS_URL is not a valid URL (expected redis://default:PASSWORD@host:port)'); return null; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const client = createClient({ url, socket: { connectTimeout: 10000, reconnectStrategy: r => (r >= 2 ? new Error('reconnect limit') : 500) } });
    client.on('error', () => {});
    try { await client.connect(); return client; }
    catch (e) {
      console.log(`connect attempt ${attempt}/3 failed: ${String(e.message).replace(/redis:\/\/[^@\s]*@/g, 'redis://***@')}`);
      await Promise.resolve().then(() => client.disconnect()).catch(() => {});
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }
  issues.push('Could not connect after 3 attempts. Check the REDIS_URL secret against the database page in Redis Cloud (endpoint, port, password) and that the database is still Active, not Suspended.');
  return null;
}

(async () => {
  const client = await connect();
  if (!client) { say('Connection', 'FAILED'); ci.finish('Redis check', issues, Object.fromEntries(rows)); process.exit(1); }
  try {
    say('Connection', `OK (PING ${await client.ping()})`);
    const info = await client.info('server').catch(() => '');
    const ver = /redis_version:(\S+)/.exec(info); if (ver) say('Redis version', ver[1]);
    const mem = await client.info('memory').catch(() => ''); const used = /used_memory_human:(\S+)/.exec(mem); if (used) say('Memory used', used[1]);
    const dbsize = await client.dbSize(); say('Keys stored', String(dbsize));
    if (dbsize === 0) issues.push('The database is EMPTY: nothing is stored. If it was recreated or flushed, the portfolio must be restored (see the weekly backup in Supabase if --backup was enabled).');

    // key families by prefix only (key names contain tickers, which must not be logged)
    const fam = {};
    for await (const k of client.scanIterator({ COUNT: 200 })) { const p = String(k).split(/[_:]/)[0]; fam[p] = (fam[p] || 0) + 1; }
    say('Key families', Object.entries(fam).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p, n]) => `${p}:${n}`).join('  ') || 'none');

    const raw = await client.get('portfolio');
    if (!raw) { say('Portfolio', 'MISSING'); issues.push('The "portfolio" key does not exist: the dashboard and the nightly jobs have nothing to work on.'); }
    else {
      let p = null; try { p = JSON.parse(raw); } catch (_) { issues.push('The "portfolio" value is not valid JSON'); }
      if (p) {
        say('Portfolio', `${(p.stocks || []).length} holdings`);
        say('Portfolio last updated', p.lastUpdated || 'never');
        const age = p.lastUpdated ? (Date.now() - new Date(p.lastUpdated).getTime()) / 86400000 : null;
        if (age != null && age > 4) issues.push(`The portfolio was last written ${age.toFixed(1)} days ago: the nightly jobs are not saving to this database. They may be pointing at a different one.`);
        if (!(p.stocks || []).length) issues.push('The portfolio has zero holdings');
      }
      if (BACKUP) {
        try {
          if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set');
          const _ws = (() => { try { return require('ws'); } catch (_) { return undefined; } })();
          const { createClient: sb } = require('@supabase/supabase-js');
          const supa = sb(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, _ws ? { realtime: { transport: _ws } } : {});
          const { error } = await supa.from('app_backups').upsert({ key: 'portfolio', value: JSON.parse(raw), updated_at: new Date().toISOString() });
          if (error) throw new Error(error.message);
          say('Backup to Supabase', 'saved (table app_backups, key portfolio)');
        } catch (e) { say('Backup to Supabase', 'FAILED'); issues.push(`Backup failed: ${e.message} (create the app_backups table with the SQL in this script's header)`); }
      }
    }
    await client.set('keepalive:last', new Date().toISOString());
    say('Keepalive write', 'done (counts as activity for the free-tier inactivity rule)');
  } catch (e) {
    issues.push(`Redis check error: ${String(e.message).replace(/redis:\/\/[^@\s]*@/g, 'redis://***@')}`);
  } finally { await client.quit().catch(() => {}); }
  const status = ci.finish('Redis check', issues, Object.fromEntries(rows));
  process.exit(status === 'SUCCESS' ? 0 : 1);
})();
