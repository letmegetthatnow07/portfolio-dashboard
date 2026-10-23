'use strict';
/**
 * Permanent history of multibagger checks in Supabase (table: multibagger_results, see backend/sql/).
 * Redis is the live copy; Supabase is the audit trail. A failed write here NEVER fails a screen.
 */
const TABLE = 'multibagger_results';

function client() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  const { createClient } = require('@supabase/supabase-js');
  // Node 20 needs a WebSocket implementation even though we only use REST (same fix as the other scripts)
  let opts = {};
  try { opts = { realtime: { transport: require('ws') } }; } catch (_e) { /* ws optional on Node 22+ */ }
  return createClient(url, key, opts);
}

const n = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** One flat row per fresh result. Stale carry-overs and ETFs are not new evidence, so they are skipped. */
function toRow(result, source) {
  if (!result || result.stale || result.status === 'NOT_APPLICABLE' || !result.asOf || !Number.isFinite(Date.parse(result.asOf))) return null;
  return {
    symbol: result.symbol, source, checked_at: new Date(result.asOf).toISOString(), held: !!result.held,
    status: result.status, raw_status: result.rawStatus ?? null, verdict: result.verdict ?? null, action: result.action ?? null,
    score: n(result.score) == null ? null : Math.round(result.score), confidence: result.confidence ?? null,
    expected_growth: n(result.growth?.g0), forward_source: result.growth?.forwardSource ?? null,
    mult_5y: n(result.valuation?.mult5y), after_tax_cagr: n(result.valuation?.afterTaxCagr), bear_cagr: n(result.valuation?.bearCagr),
    quality_state: result.qualityGate?.state ?? null, sector_label: result.sector?.label ?? null,
    payload: result,
  };
}

/** items: [{ result, source }]. Returns { saved, skipped, error }. Never throws. */
async function saveResults(items, sb = client()) {
  try {
    if (!sb) return { saved: 0, skipped: items.length, error: 'Supabase not configured' };
    const rows = items.map(i => toRow(i.result, i.source)).filter(Boolean);
    if (!rows.length) return { saved: 0, skipped: items.length, error: null };
    const { error } = await sb.from(TABLE).upsert(rows, { onConflict: 'symbol,source,checked_at', ignoreDuplicates: true });
    if (error) return { saved: 0, skipped: items.length, error: error.message };
    return { saved: rows.length, skipped: items.length - rows.length, error: null };
  } catch (e) {
    return { saved: 0, skipped: items.length, error: e.message };
  }
}

/** Newest first. Used by the dashboard's history view. */
async function readHistory(symbol, limit = 60, sb = client()) {
  if (!sb) return [];
  const { data, error } = await sb.from(TABLE)
    .select('symbol,source,checked_at,held,status,raw_status,verdict,action,score,expected_growth,after_tax_cagr,bear_cagr,quality_state')
    .eq('symbol', symbol).order('checked_at', { ascending: false }).limit(Math.min(limit, 200));
  if (error) throw new Error(error.message);
  return data || [];
}

module.exports = { TABLE, client, toRow, saveResults, readHistory };
