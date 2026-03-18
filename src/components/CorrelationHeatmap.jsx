import React, { useState, useEffect, useCallback } from 'react';
import './CorrelationHeatmap.css';

// ── Colour scale ───────────────────────────────────────────────────────────────
function getCellStyle(value) {
  if (value === 1)    return { background: '#ebe9e3', color: 'transparent', cursor: 'default', bandColor: null };
  if (value >= 0.85)  return { background: '#7f1d1d', color: '#fecaca', bandColor: '#fca5a5' };
  if (value >= 0.75)  return { background: '#b91c1c', color: '#fff',    bandColor: '#fca5a5' };
  if (value >= 0.65)  return { background: '#ea580c', color: '#fff',    bandColor: '#fdba74' };
  if (value >= 0.30)  return { background: '#dddbd3', color: '#374151', bandColor: '#6b7280' };
  if (value >= -0.30) return { background: '#d1fae5', color: '#065f46', bandColor: '#059669' };
  return                     { background: '#a7f3d0', color: '#064e3b', bandColor: '#047857' };
}

function corrLabel(v) {
  if (v === 1) return '—';
  return v.toFixed(2).replace(/^(-?)0\./, '$1.');
}

const fmtPct   = (n, fb = '—') => n == null ? fb : `${n >= 0 ? '+' : ''}${Number(n).toFixed(2)}%`;
const fmtScore = (n, fb = '—') => n == null ? fb : Number(n).toFixed(1);

const ACTION_COLOR = {
  ADD: '#059669', SPRING_CONFIRMED: '#047857', SPRING_CANDIDATE: '#10b981',
  HOLD: '#6b7280', HOLD_NOISE: '#9ca3af', MARKET_NOISE: '#9ca3af', NORMAL: '#6b7280',
  WATCH: '#d97706', TRIM_25: '#ea580c', SELL: '#b91c1c', IDIOSYNCRATIC_DECAY: '#7f1d1d',
};
const CASCADE_COLOR = {
  HEALTHY: '#059669', WEAKENING: '#d97706', DECAYING: '#ea580c', CRITICAL: '#b91c1c',
};

// ── Neural background — green bull network + red bear network ──────────────────
// Opacity values 0.25–0.55 on nodes, 0.18–0.28 on lines — clearly visible
// but background-level. CSS animations (drift1/2/3, node-pulse) run in the CSS.
const NeuralBackground = () => (
  <svg className="neural-bg" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="ng-green" cx="50%" cy="50%" r="50%">
        <stop offset="0%"   stopColor="#059669" stopOpacity="0.22"/>
        <stop offset="100%" stopColor="#059669" stopOpacity="0"/>
      </radialGradient>
      <radialGradient id="ng-red" cx="50%" cy="50%" r="50%">
        <stop offset="0%"   stopColor="#dc2626" stopOpacity="0.18"/>
        <stop offset="100%" stopColor="#dc2626" stopOpacity="0"/>
      </radialGradient>
    </defs>

    {/* Layer 1 — green bull network, top-left, drifts on drift1 */}
    <g className="layer1" style={{ transformOrigin: '25% 32%' }}>
      <line x1="4%"  y1="9%"  x2="19%" y2="27%" stroke="#059669" strokeWidth="1.2" strokeOpacity="0.28"/>
      <line x1="19%" y1="27%" x2="35%" y2="15%" stroke="#059669" strokeWidth="1.2" strokeOpacity="0.25"/>
      <line x1="35%" y1="15%" x2="50%" y2="31%" stroke="#059669" strokeWidth="1.2" strokeOpacity="0.22"/>
      <line x1="50%" y1="31%" x2="40%" y2="50%" stroke="#059669" strokeWidth="1.2" strokeOpacity="0.24"/>
      <line x1="4%"  y1="9%"  x2="40%" y2="50%" stroke="#059669" strokeWidth="0.7" strokeOpacity="0.14"/>
      <line x1="19%" y1="27%" x2="40%" y2="50%" stroke="#059669" strokeWidth="0.7" strokeOpacity="0.12"/>
      <circle className="node-green"      cx="4%"  cy="9%"  r="4.5" fill="#059669" opacity="0.42"/>
      <circle className="node-green"      cx="19%" cy="27%" r="4"   fill="#059669" opacity="0.38"/>
      <circle className="node-green"      cx="35%" cy="15%" r="4.5" fill="#059669" opacity="0.40"/>
      <circle className="node-green-slow" cx="50%" cy="31%" r="3.5" fill="#059669" opacity="0.32"/>
      <circle className="node-green-slow" cx="40%" cy="50%" r="4"   fill="#059669" opacity="0.35"/>
    </g>

    {/* Layer 2 — red bear network, right side, drifts on drift2 */}
    <g className="layer2" style={{ transformOrigin: '76% 26%' }}>
      <line x1="63%" y1="7%"  x2="79%" y2="23%" stroke="#dc2626" strokeWidth="1.2" strokeOpacity="0.24"/>
      <line x1="79%" y1="23%" x2="94%" y2="13%" stroke="#dc2626" strokeWidth="1.2" strokeOpacity="0.22"/>
      <line x1="79%" y1="23%" x2="75%" y2="42%" stroke="#dc2626" strokeWidth="1.2" strokeOpacity="0.20"/>
      <line x1="63%" y1="7%"  x2="75%" y2="42%" stroke="#dc2626" strokeWidth="0.7" strokeOpacity="0.13"/>
      <line x1="94%" y1="13%" x2="86%" y2="36%" stroke="#dc2626" strokeWidth="0.7" strokeOpacity="0.13"/>
      <circle className="node-red"      cx="63%" cy="7%"  r="4.5" fill="#dc2626" opacity="0.38"/>
      <circle className="node-red"      cx="79%" cy="23%" r="4"   fill="#dc2626" opacity="0.34"/>
      <circle className="node-red"      cx="94%" cy="13%" r="3.5" fill="#dc2626" opacity="0.30"/>
      <circle className="node-red-slow" cx="75%" cy="42%" r="4.5" fill="#dc2626" opacity="0.28"/>
      <circle className="node-red-slow" cx="86%" cy="36%" r="3.5" fill="#dc2626" opacity="0.26"/>
    </g>

    {/* Layer 3 — neutral connector, bottom, drifts on drift3 */}
    <g className="layer3" style={{ transformOrigin: '50% 78%' }}>
      <line x1="11%" y1="70%" x2="29%" y2="84%" stroke="#6b6b65" strokeWidth="0.9" strokeOpacity="0.18"/>
      <line x1="29%" y1="84%" x2="51%" y2="76%" stroke="#6b6b65" strokeWidth="0.9" strokeOpacity="0.16"/>
      <line x1="51%" y1="76%" x2="67%" y2="86%" stroke="#6b6b65" strokeWidth="0.9" strokeOpacity="0.14"/>
      <line x1="67%" y1="86%" x2="84%" y2="74%" stroke="#6b6b65" strokeWidth="0.9" strokeOpacity="0.12"/>
      <line x1="11%" y1="70%" x2="51%" y2="76%" stroke="#6b6b65" strokeWidth="0.5" strokeOpacity="0.09"/>
      <circle className="node-slow" cx="11%" cy="70%" r="3.5" fill="#a0a09a" opacity="0.34"/>
      <circle className="node-slow" cx="29%" cy="84%" r="3"   fill="#a0a09a" opacity="0.28"/>
      <circle className="node-slow" cx="51%" cy="76%" r="4"   fill="#a0a09a" opacity="0.32"/>
      <circle className="node-slow" cx="67%" cy="86%" r="3"   fill="#a0a09a" opacity="0.26"/>
      <circle className="node-slow" cx="84%" cy="74%" r="3.5" fill="#a0a09a" opacity="0.24"/>
    </g>

    {/* Ambient glow blobs */}
    <ellipse cx="18%" cy="32%" rx="22%" ry="15%" fill="url(#ng-green)"/>
    <ellipse cx="80%" cy="20%" rx="20%" ry="13%" fill="url(#ng-red)"/>
  </svg>
);

// ── Main component ─────────────────────────────────────────────────────────────
const CorrelationHeatmap = () => {
  const [matrixData, setMatrixData] = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [tooltip,    setTooltip]    = useState(null);
  const [tab,        setTab]        = useState('RECOMMEND');

  useEffect(() => {
    fetch('/api/portfolio/correlation')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setMatrixData(d); })
      .catch(e => console.error('Correlation fetch failed:', e))
      .finally(() => setLoading(false));
  }, []);

  // Tooltip tracks mouse position directly for accurate placement
  const onMouseMove = useCallback((e, t1, t2, val) => {
    if (val === 1) return;
    const { bandColor } = getCellStyle(val);
    setTooltip({ t1, t2, val, bandColor, x: e.clientX, y: e.clientY });
  }, []);

  const onMouseLeave = useCallback(() => setTooltip(null), []);

  if (loading) {
    return (
      <div className="heatmap-loading">
        <div className="heatmap-loading-ring"/>
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
  const tabInsights = tab === 'RECOMMEND' ? recommends : tab === 'WEAK_SIGNAL' ? weak : monitors;

  return (
    <div className="correlation-container">
      <NeuralBackground/>

      {/* Header */}
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

      {/* ── Side-by-side: heatmap left, capital optimisation right ── */}
      <div className="heatmap-body">

        {/* Left — heatmap + legend */}
        <div className="heatmap-left">
          <div className="heatmap-scroll">
            <table className="heatmap-table">
              <thead>
                <tr>
                  <th className="heatmap-corner"/>
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
                          style={{ background: style.background, color: style.color, cursor: style.cursor || 'crosshair' }}
                          onMouseMove={e => onMouseMove(e, row, col, val)}
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

          {/* Legend sits below the heatmap in the left column */}
          <div className="heatmap-legend">
            {[
              { bg: '#7f1d1d', label: 'Extreme ≥0.85' },
              { bg: '#b91c1c', label: 'High ≥0.75' },
              { bg: '#ea580c', label: 'Flagged ≥0.65' },
              { bg: '#dddbd3', label: 'Mild 0.30–0.65', border: '#c4c2ba' },
              { bg: '#d1fae5', label: 'Uncorrelated',   border: '#a7f3d0' },
              { bg: '#a7f3d0', label: 'Hedge',          border: '#6ee7b7' },
            ].map(({ bg, label, border }) => (
              <div className="legend-item" key={label}>
                <span className="legend-swatch" style={{ background: bg, border: border ? `1px solid ${border}` : 'none' }}/>
                <span>{label}</span>
              </div>
            ))}
            <span className="legend-note">Returns-based · 250d rolling</span>
          </div>
        </div>

        {/* Right — capital optimisation */}
        {insights.length > 0 && (
          <div className="heatmap-right">
            <div className="insights-section">
              <div className="insights-head">
                <h3>Capital Optimisation</h3>
                <p className="insights-sub">
                  Conviction-gated across alpha edge, cascade health and quality — 21d &amp; 63d windows.
                </p>
              </div>

              <div className="verdict-tabs">
                {[
                  { v: 'RECOMMEND',   cls: 'recommend', label: '✓ Recommend',   count: recommends.length },
                  { v: 'WEAK_SIGNAL', cls: 'weak',      label: '~ Weak Signal', count: weak.length },
                  { v: 'MONITOR',     cls: 'monitor',   label: '◎ Monitor',     count: monitors.length },
                ].map(({ v, cls, label, count }) => (
                  <button key={v} className={`vtab ${tab === v ? `vtab-active ${cls}` : ''}`}
                    onClick={() => setTab(v)}>
                    {label}
                    {count > 0 && <span className="vtab-count">{count}</span>}
                  </button>
                ))}
              </div>

              <p className="tab-desc">
                {tab === 'RECOMMEND'   && 'All conviction gates passed. Edge confirmed across both windows.'}
                {tab === 'WEAK_SIGNAL' && 'Edge exists but lacks 63d confirmation. Watch before acting.'}
                {tab === 'MONITOR'     && 'Correlated pair flagged but no clear winner yet.'}
              </p>

              {tabInsights.length === 0 ? (
                <div className="no-insights">No {tab.replace('_',' ').toLowerCase()} pairs right now.</div>
              ) : (
                <div className="insights-grid">
                  {tabInsights.map((ins, idx) => <InsightCard key={idx} insight={ins}/>)}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Tooltip — tracks mouse, value coloured to match cell band */}
      {tooltip && (
        <div
          className="heatmap-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <span className="tooltip-tickers">
            {tooltip.t1} <span className="tooltip-sep">vs</span> {tooltip.t2}
          </span>
          <span className="tooltip-val" style={{ color: tooltip.bandColor || '#f0f0ee' }}>
            {tooltip.val.toFixed(3)}
          </span>
        </div>
      )}
    </div>
  );
};

// ── Insight Card ───────────────────────────────────────────────────────────────
const InsightCard = ({ insight }) => {
  const {
    pair, correlation, corrTier, verdict, verdictReason,
    winner, loser,
    winnerAlpha21, winnerAlpha63, winnerQual63, winnerCascade, winnerAction,
    loserAlpha21,  loserAlpha63,  loserQual63,  loserCascade,  loserAction,
    winnerReasons = [],
    t1Stats, t2Stats,
  } = insight;

  const tierColor = corrTier === 'extreme' ? '#7f1d1d' : corrTier === 'high' ? '#b91c1c' : '#f97316';
  const verdictColor = verdict === 'RECOMMEND' ? '#10b981' : verdict === 'WEAK_SIGNAL' ? '#f59e0b' : '#6b7280';

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
        {(t1Stats || t2Stats) && (
          <div className="monitor-stats">
            {[{ sym: pair[0], s: t1Stats }, { sym: pair[1], s: t2Stats }].map(({ sym, s }) => s && (
              <div key={sym} className="monitor-stat-col">
                <span className="monitor-sym">{sym}</span>
                <span className="monitor-stat-row">
                  α21: <strong style={{ color: (s.alpha21 ?? 0) >= 0 ? '#059669' : '#dc2626' }}>{fmtPct(s.alpha21)}</strong>
                </span>
                <span className="monitor-stat-row">Q63: <strong>{fmtScore(s.qual63)}/10</strong></span>
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

  const alphaEdge = ((winnerAlpha21 ?? 0) - (loserAlpha21 ?? 0));

  return (
    <div className={`insight-card ${verdict === 'RECOMMEND' ? 'recommend-card' : 'weak-card'}`}>
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

      {winnerReasons.length > 0 && (
        <div className="evidence-list">
          {winnerReasons.map((r, i) => <span key={i} className="evidence-item">✓ {r}</span>)}
        </div>
      )}

      <div className="insight-compare">
        <div className="insight-col winner-col">
          <div className="col-role retain">Retain</div>
          <div className="insight-sym-lg">{winner}</div>
          <div className="insight-action-tag" style={{ color: ACTION_COLOR[winnerAction] || '#6b7280' }}>
            {winnerAction?.replace(/_/g, ' ') || '—'}
          </div>
          <div className="insight-cascade" style={{ color: CASCADE_COLOR[winnerCascade] || '#6b7280' }}>
            {winnerCascade || '—'}
          </div>
          <div className="insight-metrics">
            <MetricRow label="α21" value={fmtPct(winnerAlpha21)} positive={winnerAlpha21 >= 0}/>
            <MetricRow label="α63" value={fmtPct(winnerAlpha63)} positive={winnerAlpha63 >= 0}/>
            <MetricRow label="Q"   value={`${fmtScore(winnerQual63)}/10`}/>
          </div>
        </div>

        <div className="insight-divider">
          <span className="edge-label">α edge</span>
          <span className="edge-value" style={{ color: '#059669' }}>
            {alphaEdge >= 0 ? '+' : ''}{alphaEdge.toFixed(1)}%
          </span>
          <span className="edge-period">21d</span>
        </div>

        <div className="insight-col loser-col">
          <div className="col-role review">Review</div>
          <div className="insight-sym-lg" style={{ color: '#9aa0b0' }}>{loser}</div>
          <div className="insight-action-tag" style={{ color: ACTION_COLOR[loserAction] || '#6b7280' }}>
            {loserAction?.replace(/_/g, ' ') || '—'}
          </div>
          <div className="insight-cascade" style={{ color: CASCADE_COLOR[loserCascade] || '#6b7280' }}>
            {loserCascade || '—'}
          </div>
          <div className="insight-metrics">
            <MetricRow label="α21" value={fmtPct(loserAlpha21)}  positive={loserAlpha21 >= 0}  right/>
            <MetricRow label="α63" value={fmtPct(loserAlpha63)}  positive={loserAlpha63 >= 0}  right/>
            <MetricRow label="Q"   value={`${fmtScore(loserQual63)}/10`} right/>
          </div>
        </div>
      </div>

      <p className="insight-note">
        {verdict === 'RECOMMEND'
          ? `Edge confirmed across both windows. Consider trimming ${loser} on a green day and adding to ${winner}.`
          : `Early signal — lacks 63d confirmation. Watch 2–3 more weeks before moving capital.`
        }
      </p>
    </div>
  );
};

const MetricRow = ({ label, value, positive, right = false }) => (
  <span className={`metric-row ${right ? 'metric-right' : ''}`}>
    <span className="metric-lbl">{label}</span>
    <span className="metric-val"
      style={positive !== undefined ? { color: positive ? '#059669' : '#dc2626' } : undefined}>
      {value}
    </span>
  </span>
);

export default CorrelationHeatmap;
