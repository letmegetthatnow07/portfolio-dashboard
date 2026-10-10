import React, { useState, useEffect, useCallback } from 'react';
import './multibagger.css';

// ── Labels ───────────────────────────────────────────────────────────────────
const STATUS = {
  PASS:           { label: 'PASS',    cls: 'mb-pass' },
  FAIL:           { label: 'FAIL',    cls: 'mb-fail' },
  NO_DATA:        { label: 'NO DATA', cls: 'mb-nodata' },
  NOT_APPLICABLE: { label: 'ETF',     cls: 'mb-nodata' },
  PENDING:        { label: 'NOT RUN', cls: 'mb-pending' },
};
const ACTION = {
  HOLD_AND_ADD:   { text: 'Hold · fine to add',          cls: 'ok' },
  HOLD_DONT_ADD:  { text: "Hold · don't add yet",        cls: 'warn' },
  HOLD_WATCH:     { text: 'Hold · watch',                cls: 'warn' },
  THESIS_AT_RISK: { text: 'Thesis at risk · confirming', cls: 'bad' },
  REVIEW_EXIT:    { text: 'Thesis broken · review exit', cls: 'bad' },
};
const VERDICT = {
  MULTIBAGGER: 'Multibagger', ALPHA_COMPOUNDER: 'Alpha compounder',
  WAIT_FOR_PRICE: 'Good business, price or sector not ready', NOT_MULTIBAGGER: 'Not a compounder',
  INSUFFICIENT_DATA: 'Not enough data', NOT_APPLICABLE: 'ETF: not screened',
};
const STAGE = { EARLY: 'Early / accelerating', MID: 'Mid / steep growth', LATE: 'Late / maturing', DECLINING: 'Declining' };
const pct = (x, dp = 0) => (x == null || !isFinite(x) ? 'n/a' : `${(x * 100).toFixed(dp)}%`);
const dateFmt = iso => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

export const StatusChip = ({ status }) => {
  const m = STATUS[status] || STATUS.PENDING;
  return <span className={`mb-chip ${m.cls}`}>{m.label}</span>;
};

// Small badge under the quality ring in the portfolio table
export const MultibaggerBadge = ({ result }) => {
  if (!result || result.status === 'NOT_APPLICABLE') return null;
  const a = ACTION[result.action];
  return (
    <div className="mb-badge" title={(result.reasons || []).join(' ')}>
      <StatusChip status={result.status} />
      {a && <span className={`mb-badge-act ${a.cls}`}>{a.text}</span>}
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
    return <div className="mb-detail"><p className="mb-reason">{(result.reasons || [])[0]}</p></div>;
  }
  const v = result.valuation || {}, g = result.growth || {}, q = result.quality || {}, a = ACTION[result.action];
  const parts = result.scoreParts || {};
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

      {result.pending && (
        <div className="mb-note warn">
          Change to <strong>{result.pending.to}</strong> is pending confirmation (run {result.pending.runs} of 2, needs {result.pending.needDays} days).
          Status stays {result.status} until then.
        </div>
      )}

      <div className="mb-grid">
        <div><span className="mb-k">Expected growth</span><span className="mb-v">{pct(g.g0)}/yr</span></div>
        <div><span className="mb-k">Forward source</span><span className="mb-v">{g.forwardSource === 'CONSENSUS' ? 'Analyst consensus' : g.forwardSource === 'IMPLIED_1Y' ? '1-yr implied' : 'History only'}</span></div>
        <div><span className="mb-k">5y price multiple</span><span className="mb-v">{v.mult5y != null ? `${v.mult5y.toFixed(1)}x` : 'n/a'}</span></div>
        <div><span className="mb-k">After exit tax</span><span className="mb-v">{v.afterTaxMult != null ? `${v.afterTaxMult.toFixed(1)}x · ${pct(v.afterTaxCagr)}/yr` : 'n/a'}</span></div>
        <div><span className="mb-k">Growth price needs</span><span className="mb-v">{v.requiredG0 != null ? pct(v.requiredG0) : 'unreachable'}</span></div>
        <div><span className="mb-k">Sector</span><span className="mb-v">{result.sector ? `${result.sector.etf} · ${String(result.sector.label).replace('_', ' ').toLowerCase()}` : 'n/a'}</span></div>
        <div><span className="mb-k">ROIC</span><span className="mb-v">{pct(q.roic)}</span></div>
        <div><span className="mb-k">Gross margin</span><span className="mb-v">{pct(q.gm)}</span></div>
      </div>

      <div className="mb-bars">
        {[['Growth', parts.growth], ['ROIC', parts.roic], ['Valuation', parts.valuation], ['S-curve', parts.stage], ['Moat', parts.moat], ['Balance', parts.balance], ['Sector', parts.sector], ['Sentiment', parts.sentiment]]
          .map(([l, val]) => <Bar key={l} label={l} value={val} />)}
      </div>

      {result.thesis && (
        <div className={`mb-note ${result.thesis.state === 'BROKEN' ? 'bad' : 'ok'}`}>
          <strong>Thesis: {result.thesis.state.toLowerCase()}.</strong>{' '}
          {result.thesis.state === 'BROKEN'
            ? `Sell-worthy causes: ${result.thesis.brokenReasons.join(', ')}.`
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

      <div className="mb-foot">
        <span>Screened {dateFmt(result.asOf)}</span>
        {(result.history || []).length > 1 && (
          <span title="Stable status per run, oldest to newest">
            History: {result.history.map(h => (h.status === 'PASS' ? 'P' : h.status === 'FAIL' ? 'F' : '·')).join(' ')}
          </span>
        )}
      </div>
    </div>
  );
};

// Section inside the portfolio row's expanded panel
export const MultibaggerPanel = ({ result, onRescreen, busy }) => (
  <div className="detail-section mb-section">
    <div className="detail-section-head">
      <span className="detail-section-title">🚀 Compounder Screen</span>
      {onRescreen && (
        <button className="btn-expand" onClick={onRescreen} disabled={busy}>{busy ? 'Screening…' : '↻ Re-screen'}</button>
      )}
    </div>
    {result ? <MultibaggerDetail result={result} /> : <p className="mb-empty">Not screened yet. It runs automatically after the nightly update, or press Re-screen.</p>}
  </div>
);

// ── Screener tab ─────────────────────────────────────────────────────────────
const SPACING_MS = 2500; // 2-3 data calls per stock; keeps the free-tier per-minute limit safe

export const ScreenerView = ({ toast, confirm, onPromote }) => {
  const [entries, setEntries] = useState([]);
  const [results, setResults] = useState({});
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [progress, setProgress] = useState(null);   // { done, total, current }
  const [busySym, setBusySym] = useState(null);
  const [open, setOpen] = useState(null);

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

  const add = async (e) => {
    e?.preventDefault?.();
    const symbol = input.trim().toUpperCase();
    if (!symbol) return;
    setAdding(true);
    const id = toast.loading(`Adding ${symbol}…`);
    try {
      const r = await fetch('/api/portfolio/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
      setEntries(prev => [j.entry, ...prev]); setInput('');
      toast.update(id, 'success', `${symbol} added. Run the screen to check it.`);
    } catch (err) { toast.update(id, 'error', err.message); }
    finally { setAdding(false); }
  };

  const screenOne = async (symbol) => {
    const r = await fetch(`/api/portfolio/watchlist?action=screen&symbol=${encodeURIComponent(symbol)}`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
    setEntries(prev => prev.map(x => (x.symbol === symbol ? j.entry : x)));
    setResults(prev => ({ ...prev, [symbol]: j.result }));
    return j.result;
  };

  const runPending = async () => {
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
  const running = !!progress;

  return (
    <div className="screener">
      <div className="screener-top">
        <div>
          <h2 className="screener-title">Stock Screener</h2>
          <p className="screener-sub">
            Add the stocks you are considering. Each gets a simple PASS or FAIL after a run; the score and explanation open only once it has been screened.
            Individual stocks only, ETFs are not screened.
          </p>
        </div>
        <button className="btn-primary" onClick={runPending} disabled={running || !pending}>
          {running ? `Screening ${progress.done + 1} of ${progress.total}…` : pending ? `Run screen (${pending})` : 'Run screen'}
        </button>
      </div>

      <form className="screener-add" onSubmit={add}>
        <input value={input} onChange={e => setInput(e.target.value.toUpperCase())} placeholder="Ticker, e.g. NVDA" maxLength={10} disabled={adding} />
        <button className="btn-secondary" type="submit" disabled={adding || !input.trim()}>{adding ? 'Adding…' : '+ Add to list'}</button>
      </form>

      {running && (
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
        <div className="mb-empty">No stocks yet. Add a ticker above, then press Run screen.</div>
      ) : (
        <div className="screener-list">
          {entries.map(en => {
            const res = results[en.symbol];
            const screened = !!en.screenedAt;
            const isOpen = open === en.symbol && screened;
            return (
              <div key={en.symbol} className={`screener-row${isOpen ? ' open' : ''}`}>
                <div className="screener-row-main">
                  <div className="screener-id">
                    <strong className="stock-symbol">{en.symbol}</strong>
                    <span className="stock-name">{en.name}</span>
                  </div>
                  <div className="screener-state">
                    <StatusChip status={screened ? en.status : 'PENDING'} />
                    <span className="screener-when">{screened ? `Screened ${dateFmt(en.screenedAt)}` : 'Run the screen to see the result'}</span>
                  </div>
                  <div className="screener-actions">
                    {screened && <button className="btn-expand" onClick={() => setOpen(isOpen ? null : en.symbol)}>{isOpen ? '▲ Hide' : '▼ Details'}</button>}
                    {screened && en.status === 'PASS' && onPromote && <button className="btn-expand" onClick={() => onPromote(en.symbol, en.name)}>＋ Portfolio</button>}
                    <button className="btn-expand" onClick={() => rerun(en.symbol)} disabled={running || busySym === en.symbol}>{busySym === en.symbol ? '…' : '↻'}</button>
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
