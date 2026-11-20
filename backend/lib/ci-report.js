'use strict';
/**
 * CI REPORT: makes partial failures visible instead of silent.
 * Prints GitHub Actions annotations (yellow warnings on the run page) and appends a table to the job summary.
 * Never throws and never changes the exit code: the caller decides what a PARTIAL run means.
 */
const fs = require('fs');

const esc = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function annotate(level, msg) {
  console.log(`::${level === 'error' ? 'error' : 'warning'}::${esc(msg)}`);
}

function summary(md) {
  try { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`); } catch (_e) { /* not on CI */ }
}

/** issues: array of strings. stats: { label: value }. Returns 'SUCCESS' | 'PARTIAL'. */
function finish(name, issues = [], stats = {}) {
  const status = issues.length ? 'PARTIAL' : 'SUCCESS';
  const rows = Object.entries(stats).map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  summary(`### ${issues.length ? '⚠️' : '✅'} ${name}: ${status}\n${rows ? `\n| | |\n|---|---|\n${rows}\n` : ''}${issues.length ? `\n${issues.map(i => `- ${String(i).replace(/\s+/g, ' ')}`).join('\n')}\n` : ''}`);
  console.log(`[${name}] ${status}${issues.length ? ` (${issues.length} issue${issues.length === 1 ? '' : 's'})` : ''}`);
  for (const i of issues.slice(0, 20)) annotate('warning', `${name}: ${i}`);
  if (issues.length > 20) annotate('warning', `${name}: +${issues.length - 20} more issues (see the log)`);
  return status;
}

module.exports = { annotate, summary, finish };
