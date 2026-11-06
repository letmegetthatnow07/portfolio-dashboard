#!/usr/bin/env node
'use strict';
/**
 * One-off patch: wires backend/lib/earnings-context.js into backend/scripts/daily-update.js.
 *   node backend/scripts/apply-earnings-patch.js            (patches backend/scripts/daily-update.js)
 *   node backend/scripts/apply-earnings-patch.js <path>     (patch another copy)
 * Every anchor must match EXACTLY ONCE or nothing is written. Safe to re-run (detects its own marker).
 * The code that gets injected is in the SNIPPETS block at the bottom of this file.
 */
const fs = require('fs'), path = require('path');
const target = path.resolve(process.argv[2] || path.join(__dirname, 'daily-update.js'));
let src = fs.readFileSync(target, 'utf8');
if (src.includes('EARNINGS-CONTEXT WIRING')) { console.log('Already patched. Nothing to do.'); process.exit(0); }

const self = fs.readFileSync(__filename, 'utf8');
const snip = {};
let cur = null;
for (const line of self.split('\n').slice(self.split('\n').indexOf('//=====SNIPPETS=====') + 1)) {
  const m = line.match(/^\/\/@@(\w+)$/);
  if (m) { cur = m[1]; snip[cur] = []; } else if (cur) snip[cur].push(line.replace(/^\/\/ ?/, ''));
}
const S = k => snip[k].join('\n').replace(/\n+$/, '');

const edits = [
  { name: 'require', find: "const quantEngine  = require('../lib/quant-engine');", add: '\n' + S('require') },
  { name: 'score adjustment', find: `          instrumentIsETF ? (profileExpenseRatio ?? null) : null,
          recent8K
        );`, add: '\n\n' + S('adjust') },
  { name: 'ADD gate',
    find: "if (addSignal && !['TRIM_25', 'SELL', 'SPRING_CANDIDATE', 'SPRING_CONFIRMED'].includes(action)) action = 'ADD';",
    replace: "if (addSignal && !earningsCtx.blockAdds && !['TRIM_25', 'SELL', 'SPRING_CANDIDATE', 'SPRING_CONFIRMED'].includes(action)) action = 'ADD';" },
  { name: 'redis fields', find: '          sma50:                   technicals?.sma50   ?? null,', add: '\n' + S('fields') },
];

for (const e of edits) {
  const n = src.split(e.find).length - 1;
  if (n !== 1) { console.error('ABORT: anchor "' + e.name + '" matched ' + n + ' times (need exactly 1). Nothing written.'); process.exit(1); }
}
for (const e of edits) src = src.replace(e.find, () => (e.replace != null ? e.replace : e.find + e.add));
fs.copyFileSync(target, target + '.bak');
fs.writeFileSync(target, src);
console.log('Patched ' + target + ' (backup: ' + target + '.bak)');
process.exit(0);

//=====SNIPPETS=====
//@@require
// const earningsCtxLib = require('../lib/earnings-context');
//@@adjust
//         // ── EARNINGS-CONTEXT WIRING ─────────────────────────────────────────────
//         // Revenue surprise (primary), EPS (secondary), guidance (tertiary). Max +/-0.6 on the 0-10 scale,
//         // decays over 60 days. Never applied to ETFs or when a critical 8-K already forced the score to 0.
//         let earningsCtx = { compositePoints: 0, blockAdds: false, blockReason: null, grade: null, executionScore: null, missStreak: 0, beatStreak: 0, source: 'NONE', flags: [] };
//         if (!instrumentIsETF) {
//           try {
//             const _rc = await getRedisClient();
//             const _parse = raw => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
//             const _surprises = _rc ? _parse(await _rc.get(`earnings_surprise_${stock.symbol}`).catch(() => null)) : null;
//             const _event     = _rc ? _parse(await _rc.get(`earnings_event_${stock.symbol}`).catch(() => null))    : null;
//             earningsCtx = earningsCtxLib.assessEarningsContext({
//               surprises, event: _event,
//               highExpectations: earningsCtxLib.isHighExpectation({
//                 forwardPE:   fundamentals?.forwardPE,
//                 hypergrowth: fundamentals?._hypergrowthMode === true,
//                 g0:          fundamentals?.revenueGrowth3Y,
//               }),
//             });
//             if (!scoreObj._8kCriticalOverride && earningsCtx.compositePoints) {
//               const _before = scoreObj.total;
//               scoreObj.total = Math.max(0, Math.min(10, scoreObj.total + earningsCtx.compositePoints));
//               scoreObj.earnings_adj = earningsCtx.compositePoints;
//               logger.info(`  📊 Earnings context (${earningsCtx.source}, grade ${earningsCtx.grade ?? 'n/a'}): ${earningsCtx.compositePoints >= 0 ? '+' : ''}${earningsCtx.compositePoints.toFixed(2)} → total ${_before.toFixed(2)} → ${scoreObj.total.toFixed(2)}`);
//             }
//             if (earningsCtx.blockAdds) logger.warn(`  ⛔ Adds blocked: ${earningsCtx.blockReason}`);
//           } catch (e) {
//             logger.warn(`Earnings context failed for ${stock.symbol}: ${e.message} — no adjustment applied`);
//           }
//         }
//@@fields
//           earnings_adj:            earningsCtx.compositePoints || 0,
//           earnings_grade:          earningsCtx.grade           ?? null,
//           earnings_block_adds:     earningsCtx.blockAdds === true,
//           earnings_block_reason:   earningsCtx.blockReason     ?? null,
//           earnings_execution:      earningsCtx.executionScore  ?? null,
//           earnings_miss_streak:    earningsCtx.missStreak      ?? 0,
//           earnings_beat_streak:    earningsCtx.beatStreak      ?? 0,
