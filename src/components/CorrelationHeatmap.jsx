import React, { useState, useEffect, useCallback } from 'react';
import './CorrelationHeatmap.css';

// ── Colour scale — tuned for light white card background ─────────────────────
// Self-correlation diagonal: soft warm grey
// Danger band (≥0.65): keeps the orange/red — pops clearly on white
// Mid-range (0.30–0.65): muted blue-grey with dark text — readable on white
// Uncorrelated/hedge: muted sage green so it doesn't shout
function getCellStyle(value) {
  if (value === 1)     return { background: '#f0efed', color: '#c4c4bc', cursor: 'default' }; // diagonal — warm neutral
  if (value >= 0.85)   return { background: '#7f1d1d', color: '#fecaca' }; // extreme — dark red
  if (value >= 0.75)   return { background: '#b91c1c', color: '#fff'    }; // high — red
  if (value >= 0.65)   return { background: '#ea580c', color: '#fff'    }; // flagged — orange
  if (value >= 0.30)   return { background: '#e2e4ea', color: '#374151' }; // mild — cool grey, dark text
  if (value >= -0.30)  return { background: '#d1fae5', color: '#065f46' }; // uncorrelated — sage green
  return                      { background: '#a7f3d0', color: '#064e3b' }; // hedge — stronger green
}

// Show all non-self values. Use 2 decimal places but strip the leading zero
// (e.g. ".46" not "0.46") — shorter, less visual noise, easier to scan.
function corrLabel(v) {
  if (v === 1) return '—';
  const s = v.toFixed(2);
  // Strip leading zero: "0.46" → ".46", "-0.12" → "-.12"
  return s.replace(/^(-?)0\./, '$1.');
}

// ── Formatting helpers ────────────────────────────────────────────────────────
const fmtPct   = (n, fallback = '—') => n == null ? fallback : `${n >= 0 ? '+' : ''}${Number(n).toFixed(2)}%`;
const fmtScore = (n, fallback = '—') => n == null ? fallback : Number(n).toFixed(1);

const ACTION_COLOR = {
  ADD: '#10b981', SPRING_CONFIRMED: '#059669', SPRING_CANDIDATE: '#34d399',
  HOLD: '#6b7280', HOLD_NOISE: '#9ca3af', MARKET_NOISE: '#9ca3af', NORMAL: '#6b7280',
  WATCH: '#f59e0b', TRIM_25: '#f97316', SELL: '#ef4444', IDIOSYNCRATIC_DECAY: '#991b1b',
};

const CASCADE_COLOR = {
  HEALTHY:   '#10b981',
  WEAKENING: '#f59e0b',
  DECAYING:  '#f97316',
  CRITICAL:  '#ef4444',
};

// ── Main component ────────────────────────────────────────────────────────────
const CorrelationHeatmap = () => {
  const [matrixData, setMatrixData] = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [tooltip,    setTooltip]    = useState(null);
  const [tab,        setTab]        = useState('RECOMMEND'); // 'RECOMMEND' | 'WEAK_SIGNAL' | 'MONITOR'

  useEffect(() => {
    fetch('/api/portfolio/correlation')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setMatrixData(d); })
      .catch(e => console.error('Correlation fetch failed:', e))
      .finally(() => setLoading(false));
  }, []);

  const onMouseEnter = useCallback((e, t1, t2, val) => {
    if (val === 1) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({ t1, t2, val, x: rect.left + rect.width / 2, y: rect.top - 8 });
  }, []);

  const onMouseLeave = useCallback(() => setTooltip(null), []);

  if (loading) {
    return (
      <div className="heatmap-loading">
        <div className="heatmap-loading-ring" />
        <span>Computing correlation matrix…</span>
      </div>
    );
  }
  if (!matrixData?.tickers?.length) return null;

  const { tickers, matrix, insights = [], windowStart, windowEnd, windowDays, lastUpdated } = matrixData;

  const byVerdict = v => insights.filter(i => i.verdict === v);
  const recommends  = byVerdict('RECOMMEND');
  const weak        = byVerdict('WEAK_SIGNAL');
  const monitors    = byVerdict('MONITOR');

  const tabInsights = tab === 'RECOMMEND' ? recommends
                    : tab === 'WEAK_SIGNAL' ? weak
                    : monitors;

  return (
    <div className="correlation-container">

      {/* ── Neural network background animation ────────────────────────────── */}
      <svg className="neural-bg" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="ng1" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#059669" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#059669" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="ng2" cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#d97706" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#d97706" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Layer 1 — slow drift, green tones */}
        <g className="layer1" style={{ transformOrigin: '30% 40%' }}>
          <line x1="8%"  y1="12%" x2="22%" y2="28%" stroke="#059669" strokeWidth="0.6" strokeOpacity="0.15" />
          <line x1="22%" y1="28%" x2="38%" y2="18%" stroke="#059669" strokeWidth="0.6" strokeOpacity="0.12" />
          <line x1="38%" y1="18%" x2="52%" y2="35%" stroke="#059669" strokeWidth="0.6" strokeOpacity="0.10" />
          <line x1="52%" y1="35%" x2="42%" y2="52%" stroke="#059669" strokeWidth="0.6" strokeOpacity="0.12" />
          <line x1="8%"  y1="12%" x2="42%" y2="52%" stroke="#059669" strokeWidth="0.4" strokeOpacity="0.07" />
          <circle className="node" cx="8%"  cy="12%" r="3"   fill="#059669" />
          <circle className="node" cx="22%" cy="28%" r="2.5" fill="#059669" />
          <circle className="node" cx="38%" cy="18%" r="3"   fill="#059669" />
          <circle className="node" cx="52%" cy="35%" r="2"   fill="#059669" />
          <circle className="node" cx="42%" cy="52%" r="2.5" fill="#059669" />
        </g>

        {/* Layer 2 — medium drift, amber tones, right side */}
        <g className="layer2" style={{ transformOrigin: '72% 30%' }}>
          <line x1="65%" y1="10%" x2="80%" y2="26%" stroke="#d97706" strokeWidth="0.6" strokeOpacity="0.10" />
          <line x1="80%" y1="26%" x2="92%" y2="16%" stroke="#d97706" strokeWidth="0.6" strokeOpacity="0.10" />
          <line x1="80%" y1="26%" x2="75%" y2="44%" stroke="#d97706" strokeWidth="0.6" strokeOpacity="0.08" />
          <line x1="65%" y1="10%" x2="75%" y2="44%" stroke="#d97706" strokeWidth="0.4" strokeOpacity="0.06" />
          <circle className="node-slow" cx="65%" cy="10%" r="3"   fill="#d97706" />
          <circle className="node-slow" cx="80%" cy="26%" r="2.5" fill="#d97706" />
          <circle className="node-slow" cx="92%" cy="16%" r="2"   fill="#d97706" />
          <circle className="node-slow" cx="75%" cy="44%" r="3"   fill="#d97706" />
        </g>

        {/* Layer 3 — fast drift, bottom area, neutral grey */}
        <g className="layer3" style={{ transformOrigin: '50% 75%' }}>
          <line x1="15%" y1="72%" x2="32%" y2="85%" stroke="#6b6b65" strokeWidth="0.5" strokeOpacity="0.10" />
          <line x1="32%" y1="85%" x2="55%" y2="78%" stroke="#6b6b65" strokeWidth="0.5" strokeOpacity="0.10" />
          <line x1="55%" y1="78%" x2="70%" y2="88%" stroke="#6b6b65" strokeWidth="0.5" strokeOpacity="0.08" />
          <line x1="15%" y1="72%" x2="55%" y2="78%" stroke="#6b6b65" strokeWidth="0.4" strokeOpacity="0.06" />
          <circle className="node-slow" cx="15%" cy="72%" r="2.5" fill="#a0a09a" />
          <circle className="node-slow" cx="32%" cy="85%" r="2"   fill="#a0a09a" />
          <circle className="node-slow" cx="55%" cy="78%" r="3"   fill="#a0a09a" />
          <circle className="node-slow" cx="70%" cy="88%" r="2"   fill="#a0a09a" />
        </g>

        {/* Soft ambient glow blobs */}
        <ellipse cx="20%" cy="35%" rx="18%" ry="12%" fill="url(#ng1)" />
        <ellipse cx="78%" cy="22%" rx="15%" ry="10%" fill="url(#ng2)" />
      </svg>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="heatmap-header">
        <div>
          <h2>Structural Hedging Matrix</h2>
          <p className="heatmap-subtitle">
            Returns-based Pearson · {windowDays ?? '—'}d rolling window
            {windowStart && windowEnd && (
              <span className="window-range"> · {windowStart} → {windowEnd}</span>
            )}
          </p>
        </div>
        {lastUpdated && (
          <span className="heatmap-updated">
            Updated {new Date(lastUpdated).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>

      {/* ── Heatmap ────────────────────────────────────────────────────────── */}
      <div className="heatmap-scroll">
        <table className="heatmap-table">
          <thead>
            <tr>
              <th className="heatmap-corner" />
              {tickers.map(t => <th key={t} className="heatmap-col-header">{t}</th>)}
            </tr>
          </thead>
          <tbody>
            {tickers.map(row => (
              <tr key={row}>
                <td className="heatmap-row-header">{row}</td>
                {tickers.map(col => {
                  const val   = matrix[row]?.[col] ?? 0;
                  const style = getCellStyle(val);
                  return (
                    <td
                      key={col}
                      className="heatmap-cell"
                      style={{ background: style.background, color: style.color }}
                      onMouseEnter={e => onMouseEnter(e, row, col, val)}
                      onMouseLeave={onMouseLeave}
                    >
                      {corrLabel(val)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Legend ─────────────────────────────────────────────────────────── */}
      <div className="heatmap-legend">
        {[
          { bg: '#7f1d1d', label: 'Extreme ≥0.85' },
          { bg: '#b91c1c', label: 'High ≥0.75'    },
          { bg: '#ea580c', label: 'Flagged ≥0.65' },
          { bg: '#e2e4ea', label: 'Mild 0.30–0.65', border: '#c4c8d4' },
          { bg: '#d1fae5', label: 'Uncorrelated',   border: '#a7f3d0' },
          { bg: '#a7f3d0', label: 'Hedge',          border: '#6ee7b7' },
        ].map(({ bg, label, border }) => (
          <div className="legend-item" key={label}>
            <span className="legend-swatch"
              style={{ background: bg, border: border ? `1px solid ${border}` : 'none' }} />
            <span>{label}</span>
          </div>
        ))}
        <span className="legend-note">Returns-based · 250d rolling</span>
      </div>

      {/* ── Capital Optimisation ───────────────────────────────────────────── */}
      {insights.length > 0 && (
        <div className="insights-section">

          <div className="insights-head">
            <div>
              <h3>Capital Optimisation</h3>
              <p className="insights-sub">
                Recommendations are conviction-gated across alpha edge, cascade health,
                regime status and quality score — both over 21d and 63d windows.
              </p>
            </div>
          </div>

          {/* Verdict tabs */}
          <div className="verdict-tabs">
            <button
              className={`vtab ${tab === 'RECOMMEND' ? 'vtab-active recommend' : ''}`}
              onClick={() => setTab('RECOMMEND')}
            >
              ✓ Recommend
              {recommends.length > 0 && <span className="vtab-count">{recommends.length}</span>}
            </button>
            <button
              className={`vtab ${tab === 'WEAK_SIGNAL' ? 'vtab-active weak' : ''}`}
              onClick={() => setTab('WEAK_SIGNAL')}
            >
              ~ Weak Signal
              {weak.length > 0 && <span className="vtab-count">{weak.length}</span>}
            </button>
            <button
              className={`vtab ${tab === 'MONITOR' ? 'vtab-active monitor' : ''}`}
              onClick={() => setTab('MONITOR')}
            >
              ◎ Monitor
              {monitors.length > 0 && <span className="vtab-count">{monitors.length}</span>}
            </button>
          </div>

          {/* Tab description */}
          <p className="tab-desc">
            {tab === 'RECOMMEND' && 'All conviction gates passed. Alpha edge is material and confirmed across both 21d and 63d windows. Structural health of the preferred ticker is verified.'}
            {tab === 'WEAK_SIGNAL' && 'A preferred ticker exists but the edge is thin. Watch for further divergence before acting. Not enough data-proven conviction to recommend a switch yet.'}
            {tab === 'MONITOR'    && 'Correlated pair flagged but no clear winner. Either insufficient data, both tickers in decay, or performance is too similar to justify a recommendation.'}
          </p>

          {tabInsights.length === 0 ? (
            <div className="no-insights">No {tab.replace('_', ' ').toLowerCase()} pairs at this time.</div>
          ) : (
            <div className="insights-grid">
              {tabInsights.map((ins, idx) => (
                <InsightCard key={idx} insight={ins} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Hover tooltip ──────────────────────────────────────────────────── */}
      {tooltip && (
        <div className="heatmap-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <strong>{tooltip.t1}</strong> vs <strong>{tooltip.t2}</strong>
          <span className="tooltip-val">{tooltip.val.toFixed(3)}</span>
        </div>
      )}
    </div>
  );
};

// ── Insight Card ──────────────────────────────────────────────────────────────
const InsightCard = ({ insight }) => {
  const {
    pair, correlation, corrTier, verdict, verdictReason,
    winner, loser,
    winnerAlpha21, winnerAlpha63, winnerQual63, winnerCascade, winnerAction,
    loserAlpha21,  loserAlpha63,  loserQual63,  loserCascade,  loserAction,
    winnerReasons = [],
    t1Stats, t2Stats,
  } = insight;

  const tierColor = corrTier === 'extreme' ? '#7f1d1d'
                  : corrTier === 'high'    ? '#b91c1c'
                  : '#f97316';

  const verdictColor = verdict === 'RECOMMEND'   ? '#10b981'
                     : verdict === 'WEAK_SIGNAL'  ? '#f59e0b'
                     : '#6b7280';

  // MONITOR card (no winner)
  if (!winner) {
    return (
      <div className="insight-card monitor-card">
        <div className="insight-card-head">
          <div className="insight-symbols">
            <span className="insight-sym">{pair[0]}</span>
            <span className="insight-sep">↔</span>
            <span className="insight-sym">{pair[1]}</span>
          </div>
          <span className="insight-corr-badge"
            style={{ background: `${tierColor}20`, color: tierColor, borderColor: `${tierColor}40` }}>
            {corrTier === 'extreme' ? 'Extreme' : corrTier === 'high' ? 'High' : 'Flagged'} · {(correlation * 100).toFixed(0)}%
          </span>
        </div>
        <p className="monitor-reason">{verdictReason}</p>
        {/* Show raw stats if available so user can judge themselves */}
        {(t1Stats || t2Stats) && (
          <div className="monitor-stats">
            {[
              { sym: pair[0], s: t1Stats },
              { sym: pair[1], s: t2Stats },
            ].map(({ sym, s }) => s && (
              <div key={sym} className="monitor-stat-col">
                <span className="monitor-sym">{sym}</span>
                <span className="monitor-stat-row">
                  α21: <strong style={{ color: (s.alpha21 ?? 0) >= 0 ? '#10b981' : '#ef4444' }}>{fmtPct(s.alpha21)}</strong>
                </span>
                <span className="monitor-stat-row">
                  Q63: <strong>{fmtScore(s.qual63)}/10</strong>
                </span>
                <span className="monitor-stat-row" style={{ color: CASCADE_COLOR[s.cascadeHealth] || '#6b7280' }}>
                  {s.cascadeHealth || '—'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // RECOMMEND or WEAK_SIGNAL card (winner identified)
  const alphaEdge = ((winnerAlpha21 ?? 0) - (loserAlpha21 ?? 0));

  return (
    <div className={`insight-card ${verdict === 'RECOMMEND' ? 'recommend-card' : 'weak-card'}`}>

      {/* Header */}
      <div className="insight-card-head">
        <div className="insight-symbols">
          <span className="insight-sym">{pair[0]}</span>
          <span className="insight-sep">↔</span>
          <span className="insight-sym">{pair[1]}</span>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <span className="verdict-chip"
            style={{ background: `${verdictColor}18`, color: verdictColor, borderColor: `${verdictColor}35` }}>
            {verdict === 'RECOMMEND' ? '✓ Recommend' : '~ Weak Signal'}
          </span>
          <span className="insight-corr-badge"
            style={{ background: `${tierColor}20`, color: tierColor, borderColor: `${tierColor}40` }}>
            {(correlation * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      {/* Conviction evidence */}
      {winnerReasons.length > 0 && (
        <div className="evidence-list">
          {winnerReasons.map((r, i) => (
            <span key={i} className="evidence-item">✓ {r}</span>
          ))}
        </div>
      )}

      {/* Side-by-side comparison */}
      <div className="insight-compare">

        {/* Winner */}
        <div className="insight-col winner-col">
          <div className="col-role retain">Retain</div>
          <div className="insight-sym-lg">{winner}</div>
          <div className="insight-action-tag"
            style={{ color: ACTION_COLOR[winnerAction] || '#6b7280' }}>
            {winnerAction?.replace(/_/g, ' ') || '—'}
          </div>
          <div className="insight-cascade"
            style={{ color: CASCADE_COLOR[winnerCascade] || '#6b7280' }}>
            {winnerCascade || '—'}
          </div>
          <div className="insight-metrics">
            <MetricRow label="α21" value={fmtPct(winnerAlpha21)} positive={winnerAlpha21 >= 0} />
            <MetricRow label="α63" value={fmtPct(winnerAlpha63)} positive={winnerAlpha63 >= 0} />
            <MetricRow label="Q"   value={`${fmtScore(winnerQual63)}/10`} />
          </div>
        </div>

        {/* Divider with edge */}
        <div className="insight-divider">
          <span className="edge-label">α edge</span>
          <span className="edge-value" style={{ color: '#10b981' }}>
            {alphaEdge >= 0 ? '+' : ''}{alphaEdge.toFixed(1)}%
          </span>
          <span className="edge-period">21d avg</span>
        </div>

        {/* Loser */}
        <div className="insight-col loser-col">
          <div className="col-role review">Review</div>
          <div className="insight-sym-lg" style={{ color: 'var(--text-2, #9aa0b0)' }}>{loser}</div>
          <div className="insight-action-tag"
            style={{ color: ACTION_COLOR[loserAction] || '#6b7280' }}>
            {loserAction?.replace(/_/g, ' ') || '—'}
          </div>
          <div className="insight-cascade"
            style={{ color: CASCADE_COLOR[loserCascade] || '#6b7280' }}>
            {loserCascade || '—'}
          </div>
          <div className="insight-metrics">
            <MetricRow label="α21" value={fmtPct(loserAlpha21)}  positive={loserAlpha21 >= 0}  right />
            <MetricRow label="α63" value={fmtPct(loserAlpha63)}  positive={loserAlpha63 >= 0}  right />
            <MetricRow label="Q"   value={`${fmtScore(loserQual63)}/10`} right />
          </div>
        </div>
      </div>

      {/* Footnote */}
      <p className="insight-note">
        {verdict === 'RECOMMEND'
          ? `Data-confirmed edge across both 21d and 63d windows. If ${loser} shows further weakness, consider trimming on a green day and reallocating to ${winner}.`
          : `Early signal — edge exists but lacks 63d confirmation. Watch for another 2–3 weeks before acting. Avoid moving capital on a single window.`
        }
      </p>
    </div>
  );
};

// ── Small helper: one metric row inside a card column ────────────────────────
const MetricRow = ({ label, value, positive, right = false }) => (
  <span className={`metric-row ${right ? 'metric-right' : ''}`}>
    <span className="metric-lbl">{label}</span>
    <span
      className="metric-val"
      style={positive !== undefined
        ? { color: positive ? '#10b981' : '#ef4444' }
        : undefined}
    >
      {value}
    </span>
  </span>
);

export default CorrelationHeatmap;
