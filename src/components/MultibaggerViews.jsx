import React, { useState, useEffect, useCallback, useRef } from 'react';
import './multibagger.css';

// ── Labels ───────────────────────────────────────────────────────────────────
const STATUS = {
  PASS:           { label: '✓ PASS',  cls: 'mb-pass' },
  FAIL:           { label: '✗ FAIL',  cls: 'mb-fail' },
  NO_DATA:        { label: 'NO DATA', cls: 'mb-nodata' },
  NOT_APPLICABLE: { label: 'ETF',     cls: 'mb-nodata' },
  PENDING:        { label: 'NOT RUN', cls: 'mb-pending' },
};
// Portfolio action depends on ownership: holdings get hold/add/exit language, watchlist stocks get candidate language.
const ACTION = {
  HOLD_AND_ADD:          { text: 'Hold · fine to add',                 cls: 'ok' },
  HOLD_DONT_ADD:         { text: "Hold · don't add yet",               cls: 'warn' },
  HOLD_WATCH:            { text: 'Hold · watch',                       cls: 'warn' },
  THESIS_AT_RISK:        { text: 'Thesis at risk · confirming',        cls: 'bad' },
  REVIEW_EXIT:           { text: 'Thesis broken · review exit',        cls: 'bad' },
  DATA_STALE:            { text: 'Data stale · no new buying',         cls: 'warn' },
  CANDIDATE_READY:       { text: 'Eligible · review for purchase',     cls: 'ok' },
  CANDIDATE_PROVISIONAL: { text: 'Provisional · confirm quality first', cls: 'warn' },
  NOT_QUALIFIED:         { text: 'Not qualified',                      cls: 'warn' },
  STALE_NO_BUY:          { text: 'Data stale · no buying',             cls: 'warn' },
};
const VERDICT = {
  MULTIBAGGER: 'Multibagger', ALPHA_COMPOUNDER: 'Alpha compounder',
  WAIT_FOR_PRICE: 'Good business, price or sector not ready', UNPROVEN_PROFITABILITY: 'Profitability not yet proven',
  NOT_MULTIBAGGER: 'Not a compounder', INSUFFICIENT_DATA: 'Not enough data', NOT_APPLICABLE: 'ETF: not screened',
};
const STAGE = { EARLY: 'Early / accelerating', MID: 'Mid / steep growth', LATE: 'Late / maturing', DECLINING: 'Declining' };
const FWD_SOURCE = { CONSENSUS: 'Analyst consensus', IMPLIED_1Y: '1-yr implied', NOT_MEANINGFUL: 'EPS crosses zero', HISTORY_ONLY: 'History only' };
const pct = (x, dp = 0) => (x == null || !isFinite(x) ? 'n/a' : `${(x * 100).toFixed(dp)}%`);
const dateFmt = iso => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const shortDate = iso => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '');
const signed = (x, dp = 0, unit = '') => (x == null || !isFinite(x) ? null : `${x >= 0 ? '+' : ''}${x.toFixed(dp)}${unit}`);

// What changed between the last two checks (status, score, growth, after-tax return)
const lastChange = result => {
  const h = (result?.history || []).filter(e => e && e.status);
  if (h.length < 2) return null;
  const a = h[h.length - 2], b = h[h.length - 1];
  const d = (x, y) => (x != null && y != null ? y - x : null);
  return { from: a.asOf, to: b.asOf, statusChanged: a.status !== b.status, fromStatus: a.status, toStatus: b.status, dScore: d(a.score, b.score), dG: d(a.g0, b.g0), dCagr: d(a.atCagr, b.atCagr) };
};

export const StatusChip = ({ status, stale }) => {
  const m = STATUS[status] || STATUS.PENDING;
  return <span className={`mb-chip ${m.cls}`}>{m.label}{stale ? ' · stale' : ''}</span>;
};

// A row of tick marks, one per periodic check, oldest -> newest
export const Ticks = ({ history, max = 6 }) => {
  const h = (history || []).filter(e => e && e.status).slice(-max);
  if (!h.length) return null;
  return (
    <span className="mb-ticks" title="Periodic thesis checks, oldest to newest">
      {h.map((e, i) => (
        <span key={`${e.asOf}-${i}`} className={`mb-tick ${e.status === 'PASS' ? 'ok' : 'bad'}`}
          title={`${dateFmt(e.asOf)}: ${e.status}${e.score != null ? ` · score ${e.score}` : ''}${e.g0 != null ? ` · growth ${pct(e.g0)}` : ''}${e.atCagr != null ? ` · after-tax ${pct(e.atCagr)}/yr` : ''}`}>
          {e.status === 'PASS' ? '✓' : '✗'}
        </span>
      ))}
    </span>
  );
};

// Small badge under the quality ring in the portfolio table
export const MultibaggerBadge = ({ result }) => {
  if (!result || result.status === 'NOT_APPLICABLE') return null;
  const a = ACTION[result.action];
  const ch = lastChange(result);
  return (
    <div className="mb-badge" title={(result.reasons || []).join(' ')}>
      <StatusChip status={result.status} stale={result.stale} />
      {a && <span className={`mb-badge-act ${a.cls}`}>{a.text}</span>}
      <Ticks history={result.history} />
      {ch && (
        <span className={`mb-delta ${ch.statusChanged ? (ch.toStatus === 'PASS' ? 'up' : 'down') : (ch.dScore > 0 ? 'up' : ch.dScore < 0 ? 'down' : '')}`}>
          {ch.statusChanged ? `changed to ${ch.toStatus}` : ch.dScore != null && ch.dScore !== 0 ? `${ch.dScore > 0 ? '▲' : '▼'} score ${signed(ch.dScore)} since ${shortDate(ch.from)}` : `unchanged since ${shortDate(ch.from)}`}
        </span>
      )}
      <span className="mb-checked">checked {shortDate(result.asOf)}</span>
    </div>
  );
};

const Bar = ({ label, value }) => (
  <div className="mb-bar">
    <span className="mb-bar-lbl">{label}</span>
    <span className="mb-bar-track"><span className="mb-bar-fill" style={{ width: `${value ?? 0}%`, opacity: value == null ? 0.15 : 1 }} /></span>
    <span className="mb-bar-val">{value == null ? '–' : value}</span>
  </div>
);

// Full explanation: only rendered once a run has produced a result
export const MultibaggerDetail = ({ result }) => {
  if (!result) return null;
  if (result.status === 'NO_DATA' || result.status === 'NOT_APPLICABLE') {
    return (
      <div className="mb-detail">
        <p className="mb-reason">{(result.reasons || [])[0]}</p>
        {result.lastConfirmed && <p className="mb-reason">Last confirmed: {result.lastConfirmed.status} on {dateFmt(result.lastConfirmed.asOf)}.</p>}
      </div>
    );
  }
  const v = result.valuation || {}, g = result.growth || {}, q = result.quality || {}, a = ACTION[result.action];
  const parts = result.scoreParts || {};
  const gate = result.qualityGate;
  const ch = lastChange(result);
  return (
    <div className="mb-detail">
      <div className="mb-head">
        <div>
          <div className="mb-verdict">{VERDICT[result.verdict] || result.verdict}</div>
          <div className="mb-sub">
            Score <strong>{result.score}</strong>/100 · {STAGE[result.stage] || result.stage} · confidence {String(result.confidence || '').toLowerCase()}
          </div>
        </div>
        {a && <span className={`mb-badge-act ${a.cls}`}>{a.text}</span>}
      </div>

      {result.stale && (
        <div className="mb-note warn">
          <strong>Data is stale.</strong> {result.staleReason ? `${result.staleReason}. ` : ''}Showing the last valid assessment from {dateFmt(result.asOf)}. No new buying until it refreshes.
        </div>
      )}

      {result.pending && (
        <div className="mb-note warn">
          Change to <strong>{result.pending.to}</strong> is pending confirmation (check {result.pending.runs} of 2, needs {result.pending.needDays}+ days between checks).
          Status stays {result.status} until then.
        </div>
      )}

      {gate && (
        <div className={`mb-note ${gate.state === 'PASS' ? 'ok' : gate.state === 'FAIL' ? 'bad' : 'warn'}`}>
          <strong>Daily quality check: {gate.state === 'UNVERIFIED' ? 'not yet scored' : gate.state.toLowerCase()}.</strong> {gate.reason}
        </div>
      )}

      <div className="mb-grid">
        <div><span className="mb-k">Expected growth</span><span className="mb-v">{pct(g.g0)}/yr{v.illustrative ? ' (illustrative)' : ''}</span></div>
        <div><span className="mb-k">Forward source</span><span className="mb-v">{FWD_SOURCE[g.forwardSource] || 'n/a'}{g.estYears ? ` · ${g.estYears}y` : ''}</span></div>
        <div><span className="mb-k">5y price multiple</span><span className="mb-v">{v.mult5y != null ? `${v.mult5y.toFixed(1)}x` : 'n/a'}</span></div>
        <div><span className="mb-k">After exit tax</span><span className="mb-v">{v.afterTaxMult != null ? `${v.afterTaxMult.toFixed(1)}x · ${pct(v.afterTaxCagr)}/yr` : 'n/a'}</span></div>
        <div><span className="mb-k">Bear case</span><span className="mb-v">{v.bearCagr != null ? `${pct(v.bearCagr)}/yr after tax` : 'n/a'}</span></div>
        <div><span className="mb-k">Growth price needs</span><span className="mb-v">{v.requiredG0 != null ? pct(v.requiredG0) : 'unreachable'}</span></div>
        <div><span className="mb-k">Sector</span><span className="mb-v">{result.sector ? `${result.sector.etf} · ${String(result.sector.label).replace('_', ' ').toLowerCase()}` : 'n/a'}</span></div>
        <div><span className="mb-k">ROIC</span><span className="mb-v">{pct(q.roic)}</span></div>
        <div><span className="mb-k">Gross margin</span><span className="mb-v">{pct(q.gm)}</span></div>
        <div><span className="mb-k">Balance sheet</span><span className="mb-v">{q.leverage ? String(q.leverage).replace('_', ' ').toLowerCase() : 'n/a'}</span></div>
      </div>

      <div className="mb-bars">
        {[['Growth', parts.growth], ['ROIC', parts.roic], ['Valuation', parts.valuation], ['S-curve', parts.stage], ['Moat', parts.moat], ['Balance', parts.balance], ['Sector', parts.sector], ['Sentiment', parts.sentiment]]
          .map(([l, val]) => <Bar key={l} label={l} value={val} />)}
      </div>

      {result.thesis && (
        <div className={`mb-note ${result.thesis.state === 'BROKEN' ? 'bad' : 'ok'}`}>
          <strong>Thesis: {result.thesis.state.toLowerCase()}.</strong>{' '}
          {result.thesis.state === 'BROKEN'
            ? `Sell-worthy causes: ${(result.thesis.brokenReasons || []).join(', ')}.`
            : 'Price moves alone do not change this. Priced-in or sector-price weakness means "do not add", not "sell".'}
        </div>
      )}

      {(result.flags || []).length > 0 && (
        <ul className="mb-flags">
          {result.flags.map(f => <li key={f.code} className={`mb-flag ${f.level}`}><span className="mb-dot" />{f.text}</li>)}
        </ul>
      )}

      {(result.reasons || []).length > 0 && (
        <ul className="mb-reasons">{result.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      )}

      {result.entryTiming && (
        <div className={`mb-note ${result.entryTiming.state === 'WAIT' ? 'warn' : 'ok'}`}>
          <strong>Entry timing: {result.entryTiming.state.toLowerCase()}</strong> (weekly RSI {result.entryTiming.rsiWeekly}, MACD {result.entryTiming.macdRising ? 'rising' : 'falling'}).{' '}
          {result.entryTiming.plan}
        </div>
      )}

      <div className="mb-history">
        <div className="mb-history-head">
          <span className="mb-k">Thesis checks</span>
          <Ticks history={result.history} max={12} />
        </div>
        {ch ? (
          <p className="mb-history-note">
            Since the check on {dateFmt(ch.from)}:{' '}
            {ch.statusChanged ? <strong className={ch.toStatus === 'PASS' ? 'up' : 'down'}>status changed {ch.fromStatus} → {ch.toStatus}</strong> : <span>status unchanged ({ch.toStatus})</span>}
            {ch.dScore != null && <span> · score {signed(ch.dScore)}</span>}
            {ch.dG != null && <span> · growth {signed(ch.dG * 100, 1, ' pts')}</span>}
            {ch.dCagr != null && <span> · after-tax return {signed(ch.dCagr * 100, 1, ' pts')}</span>}
          </p>
        ) : <p className="mb-history-note">First check on record. Changes show up from the next check.</p>}
      </div>

      <div className="mb-foot">
        <span>Checked {dateFmt(result.asOf)}{result.held === false ? ' · not owned' : ''}</span>
      </div>
    </div>
  );
};

// Section inside the portfolio row's expanded panel
export const MultibaggerPanel = ({ result, onRescreen, busy }) => (
  <div className="detail-section mb-section">
    <div className="detail-section-head">
      <span className="detail-section-title">🚀 Compounder thesis</span>
      {onRescreen && (
        <button className="btn-expand" onClick={onRescreen} disabled={busy}>{busy ? 'Checking…' : '↻ Check now'}</button>
      )}
    </div>
    {result ? <MultibaggerDetail result={result} /> : <p className="mb-empty">Not checked yet. The check runs automatically every 15 days after the nightly update, or press Check now.</p>}
  </div>
);

// ── Screener tab ─────────────────────────────────────────────────────────────
const SPACING_MS = 2500;                 // browser fallback only: keeps the free-tier per-minute limit safe
const POLL_MS = 15000;
const POLL_MAX_MS = 25 * 60 * 1000;

export const ScreenerView = ({ toast, confirm, onPromote }) => {
  const [entries, setEntries] = useState([]);
  const [results, setResults] = useState({});
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [progress, setProgress] = useState(null);   // browser fallback: { done, total, current }
  const [run, setRun] = useState(null);             // GitHub run: { state, conclusion, url, mode }
  const [busySym, setBusySym] = useState(null);
  const [open, setOpen] = useState(null);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/portfolio/watchlist');
      if (!r.ok) throw new Error(`Request failed (${r.status})`);
      const j = await r.json();
      setEntries(j.entries || []); setResults(j.results || {});
    } catch (e) { toast.error(`Could not load the screener list: ${e.message}`); }
    finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => stopPoll, []);

  const startPoll = (startedAt, mode) => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch('/api/portfolio/trigger-screen');
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.state) setRun(prev => (prev ? { ...prev, state: j.state, conclusion: j.conclusion, url: j.url } : prev));
        await load();
        if (r.ok && j.state === 'completed') {
          stopPoll();
          if (j.conclusion === 'success') toast.success(mode === 'screen' ? 'Full check finished' : 'Screen finished: results are updated');
          else toast.error(`The GitHub run ended with "${j.conclusion || 'unknown'}". Open the run for details.`);
        } else if (Date.now() - startedAt > POLL_MAX_MS) {
          stopPoll(); setRun(null);
          toast.info('Still running. Reload this tab in a few minutes to see the results.');
        }
      } catch (_e) { /* keep polling */ }
    }, POLL_MS);
  };

  // Accepts one ticker or many: "NVDA, AMD MSFT; AVGO" -> added one by one (keeps each request short and within data limits)
  const add = async (e) => {
    e?.preventDefault?.();
    const symbols = [...new Set(input.toUpperCase().split(/[\s,;]+/).map(x => x.trim()).filter(Boolean))];
    if (!symbols.length) return;
    const bad = symbols.filter(x => !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(x));
    if (bad.length) { toast.error(`Not valid tickers: ${bad.join(', ')}`); return; }
    if (symbols.length > 30) { toast.error('Add up to 30 tickers at a time.'); return; }
    setAdding(true);
    const id = toast.loading(symbols.length > 1 ? `Adding ${symbols.length} tickers…` : `Adding ${symbols[0]}…`);
    const added = [], failed = [];
    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      try {
        const r = await fetch('/api/portfolio/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
        setEntries(prev => [j.entry, ...prev.filter(x => x.symbol !== j.entry.symbol)]);
        added.push(symbol);
      } catch (err) { failed.push(`${symbol} (${err.message})`); }
      if (i < symbols.length - 1) await new Promise(r => setTimeout(r, 350));
    }
    setAdding(false);
    setInput(failed.length ? failed.map(f => f.split(' ')[0]).join(', ') : '');   // keep only the ones that failed so they can be fixed and retried
    if (!added.length) toast.update(id, 'error', failed.join('; '));
    else if (failed.length) toast.update(id, 'info', `Added ${added.length}: ${added.join(', ')}. Not added: ${failed.join('; ')}`);
    else toast.update(id, 'success', added.length === 1 ? `${added[0]} added. Press Run to check it.` : `${added.length} added (${added.join(', ')}). Press Run to check them.`);
  };

  const screenOne = async (symbol) => {
    const r = await fetch(`/api/portfolio/watchlist?action=screen&symbol=${encodeURIComponent(symbol)}`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
    setEntries(prev => prev.map(x => (x.symbol === symbol ? j.entry : x)));
    setResults(prev => ({ ...prev, [symbol]: j.result }));
    return j.result;
  };

  // Fallback when GitHub is not configured: screen one by one from the browser (slower, stays within data limits)
  const runInBrowser = async () => {
    const todo = entries.filter(x => !x.screenedAt).map(x => x.symbol);
    if (!todo.length) { toast.info('Nothing to run: every stock has been screened.'); return; }
    let ok = 0, failed = 0;
    for (let i = 0; i < todo.length; i++) {
      setProgress({ done: i, total: todo.length, current: todo[i] });
      try { await screenOne(todo[i]); ok++; } catch (err) { failed++; toast.error(`${todo[i]}: ${err.message}`); }
      if (i < todo.length - 1) await new Promise(r => setTimeout(r, SPACING_MS));
    }
    setProgress(null);
    toast.success(`Screen complete: ${ok} checked${failed ? `, ${failed} failed` : ''}.`);
  };

  // "Run" starts the screen on GitHub Actions and follows it until it finishes
  const trigger = async (mode) => {
    if (mode === 'watchlist' && !entries.some(x => !x.screenedAt)) { toast.info('Nothing to run: every stock has been screened. Use the ↻ button to re-check one.'); return; }
    setRun({ state: 'dispatching', mode });
    try {
      const r = await fetch('/api/portfolio/trigger-screen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 501) {
        setRun(null);
        toast.info('GitHub trigger is not set up yet, so this runs in your browser instead.');
        if (mode === 'watchlist') await runInBrowser();
        else toast.error('Re-checking everything needs the GitHub trigger. Add GITHUB_TOKEN in Vercel.');
        return;
      }
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      setRun({ state: 'queued', mode });
      toast.success(mode === 'screen' ? 'Full check started on GitHub (a few minutes)' : 'Screen started on GitHub (a few minutes)');
      startPoll(Date.now(), mode);
    } catch (err) {
      setRun(null);
      toast.error(err.message);
    }
  };

  const rerun = async (symbol) => {
    setBusySym(symbol);
    const id = toast.loading(`Screening ${symbol}…`);
    try { const r = await screenOne(symbol); toast.update(id, 'success', `${symbol}: ${r.status === 'PASS' ? 'passes' : r.status === 'FAIL' ? 'does not pass' : 'no data'}`); setOpen(symbol); }
    catch (err) { toast.update(id, 'error', err.message); }
    finally { setBusySym(null); }
  };

  const remove = async (symbol) => {
    const ok = await confirm({ title: `Remove ${symbol}?`, message: 'It is removed from the screener list along with its result.', confirmLabel: 'Remove', tone: 'danger' });
    if (!ok) return;
    const id = toast.loading(`Removing ${symbol}…`);
    try {
      const r = await fetch(`/api/portfolio/watchlist?symbol=${encodeURIComponent(symbol)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`Request failed (${r.status})`);
      setEntries(prev => prev.filter(x => x.symbol !== symbol));
      toast.update(id, 'success', `${symbol} removed`);
    } catch (err) { toast.update(id, 'error', err.message); }
  };

  const pending = entries.filter(x => !x.screenedAt).length;
  const pass = entries.filter(x => x.status === 'PASS').length;
  const fail = entries.filter(x => x.status === 'FAIL').length;
  const githubBusy = !!run && run.state !== 'completed';
  const running = githubBusy || !!progress;
  const runLabel = progress ? `Screening ${progress.done + 1} of ${progress.total}…`
    : run?.state === 'dispatching' ? 'Starting…'
    : run?.state === 'queued' || run?.state === 'waiting' ? 'Queued on GitHub…'
    : run?.state === 'in_progress' ? 'Running on GitHub…'
    : pending ? `Run screen (${pending})` : 'Run screen';

  return (
    <div className="screener">
      <div className="screener-top">
        <div>
          <h2 className="screener-title">Stock Screener</h2>
          <p className="screener-sub">
            Add the stocks you are considering, then press Run. The screen runs on GitHub (a few minutes) and results appear here as soon as it finishes.
            A pass here is <strong>provisional</strong>: the daily quality check only scores a stock once it is in your portfolio.
            Individual stocks only, ETFs are not screened.
          </p>
        </div>
        <div className="screener-run">
          <button className="btn-primary" onClick={() => trigger('watchlist')} disabled={running || !pending}>{runLabel}</button>
          <button className="btn-secondary" onClick={() => trigger('screen')} disabled={running} title="Re-check every watchlist stock AND every portfolio stock now, ignoring the 15-day schedule">Re-check everything</button>
        </div>
      </div>

      <form className="screener-add" onSubmit={add}>
        <input value={input} onChange={e => setInput(e.target.value.toUpperCase())} placeholder="Ticker(s), e.g. NVDA, AMD, AVGO" disabled={adding} />
        <button className="btn-secondary" type="submit" disabled={adding || !input.trim()}>{adding ? 'Adding…' : '+ Add to list'}</button>
      </form>
      <div className="screener-hint">Paste one ticker or several, separated by commas or spaces.</div>

      {run && (
        <div className={`mb-run ${run.state === 'completed' ? (run.conclusion === 'success' ? 'ok' : 'bad') : ''}`}>
          <span className="mb-run-dot" />
          <span>
            {run.state === 'dispatching' && 'Asking GitHub to start the screen…'}
            {(run.state === 'queued' || run.state === 'waiting') && 'Queued on GitHub. It starts within a minute.'}
            {run.state === 'in_progress' && 'Running on GitHub. This page updates by itself.'}
            {run.state === 'completed' && (run.conclusion === 'success' ? 'Finished. Results are up to date.' : `Finished with "${run.conclusion || 'unknown'}".`)}
          </span>
          {run.url && <a href={run.url} target="_blank" rel="noopener noreferrer">View run ↗</a>}
          {run.state === 'completed' && <button className="btn-expand" onClick={() => setRun(null)}>Dismiss</button>}
        </div>
      )}

      {progress && (
        <div className="screener-progress">
          <div className="screener-progress-bar"><span style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
          <span>Checking {progress.current}… spaced out to stay within data limits</span>
        </div>
      )}

      <div className="screener-summary">
        <span className="mb-chip mb-pass">{pass} pass</span>
        <span className="mb-chip mb-fail">{fail} fail</span>
        <span className="mb-chip mb-pending">{pending} not run</span>
      </div>

      {loading ? <div className="mb-empty">Loading…</div> : entries.length === 0 ? (
        <div className="mb-empty">No stocks yet. Add a ticker above, then press Run.</div>
      ) : (
        <div className="screener-list">
          {entries.map(en => {
            const res = results[en.symbol];
            const screened = !!en.screenedAt;
            const isOpen = open === en.symbol && screened;
            const act = res ? ACTION[res.action] : null;
            return (
              <div key={en.symbol} className={`screener-row${isOpen ? ' open' : ''}`}>
                <div className="screener-row-main">
                  <div className="screener-id">
                    <strong className="stock-symbol">{en.symbol}</strong>
                    <span className="stock-name">{en.name}</span>
                  </div>
                  <div className="screener-state">
                    <StatusChip status={screened ? en.status : 'PENDING'} stale={en.stale} />
                    {res && <Ticks history={res.history} />}
                    {act && screened && <span className={`mb-badge-act ${act.cls}`}>{act.text}</span>}
                    <span className="screener-when">{screened ? `Screened ${dateFmt(en.screenedAt)}` : 'Press Run to see the result'}</span>
                  </div>
                  <div className="screener-actions">
                    {screened && <button className="btn-expand" onClick={() => setOpen(isOpen ? null : en.symbol)}>{isOpen ? '▲ Hide' : '▼ Details'}</button>}
                    {screened && en.status === 'PASS' && onPromote && <button className="btn-expand" onClick={() => onPromote(en.symbol, en.name)}>＋ Portfolio</button>}
                    <button className="btn-expand" onClick={() => rerun(en.symbol)} disabled={running || busySym === en.symbol} title="Re-check this one stock now">{busySym === en.symbol ? '…' : '↻'}</button>
                    <button className="btn-icon btn-icon-danger" onClick={() => remove(en.symbol)} title="Remove">✕</button>
                  </div>
                </div>
                {isOpen && <MultibaggerDetail result={res} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ── Multibagger tab: your holdings, kept separate from the quality score ─────
export const MultibaggerTab = ({ portfolio, mbData, onCheck, checkingSym }) => {
  const [open, setOpen] = useState(null);
  const stocks = (portfolio || []).filter(s => s.instrument_type !== 'ETF' && s.type !== 'ETF');
  const rank = r => (r?.status === 'FAIL' && (r.action === 'REVIEW_EXIT' || r.action === 'THESIS_AT_RISK') ? 0 : r?.status === 'PASS' ? 1 : r?.status === 'FAIL' ? 2 : 3);
  const rows = stocks.map(st => ({ st, r: mbData[st.symbol] }))
    .sort((a, b) => rank(a.r) - rank(b.r) || (b.r?.score ?? -1) - (a.r?.score ?? -1) || a.st.symbol.localeCompare(b.st.symbol));
  const pass = rows.filter(x => x.r?.status === 'PASS').length;
  const fail = rows.filter(x => x.r?.status === 'FAIL').length;
  const none = rows.length - pass - fail;
  return (
    <div className="mbt">
      <h2 className="mbt-title">Multibagger</h2>
      <p className="mbt-sub">
        Does each holding still pass the 5-year, after-tax compounder test? This is separate from the daily quality score and the buy/sell signal.
        Each holding is re-checked every 15 days, or sooner when something material changes. A change of status needs two checks in a row before it counts.
      </p>
      <div className="mbt-summary">
        <span className="mb-chip mb-pass">{pass} pass</span>
        <span className="mb-chip mb-fail">{fail} fail</span>
        {none > 0 && <span className="mb-chip mb-pending">{none} not checked</span>}
      </div>
      {rows.length === 0 ? <div className="mb-empty">No stocks in the portfolio yet.</div> : (
        <div className="mbt-list">
          {rows.map(({ st, r }) => {
            const status = r?.status;
            const cls = status === 'PASS' ? 'pass' : status === 'FAIL' ? 'fail' : 'nodata';
            const big = status === 'PASS' ? '✓ PASS' : status === 'FAIL' ? '✗ FAIL' : status === 'NO_DATA' ? 'NO DATA' : 'NOT CHECKED';
            const a = r ? ACTION[r.action] : null;
            const ch = lastChange(r);
            const isOpen = open === st.symbol && !!r;
            return (
              <div key={st.symbol} className={`mbt-card ${cls}`}>
                <div className="mbt-row">
                  <div className="mbt-id">
                    <strong className="stock-symbol">{st.symbol}</strong>
                    {st.name && <span className="stock-name">{st.name}</span>}
                  </div>
                  <div className="mbt-result">
                    <span className={`mbt-big ${cls}`}>{big}{r?.stale ? ' · stale' : ''}</span>
                    <div className="mbt-meta">
                      {r && status !== 'NO_DATA' && <span className="mb-sub" style={{ margin: 0 }}>{VERDICT[r.verdict] || r.verdict}{r.score != null ? ` · score ${r.score}/100` : ''}</span>}
                      {a && <span className={`mb-badge-act ${a.cls}`}>{a.text}</span>}
                      {r && <Ticks history={r.history} />}
                      {ch && <span className={`mb-delta ${ch.statusChanged ? (ch.toStatus === 'PASS' ? 'up' : 'down') : ch.dScore > 0 ? 'up' : ch.dScore < 0 ? 'down' : ''}`}>
                        {ch.statusChanged ? `changed to ${ch.toStatus} on ${shortDate(ch.to)}` : ch.dScore ? `${ch.dScore > 0 ? '▲' : '▼'} score ${signed(ch.dScore)} since ${shortDate(ch.from)}` : `unchanged since ${shortDate(ch.from)}`}
                      </span>}
                      <span className="mb-checked">{r ? `checked ${shortDate(r.asOf)}` : 'runs after the next nightly update, or press Check now'}</span>
                    </div>
                  </div>
                  <div className="mbt-actions">
                    {r && <button className="btn-expand" onClick={() => setOpen(isOpen ? null : st.symbol)}>{isOpen ? '▲ Hide' : '▼ Why'}</button>}
                    <button className="btn-expand" onClick={() => onCheck(st.symbol)} disabled={checkingSym === st.symbol}>{checkingSym === st.symbol ? 'Checking…' : '↻ Check now'}</button>
                  </div>
                </div>
                {isOpen && <MultibaggerDetail result={r} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
