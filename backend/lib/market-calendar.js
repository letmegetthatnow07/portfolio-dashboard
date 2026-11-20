'use strict';
/**
 * MARKET CALENDAR: "is the US market closed TODAY (weekend or holiday)?"
 *
 * Date-based on purpose. The old earnings-event / filing-narrative scripts asked Polygon for the market's
 * real-time status (/v1/marketstatus/now) and treated "closed" as "holiday". After the close that endpoint
 * reports closed/extended-hours on EVERY trading day, so a delayed GitHub run (or any manual run at night)
 * skipped itself. daily-update.js already uses the date-based approach; this makes it one shared helper.
 *
 *   FORCE_RUN=true  -> never closed (manual runs)
 *   weekend         -> closed
 *   Polygon /v1/marketstatus/upcoming lists the holidays; cached per date in Redis (key market_holiday_<date>,
 *   '1' / '0', the same key daily-update.js uses). If the check itself fails we assume OPEN (fail open).
 */
const axios = require('axios');

const todayISO = () => new Date().toISOString().split('T')[0];

async function isMarketClosedToday({ redisClient = null, date = todayISO(), force = process.env.FORCE_RUN === 'true', log = console.log } = {}) {
  if (force) { log('  [Market] FORCE_RUN=true: bypassing the market-closed check'); return false; }

  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return true;

  const key = `market_holiday_${date}`;
  let rc = redisClient, own = false;
  try {
    if (!rc && process.env.REDIS_URL) {
      const { createClient } = require('redis');
      rc = createClient({ url: process.env.REDIS_URL });
      rc.on('error', () => {});
      await rc.connect();
      own = true;
    }
  } catch (_e) { rc = null; }

  try {
    if (rc) {
      const cached = await rc.get(key).catch(() => null);
      if (cached !== null && cached !== undefined) return cached === '1';
    }
    const res = await axios.get(`https://api.polygon.io/v1/marketstatus/upcoming?apiKey=${process.env.POLYGON_API_KEY}`, { timeout: 6000 });
    const closed = (Array.isArray(res.data) ? res.data : []).some(h => h.date === date && h.status === 'closed');
    if (rc) await rc.set(key, closed ? '1' : '0', { EX: 86400 }).catch(() => {});
    log(`  [Market] holiday check ${date}: ${closed ? 'HOLIDAY' : 'trading day'}`);
    return closed;
  } catch (e) {
    log(`  [Market] holiday check failed (${String(e.message).replace(/apiKey=[^&\s]+/gi, 'apiKey=[REDACTED]')}): assuming trading day`);
    return false;
  } finally {
    if (own && rc) await rc.quit().catch(() => {});
  }
}

module.exports = { isMarketClosedToday, todayISO };
