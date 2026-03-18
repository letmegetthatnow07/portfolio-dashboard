import React, { useState, useEffect, useCallback, useRef } from 'react';
import './CorrelationHeatmap.css';

// ── Colour scale ──────────────────────────────────────────────────────────────
function getCellStyle(value) {
  if (value === 1)    return { background: '#ebe9e3', color: 'transparent', cursor: 'default', bandColor: null, bandLabel: 'diagonal' };
  if (value >= 0.85)  return { background: '#7f1d1d', color: '#fecaca', bandColor: '#fca5a5', bandLabel: 'Extreme' };
  if (value >= 0.75)  return { background: '#b91c1c', color: '#fff',    bandColor: '#f87171', bandLabel: 'High' };
  if (value >= 0.65)  return { background: '#ea580c', color: '#fff',    bandColor: '#fb923c', bandLabel: 'Flagged' };
  if (value >= 0.30)  return { background: '#dddbd3', color: '#374151', bandColor: '#9ca3af', bandLabel: 'Mild' };
  if (value >= -0.30) return { background: '#d1fae5', color: '#065f46', bandColor: '#34d399', bandLabel: 'Uncorrelated' };
  return                     { background: '#a7f3d0', color: '#064e3b', bandColor: '#059669', bandLabel: 'Hedge' };
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

// ── Canvas Neural Background for heatmap — stock-like vertical motion ────────
// Module-level node state — never resets on React re-render or UI action
const _hmNodes = [];
let _hmReady = false;

const buildHmNodes = (W, H) => {
  _hmNodes.length = 0;
  const COLORS = [
    { c: '#059669', a: () => 0.36 + Math.random() * 0.18 },
    { c: '#dc2626', a: () => 0.32 + Math.random() * 0.16 },
    { c: '#a0a09a', a: () => 0.14 + Math.random() * 0.10 },
  ];
  const pick = () => {
    const r = Math.random();
    return r < 0.38 ? COLORS[0] : r < 0.76 ? COLORS[1] : COLORS[2];
  };
  const COUNT = 18;
  for (let i = 0; i < COUNT; i++) {
    const col = pick();
    _hmNodes.push({
      x: W * (0.04 + Math.random() * 0.92),
      y: H * (i / COUNT + Math.random() * (1 / COUNT)), // evenly spread
      vx: (Math.random() - 0.5) * 0.28,
      vy: (Math.random() < 0.5 ? 1 : -1) * (0.22 + Math.random() * 0.32),
      oAmp: 28 + Math.random() * 45,
      oPeriod: 4 + Math.random() * 8,
      oPhase: Math.random() * Math.PI * 2,
      r: 1.8 + Math.random() * 1.8,
      color: col.c, alpha: col.a(),
      pulseOffset: Math.random() * Math.PI * 2,
      pulseSpeed: 0.008 + Math.random() * 0.014,
    });
  }
  _hmReady = true;
};

const NeuralBackground = () => {
  const canvasRef = useRef(null);
  const mouseRef  = useRef({ x: -9999, y: -9999 });
  const rafRef    = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const container = canvas.parentElement;

    const resize = () => {
      canvas.width  = container.offsetWidth;
      canvas.height = container.offsetHeight;
      if (!_hmReady) buildHmNodes(canvas.width, canvas.height);
    };

    const onMouse = e => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onLeave = () => { mouseRef.current = { x: -9999, y: -9999 }; };
    canvas.addEventListener('mousemove', onMouse);
    canvas.addEventListener('mouseleave', onLeave);

    const EDGE_DIST = 120, REPEL_DIST = 90, REPEL_FORCE = 1.5;
    const H_DAMP = 0.93, V_DAMP = 0.984, H_RESTORE = 0.014, MAX_SPD = 2.0;

    const draw = (t) => {
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      const nodes = _hmNodes;
      const mx = mouseRef.current.x, my = mouseRef.current.y;
      const now = t * 0.001;

      for (const n of nodes) {
        n.vy += Math.sin(now / n.oPeriod * Math.PI * 2 + n.oPhase) * 0.032;
        n.vx += (Math.random() - 0.5) * 0.025;
        n.vy += (Math.random() - 0.5) * 0.025;
        n.vx -= n.vx * H_RESTORE;
        const dx = n.x - mx, dy = n.y - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < REPEL_DIST && dist > 0) {
          const f = (REPEL_DIST - dist) / REPEL_DIST * REPEL_FORCE;
          n.vx += (dx / dist) * f; n.vy += (dy / dist) * f;
        }
        n.vx *= H_DAMP; n.vy *= V_DAMP;
        const spd = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (spd > MAX_SPD) { n.vx = n.vx / spd * MAX_SPD; n.vy = n.vy / spd * MAX_SPD; }
        n.x += n.vx; n.y += n.vy;
        if (n.x < 0) { n.x = 0; n.vx = Math.abs(n.vx) * 0.6; }
        if (n.x > W) { n.x = W; n.vx = -Math.abs(n.vx) * 0.6; }
        if (n.y < 0) n.y = H; // vertical wrap
        if (n.y > H) n.y = 0;
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > EDGE_DIST) continue;
          const ea = (1 - d / EDGE_DIST) * 0.13;
          const col = a.color === '#a0a09a' ? b.color : a.color;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = col === '#059669' ? `rgba(5,150,105,${ea})`
                          : col === '#dc2626' ? `rgba(220,38,38,${ea})`
                          :                    `rgba(160,160,154,${ea})`;
          ctx.lineWidth = 1; ctx.stroke();
        }
      }

      for (const n of nodes) {
        const pulse = 0.82 + 0.18 * Math.sin(now * n.pulseSpeed * 60 + n.pulseOffset);
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * pulse, 0, Math.PI * 2);
        ctx.fillStyle = n.color === '#059669' ? `rgba(5,150,105,${n.alpha * pulse})`
                      : n.color === '#dc2626' ? `rgba(220,38,38,${n.alpha * pulse})`
                      :                        `rgba(160,160,154,${n.alpha * pulse})`;
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      canvas.removeEventListener('mousemove', onMouse);
      canvas.removeEventListener('mouseleave', onLeave);
    };
  }, []); // never re-runs

  return <canvas ref={canvasRef} className="neural-bg-canvas" aria-hidden="true"/>;
};

// ── Main component ────────────────────────────────────────────────────────────
const CorrelationHeatmap = () => {
  const [matrixData, setMatrixData] = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [hoverTip,   setHoverTip]   = useState(null);   // follows mouse
  const [pinnedTip,  setPinnedTip]  = useState(null);   // click-to-lock
  const [tab,        setTab]        = useState('RECOMMEND');

  useEffect(() => {
    fetch('/api/portfolio/correlation')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setMatrixData(d); })
      .catch(e => console.error('Correlation fetch failed:', e))
      .finally(() => setLoading(false));
  }, []);

  // Hover: show floating tooltip following the mouse
  const onMouseMove = useCallback((e, t1, t2, val) => {
    if (val === 1) return;
    const style = getCellStyle(val);
    setHoverTip({ t1, t2, val, style, x: e.clientX, y: e.clientY });
  }, []);

  const onMouseLeave = useCallback(() => setHoverTip(null), []);

  // Click: pin a card near the cell. Second click on same cell unpins.
  const onCellClick = useCallback((e, t1, t2, val) => {
    if (val === 1) return;
    e.stopPropagation();
    const style = getCellStyle(val);
    // Toggle — clicking the same cell again clears the pin
    setPinnedTip(prev =>
      prev && prev.t1 === t1 && prev.t2 === t2
        ? null
        : { t1, t2, val, style, x: e.clientX, y: e.clientY }
    );
  }, []);

  // Click anywhere outside the heatmap clears the pin
  useEffect(() => {
    const clear = () => setPinnedTip(null);
    document.addEventListener('click', clear);
    return () => document.removeEventListener('click', clear);
  }, []);

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
  const byVerdict   = v => insights.filter(i => i.verdict === v);
  const recommends  = byVerdict('RECOMMEND');
  const weak        = byVerdict('WEAK_SIGNAL');
  const monitors    = byVerdict('MONITOR');
  const tabInsights = tab === 'RECOMMEND' ? recommends : tab === 'WEAK_SIGNAL' ? weak : monitors;

  return (
    <div className="correlation-container" onClick={() => setPinnedTip(null)}>
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
            Updated {new Date(lastUpdated).toLocaleDateString('en-US', { month:'short', day:'numeric' })}
          </span>
        )}
      </div>

      <div className="heatmap-body">
        {/* Left — heatmap + legend */}
        <div className="heatmap-left">
          <div className="heatmap-scroll">
            <table className="heatmap-table" onClick={e => e.stopPropagation()}>
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
                      const isPinned = pinnedTip?.t1 === row && pinnedTip?.t2 === col;
                      return (
                        <td
                          key={col}
                          className={`heatmap-cell${isPinned ? ' cell-pinned' : ''}`}
                          style={{
                            background: style.background,
                            color: style.color,
                            cursor: val === 1 ? 'default' : 'crosshair',
                          }}
                          onMouseMove={e => onMouseMove(e, row, col, val)}
                          onMouseLeave={onMouseLeave}
                          onClick={e => onCellClick(e, row, col, val)}
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

          {/* Legend */}
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
            <span className="legend-note">Returns-based · 250d rolling · Click cell to pin</span>
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
                  <button key={v}
                    className={`vtab ${tab === v ? `vtab-active ${cls}` : ''}`}
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
                <div className="no-insights">No {tab.replace('_', ' ').toLowerCase()} pairs right now.</div>
              ) : (
                <div className="insights-grid">
                  {tabInsights.map((ins, idx) => <InsightCard key={idx} insight={ins}/>)}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Hover tooltip — follows mouse ── */}
      {hoverTip && !pinnedTip && (
        <div
          className="heatmap-tooltip"
          style={{ left: hoverTip.x, top: hoverTip.y, pointerEvents: 'none' }}
        >
          <span className="tooltip-tickers">
            {hoverTip.t1} <span className="tooltip-sep">vs</span> {hoverTip.t2}
          </span>
          <span className="tooltip-val" style={{ color: hoverTip.style.bandColor || '#f0f0ee' }}>
            {hoverTip.val.toFixed(3)}
          </span>
        </div>
      )}

      {/* ── Pinned popup — compact single-line at exact click position ── */}
      {pinnedTip && (
        <div
          className="heatmap-pin-popup"
          style={{
            left: Math.min(pinnedTip.x + 10, window.innerWidth - 220),
            top:  pinnedTip.y - 38,
          }}
          onClick={e => e.stopPropagation()}
        >
          <span className="pin-pair">{pinnedTip.t1} vs {pinnedTip.t2}</span>
          <span className="pin-eq">=</span>
          <span className="pin-val" style={{ color: pinnedTip.style.bandColor || '#f0f0ee' }}>
            {pinnedTip.val.toFixed(2)}
          </span>
          <button className="pin-close" onClick={() => setPinnedTip(null)}>✕</button>
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

  const tierColor    = corrTier === 'extreme' ? '#7f1d1d' : corrTier === 'high' ? '#b91c1c' : '#f97316';
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
            {corrTier === 'extreme' ? 'Extreme' : corrTier === 'high' ? 'High' : 'Flagged'} · {(correlation*100).toFixed(0)}%
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
        <div style={{ display:'flex', gap:'6px', alignItems:'center' }}>
          <span className="verdict-chip"
            style={{ background:`${verdictColor}18`, color:verdictColor, borderColor:`${verdictColor}35` }}>
            {verdict === 'RECOMMEND' ? '✓ Recommend' : '~ Weak Signal'}
          </span>
          <span className="insight-corr-badge"
            style={{ background:`${tierColor}20`, color:tierColor, borderColor:`${tierColor}40` }}>
            {(correlation*100).toFixed(0)}%
          </span>
        </div>
      </div>

      {winnerReasons.length > 0 && (
        <div className="evidence-list">
          {winnerReasons.map((r,i) => <span key={i} className="evidence-item">✓ {r}</span>)}
        </div>
      )}

      <div className="insight-compare">
        <div className="insight-col winner-col">
          <div className="col-role retain">Retain</div>
          <div className="insight-sym-lg">{winner}</div>
          <div className="insight-action-tag" style={{ color: ACTION_COLOR[winnerAction] || '#6b7280' }}>
            {winnerAction?.replace(/_/g,' ') || '—'}
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
            {loserAction?.replace(/_/g,' ') || '—'}
          </div>
          <div className="insight-cascade" style={{ color: CASCADE_COLOR[loserCascade] || '#6b7280' }}>
            {loserCascade || '—'}
          </div>
          <div className="insight-metrics">
            <MetricRow label="α21" value={fmtPct(loserAlpha21)} positive={loserAlpha21 >= 0} right/>
            <MetricRow label="α63" value={fmtPct(loserAlpha63)} positive={loserAlpha63 >= 0} right/>
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
