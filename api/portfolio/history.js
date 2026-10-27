import React, { useState, useEffect, useCallback, useMemo } from 'react';
import './history.css';

// History tab. Data = daily scores per stock from Supabase (api/portfolio/history).
// Top: portfolio highlights + a feed of signal changes. Below: one card per stock (newest day first).

const RANGES = [15, 30, 60, 90];
const PARTS = [
  { key: 'fund_score',    label: 'Quality' },
  { key: 'analyst_score', label: 'Analysts' },
  { key: 'tech_score',    label: 'Trend' },
  { key: 'news_score',    label: 'News' },
  { key: 'insider_score', label: 'Insiders' },
];
const SORTS = [
  { v: 'symbol', l: 'Sort: Symbol A–Z' },
  { v: 'score',  l: 'Sort: Latest score' },
  { v: 'move',   l: 'Sort: Biggest move' },
  { v: 'signal', l: 'Sort: Signal changed first' },
];

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
const f1 = v => (v == null ? '—' : v.toFixed(1));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const dayShort = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
const dayLong = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const money = n => (n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n));
const daysAgo = iso => Math.max(0, Math.round((Date.now() - new Date(`${iso}T12:00:00Z`).getTime()) / 86400000));

// ── analysis ────────────────────────────────────────────────────────────────
function analyse(row, dates, sig) {
  const series = dates.filter(d => row.data[d]).map(d => ({ d, ...row.data[d] }));        // oldest -> newest
  const scored = series.filter(x => num(x.total_score) != null);
  const first = scored[0] || null, last = scored[scored.length - 1] || null;
  const change = first && last && first !== last ? last.total_score - first.total_score : null;

  // Signal changes compare the DISPLAY label, so HOLD <-> MARKET_NOISE (both "Hold") is not a change
  const events = [];
  let prevSig = null, prevLabel = null, streakStart = 0;
  series.forEach((x, i) => {
    if (!x.signal) return;
    const label = sig(x.signal).label;
    if (prevLabel !== null && label !== prevLabel) {
      events.push({ symbol: row.symbol, date: x.d, from: prevLabel, to: label, fromSignal: prevSig, toSignal: x.signal });
      streakStart = i;
    }
    prevSig = x.signal; prevLabel = label;
  });
  const lastSignalRow = [...series].reverse().find(x => x.signal) || null;
  const streak = lastSignalRow ? { label: sig(lastSignalRow.signal).label, days: series.length - streakStart, since: series[streakStart]?.d } : null;

  return { symbol: row.symbol, series, newest: [...series].reverse(), first, last, change, events, streak, trend: scored.map(x => x.total_score), latestSignal: lastSignalRow?.signal || null };
}

// ── small pieces ────────────────────────────────────────────────────────────
const Delta = ({ now, prev, thresh = 0.3 }) => {
  if (now == null || prev == null) return null;
  const d = now - prev;
  if (Math.abs(d) < thresh) return null;
  return <span className={`hx-delta ${d > 0 ? 'up' : 'down'}`}>{d > 0 ? '▲' : '▼'}{Math.abs(d).toFixed(1)}</span>;
};

const Spark = ({ values, w = 132, h = 36 }) => {
  if (!values || values.length < 2) return <span className="hx-spark-empty">not enough days</span>;
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1, pad = 3;
  const pts = values.map((v, i) => [pad + (i * (w - 2 * pad)) / (values.length - 1), h - pad - ((v - lo) / span) * (h - 2 * pad)]);
  const net = values[values.length - 1] - values[0];
  const col = net > 0.2 ? 'var(--green)' : net < -0.2 ? 'var(--red)' : 'var(--text-dim)';
  const line = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const end = pts[pts.length - 1];
  return (
    <svg className="hx-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Score trend, ${net >= 0 ? 'up' : 'down'} ${Math.abs(net).toFixed(1)}`}>
      <polygon points={`${pad},${h - pad} ${line} ${end[0].toFixed(1)},${h - pad}`} fill={col} opacity="0.10" />
      <polyline points={line} fill="none" stroke={col} strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={end[0]} cy={end[1]} r="2.7" fill={col} />
    </svg>
  );
};

const Badge = ({ signal, sig, small }) => {
  if (!signal) return <span className="hx-dash">—</span>;
  const c = sig(signal);
  return <span className={`hx-badge${small ? ' sm' : ''}`} style={{ color: c.color, background: `${c.color}16`, borderColor: `${c.color}44` }}>{c.label}</span>;
};

// ── highlights ──────────────────────────────────────────────────────────────
const Highlights = ({ items, sig, scoreColor, rangeLabel }) => {
  const withChange = items.filter(a => a.change != null);
  const avgNow = mean(withChange.map(a => a.last.total_score));
  const avgThen = mean(withChange.map(a => a.first.total_score));
  const avgDelta = avgNow != null && avgThen != null ? avgNow - avgThen : null;
  const best = withChange.length ? withChange.reduce((a, b) => (b.change > a.change ? b : a)) : null;
  const worst = withChange.length ? withChange.reduce((a, b) => (b.change < a.change ? b : a)) : null;
  const risky = items.filter(a => a.latestSignal && sig(a.latestSignal).tier === 'bear');
  const events = items.flatMap(a => a.events).sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <>
      <div className="hx-tiles">
        <div className="hx-tile">
          <div className="hx-tile-k">Average score</div>
          <div className="hx-tile-v" style={{ color: scoreColor(avgNow) }}>{f1(avgNow)}<span className="hx-tile-u">/10</span></div>
          <div className="hx-tile-s">{avgDelta == null ? 'needs 2+ days' : <><Delta now={avgNow} prev={avgThen} thresh={0.05} />{Math.abs(avgDelta) < 0.05 ? ' flat' : ''} over {rangeLabel}</>}</div>
        </div>
        <div className="hx-tile good">
          <div className="hx-tile-k">Biggest improver</div>
          <div className="hx-tile-v">{best && best.change > 0 ? best.symbol : '—'}</div>
          <div className="hx-tile-s">{best && best.change > 0 ? `▲ ${best.change.toFixed(1)} · now ${f1(best.last.total_score)}` : 'no stock improved'}</div>
        </div>
        <div className="hx-tile bad">
          <div className="hx-tile-k">Biggest decline</div>
          <div className="hx-tile-v">{worst && worst.change < 0 ? worst.symbol : '—'}</div>
          <div className="hx-tile-s">{worst && worst.change < 0 ? `▼ ${Math.abs(worst.change).toFixed(1)} · now ${f1(worst.last.total_score)}` : 'no stock declined'}</div>
        </div>
        <div className={`hx-tile ${risky.length ? 'bad' : 'good'}`}>
          <div className="hx-tile-k">Risk signals now</div>
          <div className="hx-tile-v">{risky.length}<span className="hx-tile-u"> of {items.length}</span></div>
          <div className="hx-tile-s">{risky.length ? risky.map(a => a.symbol).join(' · ') : 'none: nothing on Watch, Trim or Sell'}</div>
        </div>
      </div>

      <div className="hx-feed">
        <div className="hx-feed-head">Signal changes <span>{events.length ? `${events.length} in ${rangeLabel}` : `none in ${rangeLabel}`}</span></div>
        {events.length === 0 ? (
          <div className="hx-feed-empty">Every stock held the same signal for the whole range.</div>
        ) : (
          <ul className="hx-feed-list">
            {events.slice(0, 8).map(e => (
              <li key={`${e.symbol}-${e.date}`}>
                <span className="hx-feed-date">{dayShort(e.date)}</span>
                <strong>{e.symbol}</strong>
                <Badge signal={e.fromSignal} sig={sig} small /> <span className="hx-arrow">→</span> <Badge signal={e.toSignal} sig={sig} small />
                <span className="hx-feed-ago">{daysAgo(e.date)}d ago</span>
              </li>
            ))}
          </ul>
        )}
        {events.length > 8 && <div className="hx-feed-more">+ {events.length - 8} earlier changes. Open a stock to see its own.</div>}
      </div>
    </>
  );
};

// ── one stock ───────────────────────────────────────────────────────────────
const StockCard = ({ a, sig, scoreColor, open, onToggle, rangeLabel }) => {
  const lastRow = a.last, prevRow = a.newest[1];
  const latestEvent = a.events[a.events.length - 1];
  const dir = a.change == null ? '' : a.change > 0.2 ? 'up' : a.change < -0.2 ? 'down' : '';

  return (
    <div className={`hx-card ${dir}`}>
      <div className="hx-head" onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <span className="hx-chev">{open ? '▾' : '▸'}</span>
        <div className="hx-id">
          <span className="hx-sym">{a.symbol}</span>
          <span className="hx-sub">{a.streak ? `${a.streak.label} for ${a.streak.days} day${a.streak.days === 1 ? '' : 's'}` : `${a.series.length} days`}</span>
        </div>
        <Spark values={a.trend} />
        <div className="hx-score">
          <span className="hx-score-n" style={{ color: scoreColor(lastRow?.total_score) }}>{f1(lastRow?.total_score)}</span>
          {a.change != null && (
            <span className={`hx-score-d ${dir}`}>{a.change > 0 ? '▲' : a.change < 0 ? '▼' : ''} {Math.abs(a.change).toFixed(1)} <em>/ {rangeLabel}</em></span>
          )}
        </div>
        <Badge signal={a.latestSignal} sig={sig} />
      </div>

      <div className="hx-chips">
        {PARTS.map(p => {
          const now = num(lastRow?.[p.key]);
          const then = num(a.first?.[p.key]);
          return (
            <span key={p.key} className="hx-chip" title={`${p.label}: ${f1(now)} now${then != null && a.first !== lastRow ? `, ${f1(then)} on ${dayShort(a.first.d)}` : ''}`}>
              <i>{p.label}</i><b style={{ color: scoreColor(now) }}>{f1(now)}</b><Delta now={now} prev={then} thresh={0.5} />
            </span>
          );
        })}
        {latestEvent && (
          <span className="hx-changed" title={`${latestEvent.from} → ${latestEvent.to} on ${dayLong(latestEvent.date)}`}>
            ● changed {daysAgo(latestEvent.date)}d ago: {latestEvent.from} → {latestEvent.to}
          </span>
        )}
      </div>

      {open && (
        <div className="hx-body">
          <table className="hx-table">
            <thead>
              <tr>
                <th>Date</th><th>Total</th>
                {PARTS.map(p => <th key={p.key}>{p.label}</th>)}
                <th>Signal</th><th className="r">Price</th>
              </tr>
            </thead>
            <tbody>
              {a.newest.map((row, i) => {
                const prev = a.newest[i + 1];
                const changed = prev && row.signal && prev.signal && sig(row.signal).label !== sig(prev.signal).label;
                const dp = prev && num(row.price) != null && num(prev.price) ? ((row.price - prev.price) / prev.price) * 100 : null;
                return (
                  <tr key={row.d} className={changed ? 'chg' : ''}>
                    <td className="hx-date">{dayLong(row.d)}</td>
                    <td className="hx-total" style={{ color: scoreColor(row.total_score) }}>{f1(num(row.total_score))}<Delta now={num(row.total_score)} prev={num(prev?.total_score)} /></td>
                    {PARTS.map(p => {
                      const v = num(row[p.key]), o = num(prev?.[p.key]);
                      const d = v != null && o != null ? v - o : 0;
                      return <td key={p.key} className={`hx-part ${d >= 0.5 ? 'up' : d <= -0.5 ? 'down' : ''}`}>{f1(v)}</td>;
                    })}
                    <td><Badge signal={row.signal} sig={sig} small />{changed && <span className="hx-flag" title={`Changed from ${sig(prev.signal).label}`}>●</span>}</td>
                    <td className="hx-price r">{money(num(row.price))}{dp != null && Math.abs(dp) >= 0.05 && <small className={dp > 0 ? 'up' : 'down'}>{dp > 0 ? '+' : ''}{dp.toFixed(1)}%</small>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ── tab ─────────────────────────────────────────────────────────────────────
const HistoryView = ({ stocks, sig, scoreColor }) => {
  const [days, setDays] = useState(30);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [sortBy, setSortBy] = useState('symbol');
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [openSet, setOpenSet] = useState(() => new Set());

  const symbolsKey = (stocks || []).map(s => s.symbol).join(',');

  const load = useCallback(async () => {
    if (!symbolsKey) return;
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ symbols: symbolsKey });
      if (useCustom && fromDate && toDate) { params.set('from', fromDate); params.set('to', toDate); }
      else params.set('days', days);
      const res = await fetch(`/api/portfolio/history?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHistory(await res.json());
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [symbolsKey, days, fromDate, toDate, useCustom]);
  useEffect(() => { load(); }, [load]);

  const dates = useMemo(() => (history && history.dates) || [], [history]);
  const analysed = useMemo(() => ((history && history.rows) || []).map(r => analyse(r, dates, sig)), [history, dates, sig]);
  const sorted = useMemo(() => {
    const a = [...analysed];
    if (sortBy === 'score') a.sort((x, y) => (y.last?.total_score ?? -1) - (x.last?.total_score ?? -1));
    else if (sortBy === 'move') a.sort((x, y) => Math.abs(y.change ?? 0) - Math.abs(x.change ?? 0));
    else if (sortBy === 'signal') a.sort((x, y) => (y.events[y.events.length - 1]?.date || '').localeCompare(x.events[x.events.length - 1]?.date || '') || x.symbol.localeCompare(y.symbol));
    else a.sort((x, y) => x.symbol.localeCompare(y.symbol));
    return a;
  }, [analysed, sortBy]);

  const rangeLabel = useCustom && fromDate && toDate ? `${dayShort(fromDate)}–${dayShort(toDate)}` : `${days} days`;
  const toggle = sym => setOpenSet(prev => { const n = new Set(prev); if (n.has(sym)) n.delete(sym); else n.add(sym); return n; });
  const allOpen = sorted.length > 0 && sorted.every(a => openSet.has(a.symbol));

  return (
    <div className="hx">
      <div className="hx-toolbar">
        <div className="hx-seg">
          {RANGES.map(d => (
            <button key={d} className={!useCustom && days === d ? 'on' : ''} onClick={() => { setDays(d); setUseCustom(false); }}>{d}d</button>
          ))}
        </div>
        <div className="hx-custom">
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} aria-label="From date" />
          <span>→</span>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} aria-label="To date" />
          <button className={`hx-apply${useCustom ? ' on' : ''}`} disabled={!fromDate || !toDate} onClick={() => setUseCustom(true)}>Apply</button>
        </div>
        <select className="minimal-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          {SORTS.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}
        </select>
        <button className="btn-secondary hx-expand" onClick={() => setOpenSet(allOpen ? new Set() : new Set(sorted.map(a => a.symbol)))}>
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      {error && <div className="hx-msg bad">⚠ Could not load history: {error}</div>}
      {loading && !history && <div className="hx-msg">Loading history…</div>}
      {history && sorted.length === 0 && !loading && <div className="hx-msg">No history stored for this range yet. It builds up after each nightly update.</div>}

      {history && sorted.length > 0 && (
        <>
          <Highlights items={sorted} sig={sig} scoreColor={scoreColor} rangeLabel={rangeLabel} />
          <div className="hx-list">
            {sorted.map(a => (
              <StockCard key={a.symbol} a={a} sig={sig} scoreColor={scoreColor} rangeLabel={rangeLabel}
                open={openSet.has(a.symbol)} onToggle={() => toggle(a.symbol)} />
            ))}
          </div>
          <div className="hx-legend">
            <span>Newest day first · trading days only</span>
            <span><b className="up">▲</b> / <b className="down">▼</b> change vs the day before (score moves under 0.3 are hidden)</span>
            <span><b className="dot">●</b> the signal changed that day</span>
            <span>Green or red cells: a part moved 0.5 or more</span>
          </div>
        </>
      )}
    </div>
  );
};

export default HistoryView;
