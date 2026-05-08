import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import './enhanced-portfolio-dashboard.css';
import CorrelationHeatmap from './CorrelationHeatmap';

// ── Signal Configuration ──────────────────────────────────────────────────────
const SIGNAL_CFG = {
  STRONG_BUY: {
    color: '#2563eb', label: 'Strong Buy', tier: 'bull',
    action: 'Add to or initiate a full position.',
    why: 'Score ≥ 8.5 — exceptional business quality, attractive valuation, and positive momentum. Highest-conviction entry point.',
  },
  BUY: {
    color: '#3b82f6', label: 'Buy', tier: 'bull',
    action: 'Consider adding to the position.',
    why: 'Score ≥ 7.5 — strong fundamentals with reasonable entry. Quality compounder at a fair or better price.',
  },
  ADD: {
    color: '#059669', label: 'Add', tier: 'bull',
    action: 'Add incrementally — accumulation zone confirmed.',
    why: 'Excess return is positive vs SPY, score is solid, and momentum supports adding. Good risk/reward within the 3-7yr thesis.',
  },
  SPRING_CONFIRMED: {
    color: '#047857', label: 'Spring ✓', tier: 'bull',
    action: 'Buy the dip — spring entry confirmed (day 3+).',
    why: 'Quality stock has rebounded for 3+ consecutive sessions from an oversold low. This is the contrarian entry the system is designed to catch.',
  },
  SPRING_CANDIDATE: {
    color: '#10b981', label: 'Spring ~', tier: 'bull',
    action: 'Watch for spring confirmation — early recovery underway.',
    why: 'Stock dipped below its trend on a quality name and is beginning to recover. Wait for Day 3 before adding.',
  },
  HOLD: {
    color: '#6b7280', label: 'Hold', tier: 'flat',
    action: 'Maintain your position. No action warranted.',
    why: 'Score in the HOLD band (4.5–7.5). Business quality is adequate but no catalyst for adding or reducing.',
  },
  NORMAL: {
    color: '#6b7280', label: 'Hold', tier: 'flat',
    action: 'Maintain your position.',
    why: 'No regime signal. Price action is normal relative to SPY. Hold and monitor.',
  },
  HOLD_NOISE: {
    color: '#9ca3af', label: 'Hold', tier: 'flat',
    action: 'Ignore short-term volatility. Maintain position.',
    why: 'Score is stable but near-term price movement is market-driven noise.',
  },
  MARKET_NOISE: {
    color: '#9ca3af', label: 'Hold', tier: 'flat',
    action: 'Ignore market turbulence. Hold with conviction.',
    why: 'Broad market noise obscures this quality. Long-term thesis unchanged.',
  },
  WATCH: {
    color: '#d97706', label: 'Watch', tier: 'bear',
    action: 'Heightened monitoring. Do not add. Review thesis.',
    why: '3-week score decline detected. Could be temporary or early-stage deterioration.',
  },
  TRIM_25: {
    color: '#ea580c', label: 'Trim 25%', tier: 'bear',
    action: 'Reduce position by ~25%. Take partial profit.',
    why: 'Score and/or momentum have deteriorated materially. Trimming 25% locks in partial gains.',
  },
  REDUCE: {
    color: '#dc2626', label: 'Reduce', tier: 'bear',
    action: 'Meaningfully reduce position size.',
    why: 'Score < 4.5 with confirmed structural decline (W3+). Business quality has deteriorated beyond a temporary blip.',
  },
  SELL: {
    color: '#b91c1c', label: 'Sell', tier: 'bear',
    action: 'Exit the position.',
    why: 'Score < 3.5 with W4 structural decay or critical event. The cost of inaction exceeds the CGT cost of exiting.',
  },
  IDIOSYNCRATIC_DECAY: {
    color: '#7f1d1d', label: 'Decay', tier: 'bear',
    action: 'Structural breakdown confirmed. Plan an exit.',
    why: '12-month sustained underperformance beyond what market conditions explain.',
  },
  INSUFFICIENT_DATA: {
    color: '#9ca3af', label: 'No Data', tier: 'flat',
    action: 'Insufficient history. Hold and wait for data.',
    why: 'Fewer than 7 trading days of score history.',
  },
};


const sig = (s) => SIGNAL_CFG[s || ''] || { color: '#6b7280', label: s || 'Pending', tier: 'flat', action: '', why: '' };

// ── Formatting Utilities ──────────────────────────────────────────────────────
const fmtUSD = (n, compact = false) => {
  if (n == null || isNaN(n)) return 'N/A';
  if (compact && Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (compact && Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
};

const fmtPct = (n, dp = 2) => {
  if (n == null || isNaN(n)) return null;
  return `${n >= 0 ? '+' : ''}${Number(n).toFixed(dp)}%`;
};

const scoreCol = (s) => {
  if (s == null) return '#9ca3af';
  if (s >= 8) return '#059669';
  if (s >= 6.5) return '#2563eb';
  if (s >= 5) return '#d97706';
  return '#dc2626';
};

const moatCol = (s) => {
  if (s == null) return '#9ca3af';
  if (s >= 7) return '#059669';
  if (s >= 5) return '#2563eb';
  if (s >= 3) return '#d97706';
  return '#dc2626';
};

// ── Weight Assessment (REDESIGNED) ────────────────────────────────────────────
// Uses score-relative ratio instead of hard caps as primary metric.
// Color reflects how well the actual weight aligns with quality contribution.
// Signal context adjusts interpretation (bullish+underweight = opportunity, etc.)

const getWeightAssessment = (
  weightPct,
  score,
  signal,
  allPortfolio,
  marketRegime,
  isETF,
  excessReturn,
) => {
  // ETFs are intentional anchor positions — judged on alpha contribution, not weight size.
  // A 26% ETF is fine if it is delivering positive alpha vs SPY.
  // "Bloat" for an ETF means: large weight + negative alpha = dragging portfolio returns.
  if (isETF) {
    const negAlpha = excessReturn != null && excessReturn < -2;
    const flatAlpha = excessReturn != null && excessReturn < 0;
    const posAlpha = excessReturn != null && excessReturn > 1;
    if (weightPct > 15 && negAlpha) {
      return { color: '#dc2626', verdict: 'Large ETF anchor underperforming SPY - alpha drag', icon: 'drag', fairShare: null, ratio: null, absCeiling: null };
    }
    if (weightPct > 20 && flatAlpha) {
      return { color: '#d97706', verdict: 'Heavy ETF with flat/negative alpha - monitor', icon: '', fairShare: null, ratio: null, absCeiling: null };
    }
    if (posAlpha) {
      return { color: '#059669', verdict: 'ETF contributing positive alpha - weight justified', icon: 'OK', fairShare: null, ratio: null, absCeiling: null };
    }
    return { color: '#6b7280', verdict: 'ETF anchor position', icon: '', fairShare: null, ratio: null, absCeiling: null };
  }

  // For stocks: compare weight against score-implied fair share within stock allocation.
  // ETF weight is excluded from the denominator — anchors are scaffolding, not alpha bets.
  const isSpring  = ['SPRING_CONFIRMED', 'SPRING_CANDIDATE'].includes(signal || '');
  const isBullish = ['ADD', 'SPRING_CONFIRMED', 'SPRING_CANDIDATE', 'STRONG_BUY', 'BUY'].includes(signal || '');
  const isBearish = ['WATCH', 'TRIM_25', 'REDUCE', 'SELL', 'IDIOSYNCRATIC_DECAY'].includes(signal || '');

  // Total value and ETF weight so we can compute weight within stock-only allocation
  const totalPortVal = allPortfolio.reduce((s, x) => s + ((x.current_price || 0) * (x.quantity || 0)), 0);
  const etfVal = allPortfolio.filter(s => s.instrument_type === 'ETF').reduce((s, x) => s + ((x.current_price || 0) * (x.quantity || 0)), 0);
  const stockAllocPct = totalPortVal > 0 ? ((totalPortVal - etfVal) / totalPortVal) * 100 : 100;
  // Restate this stock's weight as % of stock-only allocation
  const effectiveWt = stockAllocPct > 0 ? (weightPct / stockAllocPct) * 100 : weightPct;

  // Fair share within stock allocation
  const stocks = allPortfolio.filter(s => s.instrument_type !== 'ETF');
  const scoreSum = stocks.reduce((a, s) => a + (s.latest_score != null ? s.latest_score : 5), 0);
  const fairShare = scoreSum > 0 ? (score / scoreSum) * 100 : (100 / Math.max(stocks.length, 1));
  const ratio = fairShare > 0 ? effectiveWt / fairShare : 1;

  // Absolute ceiling — generous safety valve, not primary signal
  let absCeiling;
  if      (score >= 8.5) absCeiling = 30;
  else if (score >= 7.5) absCeiling = 25;
  else if (score >= 6.5) absCeiling = 20;
  else if (score >= 5.5) absCeiling = 16;
  else if (score >= 4.5) absCeiling = 12;
  else                   absCeiling = 8;

  if (!isSpring) {
    if      (marketRegime === 'BEAR')     absCeiling = Math.min(absCeiling, 15);
    else if (marketRegime === 'STRESSED') absCeiling = Math.min(absCeiling, 18);
  }

  let color, verdict, icon;

  if      (weightPct > absCeiling)   { color = '#991b1b'; verdict = 'Exceeds ceiling for score ' + score.toFixed(1); icon = 'cap'; }
  else if (ratio > 2.0)              { color = '#991b1b'; verdict = '2x+ fair share of stock allocation'; icon = 'high'; }
  else if (ratio > 1.6)              { color = '#dc2626'; verdict = 'Overweight for quality score'; icon = 'over'; }
  else if (ratio > 1.35)             { color = '#ea580c'; verdict = 'Moderately overweight' + (isBearish ? ' - risk signal reinforces trimming' : ''); icon = isBearish ? 'trim' : ''; }
  else if (ratio > 1.15)             { color = '#d97706'; verdict = 'Slightly heavy'; icon = ''; }
  else if (ratio >= 0.85)            {
    if (isBearish && ratio > 1.0)    { color = '#d97706'; verdict = 'Balanced but risk signal - consider trimming'; icon = ''; }
    else                             { color = '#059669'; verdict = 'Well balanced'; icon = 'OK'; }
  }
  else if (ratio >= 0.6)             {
    if (isBullish && score >= 7)     { color = '#0d9488'; verdict = 'Room to add - strong score + buy signal'; icon = 'add'; }
    else if (isBullish)              { color = '#0d9488'; verdict = 'Slightly underweight - buy signal active'; icon = 'add'; }
    else                             { color = '#6b7280'; verdict = 'Adequate weight'; icon = ''; }
  }
  else                               {
    if (isBullish && score >= 7)     { color = '#2563eb'; verdict = 'Underweight opportunity - buy signal + strong score'; icon = 'add+'; }
    else if (isBullish)              { color = '#3b82f6'; verdict = 'Underweight - buy signal active'; icon = 'add'; }
    else if (isBearish)              { color = '#6b7280'; verdict = 'Low weight - appropriate for current signal'; icon = ''; }
    else                             { color = '#9ca3af'; verdict = 'Low weight'; icon = ''; }
  }

  return { color, verdict, icon, fairShare, ratio, absCeiling };
};

// ── Canvas Neural Network Background ──────────────────────────────────────────
const _nodes = [];
let _nodesReady = false;

const buildNodes = (W, H) => {
  _nodes.length = 0;
  const COLORS = [
    { c: '#059669', a: () => 0.40 + Math.random() * 0.22 },
    { c: '#dc2626', a: () => 0.36 + Math.random() * 0.20 },
    { c: '#a0a09a', a: () => 0.18 + Math.random() * 0.12 },
  ];
  const pick = () => {
    const r = Math.random();
    return r < 0.38 ? COLORS[0] : r < 0.76 ? COLORS[1] : COLORS[2];
  };
  for (let i = 0; i < 30; i++) {
    const col = pick();
    _nodes.push({
      x: W * (0.04 + Math.random() * 0.92),
      y: H * (i / 30 + Math.random() * (1 / 30)),
      vx: (Math.random() - 0.5) * 0.10,
      vy: (Math.random() < 0.5 ? 1 : -1) * (0.08 + Math.random() * 0.12),
      oAmp: 40 + Math.random() * 60,
      oPeriod: 8 + Math.random() * 14,
      oPhase: Math.random() * Math.PI * 2,
      r: 2.5 + Math.random() * 2.5,
      color: col.c,
      alpha: col.a(),
      pulseOffset: Math.random() * Math.PI * 2,
      pulseSpeed: 0.004 + Math.random() * 0.008,
    });
  }
  _nodesReady = true;
};

const NeuralBackground = () => {
  const canvasRef = useRef(null);
  const mouseRef = useRef({ x: -9999, y: -9999 });
  const rafRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = Math.max(window.innerHeight, document.documentElement.scrollHeight);
      if (!_nodesReady) buildNodes(canvas.width, canvas.height);
    };

    const onMouse = (e) => {
      mouseRef.current = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
    };
    const onLeave = () => { mouseRef.current = { x: -9999, y: -9999 }; };
    window.addEventListener('mousemove', onMouse);
    window.addEventListener('mouseleave', onLeave);

    const EDGE_DIST = 170, REPEL_DIST = 130, REPEL_FORCE = 0.77;
    const H_DAMPING = 0.91, V_DAMPING = 0.991, H_RESTORE = 0.016, MAX_SPEED = 0.86;

    const draw = (t) => {
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      const nodes = _nodes;
      const mx = mouseRef.current.x, my = mouseRef.current.y;
      const now = t * 0.001;

      for (const n of nodes) {
        n.vy += Math.sin(now / n.oPeriod * Math.PI * 2 + n.oPhase) * 0.011;
        n.vx += (Math.random() - 0.5) * 0.011;
        n.vy += (Math.random() - 0.5) * 0.011;
        n.vx -= n.vx * H_RESTORE;
        const dx = n.x - mx, dy = n.y - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < REPEL_DIST && dist > 0) {
          const force = (REPEL_DIST - dist) / REPEL_DIST * REPEL_FORCE;
          n.vx += (dx / dist) * force;
          n.vy += (dy / dist) * force;
        }
        n.vx *= H_DAMPING;
        n.vy *= V_DAMPING;
        const spd = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (spd > MAX_SPEED) {
          n.vx = (n.vx / spd) * MAX_SPEED;
          n.vy = (n.vy / spd) * MAX_SPEED;
        }
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 0) { n.x = 0; n.vx = Math.abs(n.vx) * 0.6; }
        if (n.x > W) { n.x = W; n.vx = -Math.abs(n.vx) * 0.6; }
        if (n.y < 0) n.y = H;
        if (n.y > H) n.y = 0;
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const ddx = a.x - b.x, ddy = a.y - b.y;
          const d = Math.sqrt(ddx * ddx + ddy * ddy);
          if (d > EDGE_DIST) continue;
          const ea = (1 - d / EDGE_DIST) * 0.16;
          const col = a.color === '#a0a09a' ? b.color : a.color;
          let edgeColor;
          if (col === '#059669') edgeColor = `rgba(5,150,105,${ea})`;
          else if (col === '#dc2626') edgeColor = `rgba(220,38,38,${ea})`;
          else edgeColor = `rgba(160,160,154,${ea})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = edgeColor;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      for (const n of nodes) {
        const pulse = 0.82 + 0.18 * Math.sin(now * n.pulseSpeed * 60 + n.pulseOffset);
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * pulse, 0, Math.PI * 2);
        let nodeColor;
        if (n.color === '#059669') nodeColor = `rgba(5,150,105,${n.alpha * pulse})`;
        else if (n.color === '#dc2626') nodeColor = `rgba(220,38,38,${n.alpha * pulse})`;
        else nodeColor = `rgba(160,160,154,${n.alpha * pulse})`;
        ctx.fillStyle = nodeColor;
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener('resize', resize);
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouse);
      window.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  return <canvas ref={canvasRef} className="neural-canvas" aria-hidden="true" />;
};

// ── Sub-components ────────────────────────────────────────────────────────────
const ScoreRing = ({ score }) => {
  const r = 17, circ = 2 * Math.PI * r;
  const col = scoreCol(score || null);
  const pct = Math.max(0, Math.min(10, score || 0)) / 10;
  return (
    <div className="score-ring" title={`Quality Score: ${(score != null ? score.toFixed(1) : '—')}/10`}>
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r={r} fill="none" stroke="#e6e5df20" strokeWidth="2.5" />
        <circle cx="22" cy="22" r={r} fill="none" stroke={col} strokeWidth="2.5"
          strokeDasharray={`${pct * circ} ${circ}`}
          strokeLinecap="round" transform="rotate(-90 22 22)"
          style={{ transition: 'stroke-dasharray .5s ease' }} />
      </svg>
      <span className="score-ring-num" style={{ color: col }}>
        {(score != null ? score.toFixed(1) : '—')}
      </span>
    </div>
  );
};

const MoatRing = ({ score }) => {
  if (score == null) return null;
  const r = 11, circ = 2 * Math.PI * r;
  const col = moatCol(score);
  const pct = Math.max(0, Math.min(10, score)) / 10;
  return (
    <div className="moat-ring" title={`Moat: ${score.toFixed(1)}/10 — competitive durability`}>
      <svg width="30" height="30" viewBox="0 0 30 30">
        <circle cx="15" cy="15" r={r} fill="none" stroke="#e6e5df20" strokeWidth="2" />
        <circle cx="15" cy="15" r={r} fill="none" stroke={col} strokeWidth="2"
          strokeDasharray={`${pct * circ} ${circ}`}
          strokeLinecap="round" transform="rotate(-90 15 15)"
          style={{ transition: 'stroke-dasharray .4s ease' }} />
      </svg>
      <span className="moat-ring-num" style={{ color: col }}>{score.toFixed(1)}</span>
    </div>
  );
};

const CascadePips = ({ w1: _w1, w2, w3, w4 }) => {
  // Always visible — grey = clear, coloured = triggered.
  // Shows the regime health at a glance regardless of signal state.
  const pips = [
    { k: 'W2', on: w2, col: '#d97706', tip: w2 ? 'W2 TRIGGERED: 3-week score decline — monitor closely.' : 'W2 clear: no 3-week score deterioration.' },
    { k: 'W3', on: w3, col: '#dc2626', tip: w3 ? 'W3 TRIGGERED: 3-month structural decline. Review thesis.' : 'W3 clear: no 3-month structural deterioration.' },
    { k: 'W4', on: w4, col: '#7f1d1d', tip: w4 ? 'W4 TRIGGERED: 12-month sustained deterioration. Strongest sell signal.' : 'W4 clear: no 12-month sustained deterioration.' },
  ];
  const activeCount = pips.filter(p => p.on).length;
  const allClear = activeCount === 0;
  const severity = activeCount >= 3 ? 'Serious (W2+W3+W4)' : activeCount === 2 ? 'Elevated' : activeCount === 1 ? 'Watch' : 'All clear';
  return (
    <div className="cascade-pips" title={`Decay cascade — ${severity}`} style={{ marginTop: 4 }}>
      {pips.map(p => (
        <span key={p.k}
          style={{
            display: 'inline-block', fontSize: 9, fontWeight: 700, padding: '1px 5px',
            borderRadius: 3, marginRight: 2, border: '1px solid',
            background:   p.on ? p.col         : 'transparent',
            borderColor:  p.on ? p.col         : '#374151',
            color:        p.on ? '#fff'         : '#4b5563',
            opacity:      p.on ? 1              : 0.65,
          }}
          title={p.tip}>
          {p.k}{p.on ? ' ✓' : ''}
        </span>
      ))}
      {allClear && (
        <span style={{ fontSize: 9, color: '#059669', marginLeft: 2, fontWeight: 600 }}>✓ clean</span>
      )}
    </div>
  );
};

const SpringBar = ({ days }) => {
  if (!days || days <= 0) return null;
  const col = days >= 3 ? '#047857' : '#10b981';
  const tip = days >= 3
    ? 'Spring CONFIRMED: Quality stock recovered 3+ days from a dip.'
    : `Spring forming — Day ${days}/3. Wait for Day 3 before adding.`;
  return (
    <div className="spring-bar" title={tip}>
      <div className="spring-track">
        <div className="spring-fill" style={{ width: `${(Math.min(days, 3) / 3) * 100}%`, background: col }} />
      </div>
      <span className="spring-label" style={{ color: col }}>
        {days >= 3 ? '🌱 Spring Confirmed — entry window' : `🌱 Spring Day ${days}/3 — watch`}
      </span>
    </div>
  );
};

const FundRow = ({ label, value, hint, positive }) => {
  if (value == null || value === 'N/A') return null;
  return (
    <div className="fund-row" title={hint || ''}>
      <span className="fund-lbl">{label}</span>
      <span className="fund-val" style={
        positive === true ? { color: '#059669' } :
          positive === false ? { color: '#dc2626' } : {}
      }>{value}</span>
    </div>
  );
};

// ── Detail Panel ──────────────────────────────────────────────────────────────
const DetailPanel = ({ stock }) => {
  const fcfYieldPct = (stock.fcf_yield != null && stock.fcf_yield > 0) ? (stock.fcf_yield * 100) : null;
  const sbcPct = stock.sbc_to_market_cap;
  const filingScore = stock.filing_sentiment;
  const isETF = stock.instrument_type === 'ETF';

  const filingLabel = filingScore == null ? null
    : filingScore >= 7 ? 'Positive tone' : filingScore >= 5 ? 'Neutral tone'
      : filingScore >= 3 ? 'Cautious tone' : 'Negative tone';
  const filingColor = filingScore == null ? '#9ca3af'
    : filingScore >= 7 ? '#059669' : filingScore >= 5 ? '#6b7280'
      : filingScore >= 3 ? '#d97706' : '#dc2626';

  const gainPct = stock.average_price > 0 && stock.current_price != null
    ? ((stock.current_price - stock.average_price) / stock.average_price) * 100
    : null;
  const gainAmt = gainPct != null
    ? (stock.current_price - stock.average_price) * stock.quantity
    : null;

  const showTaxNote = ['SELL', 'TRIM_25', 'REDUCE'].includes(stock.signal || '') && gainPct != null && gainPct > 20;

  return (
    <tr className="detail-panel-row">
      <td colSpan={7}>
        <div className="detail-panel">

          {showTaxNote && (
            <div style={{
              padding: '8px 12px', borderRadius: 8, marginBottom: 4,
              background: '#fff7ed10', border: '1px solid #fed7aa40',
              display: 'flex', alignItems: 'flex-start', gap: 8,
            }}>
              <span style={{ fontSize: 14, flexShrink: 0 }}>🇮🇳</span>
              <div style={{ fontSize: 11, color: '#fbbf24', lineHeight: 1.5 }}>
                <strong>Tax consideration:</strong>{' '}
                This position has a <strong>{gainPct.toFixed(0)}% unrealised gain</strong>{' '}
                (~${Math.abs(gainAmt).toFixed(0)} USD).{' '}
                {gainPct > 100
                  ? 'The system requires W4 confirmation before escalating to SELL on large winners.'
                  : 'Review whether the signal strength justifies the capital gains tax bill (20% LTCG / 30% STCG).'}
              </div>
            </div>
          )}

          {isETF && (
            <div className="detail-section etf-info-section">
              <div className="detail-section-head">
                <span className="detail-section-title">📊 ETF Overview</span>
              </div>
              <div className="detail-rows">
                <FundRow label="Instrument" value="Exchange-Traded Fund"
                  hint="ETF scores are based on price momentum, trend strength, and news" />
                {stock.expense_ratio != null && (
                  <FundRow label="Annual Cost (Expense Ratio)"
                    value={`${stock.expense_ratio.toFixed(2)}%/yr`}
                    hint="Annual fee drag. Under 0.20%/yr = low cost."
                    positive={stock.expense_ratio < 0.25} />
                )}
                {stock.max_drawdown != null && (
                  <FundRow label="Max Drawdown (1Y)"
                    value={`${stock.max_drawdown.toFixed(1)}%`}
                    hint="Peak-to-trough decline over the last year"
                    positive={stock.max_drawdown > -20} />
                )}
              </div>
            </div>
          )}

          {!isETF && stock.moat_score != null && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">🏰 Competitive Moat</span>
                <span className="detail-section-score" style={{ color: moatCol(stock.moat_score) }}>
                  {stock.moat_score.toFixed(1)}/10
                </span>
              </div>
              <div className="detail-rows">
                <FundRow label="Gross Margin"
                  value={stock.gross_margin_pct != null ? `${stock.gross_margin_pct.toFixed(1)}%` : null}
                  hint="Pricing power proxy. >40% = strong moat, >60% = exceptional (ROIC-generative)."
                  positive={stock.gross_margin_pct != null ? stock.gross_margin_pct > 40 : undefined} />
                <FundRow label="Rev Growth (TTM)"
                  value={stock.revenue_growth_pct != null ? `${stock.revenue_growth_pct >= 0 ? '+' : ''}${stock.revenue_growth_pct.toFixed(1)}%` : null}
                  hint="Year-over-year revenue velocity"
                  positive={stock.revenue_growth_pct != null ? stock.revenue_growth_pct > 10 : undefined} />
                <FundRow label="Rev Growth (3Y CAGR)"
                  value={stock.revenue_growth_3y != null ? `${stock.revenue_growth_3y >= 0 ? '+' : ''}${stock.revenue_growth_3y.toFixed(1)}%` : null}
                  hint="3-year compounded growth — durability signal. 3Y diverging from TTM = investigate."
                  positive={stock.revenue_growth_3y != null ? stock.revenue_growth_3y > 10 : undefined} />
                {stock.hypergrowth_mode && (
                  <FundRow label="Scoring Mode" value="⚡ Hypergrowth"
                    hint="FCF weight reduced to 15%, revenue growth raised to 55%. Applied when CAGR >20% + GM >60%."
                    positive={true} />
                )}
                {stock.capex_exception && (
                  <FundRow label="CapEx Exception" value="✓ Strategic CapEx"
                    hint="FCF penalty forgiven — company investing heavily for future growth (verified via SEC EDGAR)."
                    positive={true} />
                )}
              </div>
            </div>
          )}

          {!isETF && (fcfYieldPct != null || stock.ev_fcf != null) && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">💰 Valuation</span>
              </div>
              <div className="detail-rows">
                <FundRow label="Free Cash Flow Yield"
                  value={fcfYieldPct != null ? `${fcfYieldPct.toFixed(2)}%` : (stock.fcf_yield === 0 ? 'Pending data' : null)}
                  hint={fcfYieldPct != null
                    ? `FCF yield ${fcfYieldPct.toFixed(1)}% — ${fcfYieldPct > 5 ? 'cheap entry' : fcfYieldPct > 3 ? 'fair value' : fcfYieldPct > 1.5 ? 'expensive' : 'very expensive'}`
                    : 'FCF yield will update after next EOD run.'}
                  positive={fcfYieldPct != null && fcfYieldPct > 3} />
                <FundRow label="EV/FCF"
                  value={stock.ev_fcf != null ? `${stock.ev_fcf.toFixed(1)}×` : null}
                  hint="Enterprise value vs free cash flow. Under 15× = cheap, 15-25× = fair, over 40× = expensive."
                  positive={stock.ev_fcf != null ? stock.ev_fcf < 25 : undefined} />
              </div>
            </div>
          )}

          {!isETF && (stock.momentum_label != null || stock.sma200 != null || stock.realized_vol != null) && (() => {
            const price = stock.current_price;
            const aboveSma50  = price != null && stock.sma50  != null ? price > stock.sma50  : null;
            const aboveSma200 = price != null && stock.sma200 != null ? price > stock.sma200 : null;
            const smaCross    = stock.sma50 != null && stock.sma200 != null
              ? (stock.sma50 > stock.sma200 ? 'Golden cross (bullish)' : 'Death cross (bearish)')
              : null;
            const volLabel    = stock.realized_vol != null
              ? (stock.realized_vol < 0.20 ? 'Low' : stock.realized_vol < 0.35 ? 'Normal' : stock.realized_vol < 0.50 ? 'Elevated' : 'High')
              : null;
            const momColor    = stock.momentum_label === 'STRONG_UP' ? '#059669'
                              : stock.momentum_label === 'UP'         ? '#10b981'
                              : stock.momentum_label === 'DOWN'       ? '#dc2626'
                              : stock.momentum_label === 'STRONG_DOWN'? '#7f1d1d'
                              : '#6b7280';
            return (
              <div className="detail-section">
                <div className="detail-section-head">
                  <span className="detail-section-title">📈 Technical</span>
                </div>
                <div className="detail-rows">
                  {stock.momentum_label && (
                    <FundRow label="Momentum"
                      value={<span style={{ color: momColor }}>{stock.momentum_label.replace('_', ' ')}</span>}
                      hint="Price momentum label from 21/63-day return analysis" />
                  )}
                  {stock.sma200 != null && price != null && (
                    <FundRow label="vs SMA-200"
                      value={`${aboveSma200 ? '▲ Above' : '▼ Below'} ($${stock.sma200.toFixed(0)})`}
                      hint="Price vs 200-day moving average. Above = uptrend, below = downtrend."
                      positive={aboveSma200 === true} />
                  )}
                  {stock.sma50 != null && price != null && (
                    <FundRow label="vs SMA-50"
                      value={`${aboveSma50 ? '▲ Above' : '▼ Below'} ($${stock.sma50.toFixed(0)})`}
                      hint="Price vs 50-day moving average — shorter-term trend signal."
                      positive={aboveSma50 === true} />
                  )}
                  {smaCross && (
                    <FundRow label="SMA Cross"
                      value={smaCross}
                      hint="SMA-50 vs SMA-200 crossover status"
                      positive={smaCross.startsWith('Golden')} />
                  )}
                  {stock.realized_vol != null && (
                    <FundRow label="Realised Volatility"
                      value={`${(stock.realized_vol * 100).toFixed(0)}% ann · ${volLabel}`}
                      hint="Annualised daily volatility. High vol = wider price swings, harder to size correctly."
                      positive={stock.realized_vol < 0.35} />
                  )}
                </div>
              </div>
            );
          })()}

          {!isETF && (stock.max_drawdown != null || sbcPct != null || stock.earnings_quality_flag || stock.debt_maturity_flag || stock.cyclical_peak_flag) && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">⚠️ Risk Factors</span>
              </div>
              <div className="detail-rows">
                {stock.max_drawdown != null && (
                  <FundRow label="Largest Drop (1 year)"
                    value={`${stock.max_drawdown.toFixed(1)}%`}
                    hint={`Peak-to-trough: ${stock.max_drawdown.toFixed(1)}%. ${
                      stock.max_drawdown > -15 ? 'Normal volatility.'
                        : stock.max_drawdown > -25 ? 'Meaningful dip — watch for spring signal.'
                          : stock.max_drawdown > -40 ? 'Significant drawdown.'
                            : 'Severe drawdown. Check if thesis intact.'
                    }`}
                    positive={stock.max_drawdown > -20} />
                )}
                {sbcPct != null && (
                  <FundRow label="Dilution Rate (SBC)"
                    value={`${sbcPct.toFixed(2)}%/yr`}
                    hint="Stock-based compensation as % of market cap. Under 2% = healthy."
                    positive={sbcPct < 2} />
                )}
                {stock.sbc_millions != null && (
                  <FundRow label="Annual Dilution Cost"
                    value={`$${stock.sbc_millions.toFixed(0)}M`}
                    hint="Annual stock grants to employees" />
                )}
                {stock.earnings_quality_flag === 'risk' && (
                  <FundRow label="Earnings Quality" value="⚠ Profits outpace cash"
                    hint="Reported profits look good, but actual cash collected is lower." positive={false} />
                )}
                {stock.earnings_quality_flag === 'strong' && (
                  <FundRow label="Earnings Quality" value="✓ Strong cash conversion"
                    hint="The business collects more cash than its reported profits." positive={true} />
                )}
                {stock.debt_maturity_flag === 'wall' && (
                  <FundRow label="Debt Repayment Risk" value="⚠ Large debt due soon"
                    hint="Over 30% of debt needs refinancing within 12 months." positive={false} />
                )}
                {stock.dilution_flag === 'heavy' && (
                  <FundRow label="Share Dilution"
                    value={`⚠ Shares grew ${stock.shares_yoy_pct != null ? stock.shares_yoy_pct.toFixed(1) : '?'}% this year`}
                    hint="Shares outstanding growing faster than 5% per year." positive={false} />
                )}
                {stock.dilution_flag === 'buyback' && (
                  <FundRow label="Share Count"
                    value={`✓ Buybacks: ${stock.shares_yoy_pct != null ? stock.shares_yoy_pct.toFixed(1) : '?'}% YoY`}
                    hint="Company reducing share count — good for long-term owners." positive={true} />
                )}
                {stock.cyclical_peak_flag && (
                  <FundRow label="Cycle Warning" value="⚠ May be at earnings peak"
                    hint="Margins unusually high vs history — may be peak-cycle profitability." positive={false} />
                )}
              </div>
            </div>
          )}

          {!isETF && filingScore != null && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">📄 Filing Tone</span>
                <span className="detail-section-score" style={{ color: filingColor }}>
                  {filingScore.toFixed(1)}/10
                </span>
              </div>
              <div className="detail-rows">
                <FundRow label={`${stock.filing_form || 'Filing'} Language`}
                  value={filingLabel}
                  hint="Sentiment analysis of most recent SEC filing (positive/negative word ratio)."
                  positive={filingScore >= 6} />
                {stock.accounting_standard === 'IFRS' && (
                  <FundRow label="Accounting Standard" value="⚠ IFRS (foreign filer)"
                    hint="This company files under IFRS (20-F/6-K), not US GAAP. Margin comparisons vs domestic peers may be misleading."
                    positive={false} />
                )}
              </div>
            </div>
          )}

          {!isETF && stock.event_8k && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">📋 Recent 8-K{stock.event_8k_amendment ? '/A' : ''}</span>
              </div>
              <div className="detail-rows">
                <FundRow label="Event"
                  value={`${stock.event_8k_icon || ''} ${stock.event_8k}`}
                  hint={`Material SEC filing within the last 60 days · Item ${stock.event_8k_item || '—'}`}
                  positive={stock.event_8k_hint === 'positive'} />
                {stock.event_8k_date && (
                  <FundRow label="Filed"
                    value={`${stock.event_8k_date}${stock.event_8k_days_old != null ? ` (${Math.round(stock.event_8k_days_old)}d ago)` : ''}`} />
                )}
                {stock.event_8k_score_adj != null && stock.event_8k_score_adj !== 0 && (
                  <FundRow label="Score Impact"
                    value={`${stock.event_8k_score_adj > 0 ? '+' : ''}${stock.event_8k_score_adj.toFixed(1)} pts (decayed by age)`}
                    hint="Recency-decayed score adjustment applied to news component. Decays to 15% at 60 days."
                    positive={stock.event_8k_score_adj > 0} />
                )}
              </div>
            </div>
          )}

          {!isETF && (
            <EarningsCard symbol={stock.symbol} />
          )}

          {!isETF && stock.filing_sentiment != null && (
            <FilingNarrativeCard symbol={stock.symbol} filingForm={stock.filing_form} />
          )}

          {(isETF ? stock.score_tech != null : stock.score_fund != null) && (() => {
            const w2 = stock.w2_confirmed, w3 = stock.w3_confirmed, w4 = stock.w4_confirmed;
            const activeW = [w2 && 'W2', w3 && 'W3', w4 && 'W4'].filter(Boolean);
            const regimeColor = stock.regime === 'IDIOSYNCRATIC_DECAY' ? '#dc2626'
                              : stock.regime === 'WATCH'                ? '#d97706'
                              : '#059669';
            const regimeLabel = stock.regime === 'IDIOSYNCRATIC_DECAY' ? 'Idiosyncratic Decay'
                              : stock.regime === 'WATCH'                ? 'Watch'
                              : stock.regime === 'MARKET_NOISE'         ? 'Market Noise'
                              : stock.regime || 'Normal';
            return (
              <div className="detail-section">
                <div className="detail-section-head">
                  <span className="detail-section-title">📐 Score Breakdown</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {stock.hypergrowth_mode && (
                      <span style={{
                        fontSize: 10, padding: '2px 6px', borderRadius: 4,
                        background: '#7c3aed18', color: '#7c3aed',
                        border: '1px solid #7c3aed40', fontWeight: 600,
                      }}>⚡ Hypergrowth</span>
                    )}
                    <span className="detail-section-score" style={{ color: scoreCol((stock.latest_score != null ? stock.latest_score : null)) }}>
                      {stock.latest_score != null ? stock.latest_score.toFixed(1) : '—'}/10
                    </span>
                  </div>
                </div>
                <div className="detail-rows">
                  {stock.regime && (
                    <FundRow label="Market Regime"
                      value={<span style={{ color: regimeColor, fontWeight: 600 }}>{regimeLabel}</span>}
                      hint="MARKET_NOISE = SPY-driven move, not company-specific. IDIOSYNCRATIC_DECAY = company underperforming beyond market. WATCH = borderline." />
                  )}
                  {(w2 != null || w3 != null || w4 != null) && (
                    <FundRow label="Decay Cascade"
                      value={
                        activeW.length === 0
                          ? <span style={{ color: '#059669', fontWeight: 600 }}>✓ All clear (W2/W3/W4)</span>
                          : <span style={{ color: activeW.length >= 2 ? '#dc2626' : '#d97706', fontWeight: 600 }}>
                              {activeW.join(' + ')} triggered
                            </span>
                      }
                      hint={
                        'W2 = 3-week score decline. W3 = 3-month structural decline. W4 = 12-month sustained deterioration. ' +
                        (activeW.length === 0 ? 'No cascade signals — thesis intact on all time horizons.' :
                         activeW.includes('W4') ? 'W4 active: strongest structural sell signal. Requires full thesis review.' :
                         activeW.includes('W3') ? 'W3 active: quarterly deterioration. Review whether thesis still holds.' :
                         'W2 active: short-term score dip. Monitor — may be market noise.')
                      }
                      positive={activeW.length === 0} />
                  )}
                  {stock.excess_return != null && (
                    <FundRow label="Alpha vs SPY (21d)"
                      value={`${stock.excess_return >= 0 ? '+' : ''}${stock.excess_return.toFixed(2)}%`}
                      hint="Jensen alpha: stock return vs SPY adjusted for beta. Positive = outperforming on risk-adjusted basis."
                      positive={stock.excess_return >= 0} />
                  )}
                  {stock.spring_days > 0 && (
                    <FundRow label="Spring Signal"
                      value={`Day ${stock.spring_days} of 3${stock.spring_days >= 3 ? ' ✓ CONFIRMED' : ' (forming)'}`}
                      hint="Wyckoff spring: quality stock bouncing from oversold. Confirmed at day 3+."
                      positive={stock.spring_days >= 3} />
                  )}
                {isETF ? (
                  <>
                    <FundRow label="Price Trend (65%)" value={stock.score_tech != null ? `${stock.score_tech.toFixed(1)}/10` : null}
                      hint="SMA-200 trend + RSI momentum — primary signal for ETFs" positive={stock.score_tech != null ? stock.score_tech >= 6 : undefined} />
                    <FundRow label="News Sentiment (35%)" value={stock.score_news != null ? `${stock.score_news.toFixed(1)}/10` : null}
                      hint="Sector/theme news — macro events relevant to the fund" positive={stock.score_news != null ? stock.score_news >= 6 : undefined} />
                  </>
                ) : (
                  <>
                    <FundRow label="Business Quality (60%)" value={stock.score_fund != null ? `${stock.score_fund.toFixed(1)}/10` : null}
                      hint="ROIC · SBC-adjusted FCF · Debt · Revenue growth · Competitive moat · FCF yield valuation"
                      positive={stock.score_fund != null ? stock.score_fund >= 6 : undefined} />
                    {fcfYieldPct != null && (() => {
                      const fy = (stock.fcf_yield != null ? stock.fcf_yield : 0);
                      const adj = fy > 0.06 ? +0.7 : fy > 0.04 ? +0.4 : fy > 0.025 ? +0.1 : fy > 0.015 ? 0 : fy > 0.008 ? -0.8 : -1.8;
                      const adjLabel = adj > 0 ? `+${adj.toFixed(1)} pts (cheap)` : adj < 0 ? `${adj.toFixed(1)} pts (expensive)` : '±0 (fair)';
                      return (
                        <FundRow label="  ↳ Valuation adj (in quality)"
                          value={adjLabel}
                          hint={`FCF yield of ${fcfYieldPct.toFixed(1)}% applied a ${adjLabel} adjustment.`} />
                      );
                    })()}
                    <FundRow label="Insider Activity (15%)" value={stock.score_insider != null ? `${stock.score_insider.toFixed(1)}/10` : null}
                      hint="CEO/CFO open-market buys (3x weight). Excludes grants, withholding, option exercises."
                      positive={stock.score_insider != null ? stock.score_insider >= 6 : undefined} />
                    <FundRow label="Analyst Consensus (10%)" value={stock.score_rating != null ? `${stock.score_rating.toFixed(1)}/10` : null}
                      hint="Buy/sell/hold consensus + upgrade/downgrade velocity" positive={stock.score_rating != null ? stock.score_rating >= 6 : undefined} />
                    <FundRow label="Price Trend (8%)" value={stock.score_tech != null ? `${stock.score_tech.toFixed(1)}/10` : null}
                      hint="SMA-200 trend (60%) + RSI (40%). Oversold quality stocks score high."
                      positive={stock.score_tech != null ? stock.score_tech >= 6 : undefined} />
                    <FundRow label="News Sentiment (7%)" value={stock.score_news != null ? `${stock.score_news.toFixed(1)}/10` : null}
                      hint="3x daily news runs weighted by recency. Low weight intentional." positive={stock.score_news != null ? stock.score_news >= 6 : undefined} />
                  </>
                )}
              </div>
            </div>
            );
          })()}
        </div>
      </td>
    </tr>
  );
};


// ── EarningsCard ──────────────────────────────────────────────────────────────
// Lazy-fetches /api/portfolio/:symbol/earnings on first expand.
// Shows next earnings date + last 4 quarters of EPS surprise vs consensus.
const EarningsCard = ({ symbol }) => {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [expanded, setExpanded] = React.useState(false);

  const load = useCallback(async () => {
    if (data || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/portfolio/earnings-event/${encodeURIComponent(symbol)}`);
      if (res.status === 204) { setData({}); return; } // no earnings event yet — show empty state
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // Route wraps payload in { status, symbol, event, timestamp } — unwrap it
      setData(json.event ?? json);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [symbol, data, loading]);

  const toggle = () => {
    if (!expanded && !data) load();
    setExpanded(v => !v);
  };

  const fmtDate = (s) => {
    if (!s) return '—';
    try { return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return s; }
  };

  const surpriseColor = (pct) => {
    if (pct == null) return '#6b7280';
    return pct >= 5 ? '#059669' : pct >= 0 ? '#6b7280' : pct >= -5 ? '#d97706' : '#dc2626';
  };

  return (
    <div className="detail-section">
      <div className="detail-section-head" style={{ cursor: 'pointer' }} onClick={toggle}>
        <span className="detail-section-title">📅 Earnings</span>
        <span style={{ fontSize: 10, color: '#6b7280', userSelect: 'none' }}>{expanded ? '▲ hide' : '▼ show'}</span>
      </div>
      {expanded && (
        <div>
          {loading && <p style={{ fontSize: 11, color: '#6b7280', margin: '4px 0' }}>Loading…</p>}
          {error && <p style={{ fontSize: 11, color: '#dc2626', margin: '4px 0' }}>⚠ {error}</p>}
          {data && !loading && (() => {
            // After unwrapping json.event, data has shape from earnings-event.js:
            // { gemini: { summary, eps_beat, revenue_beat, guidance_direction,
            //   thesis_confirms, thesis_risks, management_confidence },
            //   quarter, year, estimates: { eps, revenue }, pressRelease }
            const g          = data.gemini ?? {};
            const summary    = g.summary            ?? null;
            const epsBeat    = g.eps_beat            ?? null;
            const revBeat    = g.revenue_beat        ?? null;
            const guidance   = g.guidance_direction  ?? null;
            const confirms   = g.thesis_confirms     ?? [];
            const risks      = g.thesis_risks        ?? [];
            const quarter    = data.quarter ? `Q${data.quarter} ${data.year ?? ''}`.trim() : null;
            const epsEst     = data.estimates?.eps;
            const revEst     = data.estimates?.revenue;
            const hasContent = summary || epsBeat != null || guidance;

            const beatColor  = (v) => v === true ? '#059669' : v === false ? '#dc2626' : '#6b7280';
            const beatLabel  = (v) => v === true ? '✓ Beat' : v === false ? '✗ Missed' : '—';
            const guidanceColor = guidance === 'raised' ? '#059669'
                               : guidance === 'lowered' ? '#dc2626'
                               : '#6b7280';

            return (
              <div className="detail-rows">
                {quarter && (
                  <FundRow label="Period" value={quarter} />
                )}
                {epsBeat != null && (
                  <FundRow
                    label="EPS vs Estimate"
                    value={<span style={{ color: beatColor(epsBeat) }}>{beatLabel(epsBeat)}</span>}
                    hint={epsEst != null ? `Consensus: $${epsEst}` : undefined}
                    positive={epsBeat === true}
                  />
                )}
                {revBeat != null && (
                  <FundRow
                    label="Revenue vs Estimate"
                    value={<span style={{ color: beatColor(revBeat) }}>{beatLabel(revBeat)}</span>}
                    hint={revEst != null ? `Consensus: $${(revEst / 1e6).toFixed(0)}M` : undefined}
                    positive={revBeat === true}
                  />
                )}
                {guidance && guidance !== 'none' && (
                  <FundRow
                    label="Guidance"
                    value={<span style={{ color: guidanceColor, textTransform: 'capitalize' }}>{guidance}</span>}
                    positive={guidance === 'raised'}
                  />
                )}
                {summary && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 700, marginBottom: 4 }}>
                      AI VERDICT
                    </div>
                    <p style={{ fontSize: 11, color: '#d4d4d0', lineHeight: 1.6, margin: 0 }}>{summary}</p>
                  </div>
                )}
                {confirms.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 10, color: '#059669', fontWeight: 700, marginBottom: 4 }}>THESIS CONFIRMS</div>
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: '#d4d4d0', lineHeight: 1.6 }}>
                      {confirms.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  </div>
                )}
                {risks.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 10, color: '#dc2626', fontWeight: 700, marginBottom: 4 }}>THESIS RISKS</div>
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: '#d4d4d0', lineHeight: 1.6 }}>
                      {risks.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                )}
                {!hasContent && (
                  <p style={{ fontSize: 11, color: '#6b7280', margin: '4px 0' }}>
                    No earnings event data for this ticker yet.
                  </p>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
};

// ── FilingNarrativeCard ────────────────────────────────────────────────────────
// Lazy-fetches /api/portfolio/:symbol/filing-narrative on first expand.
// Displays Gemini-generated MD&A summary + risk factor bullets + evidence/uncertainty flags.
// Only rendered when filing_sentiment is present (Gemini has processed this ticker).
// IFRS/foreign-filer note is shown for 20-F/6-K filers (MELI, SCCO).
const FilingNarrativeCard = ({ symbol, filingForm }) => {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [expanded, setExpanded] = React.useState(false);

  const isForeignFiler = filingForm === '20-F' || filingForm === '6-K';

  const load = useCallback(async () => {
    if (data || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/portfolio/filing-narrative/${encodeURIComponent(symbol)}`);
      if (res.status === 204) { setData({}); return; } // no narrative yet — show empty state
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // Route wraps payload in { status, symbol, narrative, timestamp } — unwrap it
      setData(json.narrative ?? json);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [symbol, data, loading]);

  const toggle = () => {
    if (!expanded && !data) load();
    setExpanded(v => !v);
  };

  return (
    <div className="detail-section">
      <div className="detail-section-head" style={{ cursor: 'pointer' }} onClick={toggle}>
        <span className="detail-section-title">🤖 Filing Narrative (AI)</span>
        <span style={{ fontSize: 10, color: '#6b7280', userSelect: 'none' }}>{expanded ? '▲ hide' : '▼ show'}</span>
      </div>
      {expanded && (
        <div>
          {isForeignFiler && (
            <p style={{ fontSize: 10, color: '#d97706', margin: '2px 0 6px', lineHeight: 1.5 }}>
              ⚠ Foreign filer ({filingForm}) — uses IFRS accounting. Narrative is extracted from 20-F/6-K, not 10-K/10-Q.
            </p>
          )}
          {loading && <p style={{ fontSize: 11, color: '#6b7280', margin: '4px 0' }}>Loading…</p>}
          {error && <p style={{ fontSize: 11, color: '#dc2626', margin: '4px 0' }}>⚠ {error}</p>}
          {data && !loading && (() => {
            // Route returns raw Redis payload: { gemini: { summary, thesis_risks, ... }, form, filed }
            // Normalise to flat fields the card uses.
            const g             = data.gemini ?? {};
            const mdaSummary    = g.summary          ?? null;
            const riskFactors   = g.thesis_risks      ?? [];
            const evidenceQuotes = g.evidence_quotes  ?? [];
            const uncertFlags   = g.uncertainty_flags ?? [];
            const thesisStatus  = g.thesis_status     ?? null;
            const filedDate     = data.filed          ?? null;
            const formType      = data.form           ?? null;
            const hasContent    = mdaSummary || riskFactors.length > 0;

            const statusColor = thesisStatus === 'strengthening' ? '#059669'
                              : thesisStatus === 'weakening'     ? '#dc2626'
                              : thesisStatus === 'stable'        ? '#6b7280'
                              : '#d97706';

            return (
              <div>
                <p style={{ fontSize: 10, color: '#6b7280', fontStyle: 'italic', margin: '0 0 8px', lineHeight: 1.5 }}>
                  AI-interpreted summary of SEC filing text. Not a scoring input — display only.
                </p>

                {thesisStatus && (
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 700 }}>THESIS: </span>
                    <span style={{ fontSize: 11, color: statusColor, fontWeight: 600, textTransform: 'uppercase' }}>
                      {thesisStatus}
                    </span>
                    {formType && filedDate && (
                      <span style={{ fontSize: 10, color: '#6b7280', marginLeft: 8 }}>
                        ({formType} · {filedDate})
                      </span>
                    )}
                  </div>
                )}

                {mdaSummary && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 700, marginBottom: 4 }}>MD&A SUMMARY</div>
                    <p style={{ fontSize: 11, color: '#d4d4d0', lineHeight: 1.6, margin: 0 }}>{mdaSummary}</p>
                  </div>
                )}

                {riskFactors.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 700, marginBottom: 4 }}>KEY RISK FACTORS</div>
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: '#d4d4d0', lineHeight: 1.6 }}>
                      {riskFactors.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </div>
                )}

                {evidenceQuotes.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: '#6b7280', fontWeight: 700, marginBottom: 4 }}>EVIDENCE FROM FILING</div>
                    {evidenceQuotes.map((q, i) => (
                      <div key={i} style={{
                        fontSize: 10, color: '#9ca3af', fontStyle: 'italic',
                        borderLeft: '2px solid #374151', paddingLeft: 8, marginBottom: 4, lineHeight: 1.5,
                      }}>"{q}"</div>
                    ))}
                  </div>
                )}

                {uncertFlags.length > 0 && (
                  <div>
                    <div style={{ fontSize: 10, color: '#d97706', fontWeight: 700, marginBottom: 4 }}>⚠ UNCERTAINTY FLAGS</div>
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: '#d97706', lineHeight: 1.6 }}>
                      {uncertFlags.map((f, i) => <li key={i}>{f}</li>)}
                    </ul>
                  </div>
                )}

                {!hasContent && (
                  <p style={{ fontSize: 11, color: '#6b7280', margin: '4px 0' }}>Narrative not yet generated for this ticker.</p>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
};

// ── Modal ─────────────────────────────────────────────────────────────────────
const Modal = ({ onClose, children, wide = false }) =>
  createPortal(
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className={`modal-box${wide ? ' modal-news' : ''}`}
        onMouseDown={e => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body
  );

// ── Main Component ────────────────────────────────────────────────────────────
const EnhancedPortfolioDashboard = () => {
  const [portfolio, setPortfolio] = useState([]);
  const [stats, setStats] = useState(null);
  const [marketRegime, setMarketRegime] = useState({ regime: 'NORMAL', spy21d: 0 });
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [sortBy, setSortBy] = useState('score');
  const [filterSignal, setFilterSignal] = useState('ALL');
  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState('add');
  const [formData, setFormData] = useState({
    symbol: '', name: '', quantity: '', average_price: '', type: 'Stock', sector: '',
  });
  const [editingId, setEditingId] = useState(null);
  const [newsModalStock, setNewsModalStock] = useState(null);
  const [expandedRow, setExpandedRow] = useState(null);

  const fetchPortfolio = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/portfolio');
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      if (data.status === 'success') {
        const sorted = [...data.portfolio].sort((a, b) => (b.latest_score || 0) - (a.latest_score || 0));
        setPortfolio(sorted);
        setStats(data.stats);
        setLastUpdate(new Date(data.timestamp));
        try {
          const mr = await fetch('/api/portfolio/market-regime');
          if (mr.ok) {
            const mrData = await mr.json();
            if (mrData?.regime) setMarketRegime(mrData);
          }
        } catch (_e) { /* non-critical */ }
      }
    } catch (_err) {
      console.error('Portfolio fetch failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPortfolio();
    const interval = setInterval(fetchPortfolio, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchPortfolio]);

  const handleAddStock = async (e) => {
    e.preventDefault();
    if (!formData.symbol || !formData.quantity || !formData.average_price) return;
    try {
      const res = await fetch('/api/portfolio/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.ok) { setShowForm(false); fetchPortfolio(); }
    } catch (_err) { console.error('Add failed'); }
  };

  const handleEditStock = async (e) => {
    e.preventDefault();
    if (!editingId) return;
    try {
      const res = await fetch(`/api/portfolio/edit/${editingId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.ok) { setShowForm(false); setEditingId(null); fetchPortfolio(); }
    } catch (_err) { console.error('Edit failed'); }
  };

  const handleDeleteStock = async (id) => {
    if (!window.confirm('Remove this asset from the portfolio?')) return;
    try {
      const res = await fetch(`/api/portfolio/delete/${id}`, { method: 'DELETE' });
      if (res.ok) fetchPortfolio();
    } catch (_err) { console.error('Delete failed'); }
  };

  const openEditForm = (stock) => {
    setFormMode('edit');
    setEditingId(stock.id);
    setFormData({
      symbol: stock.symbol, name: stock.name || '',
      quantity: stock.quantity.toString(), average_price: stock.average_price.toString(),
      type: stock.type || 'Stock', sector: stock.sector || '',
    });
    setShowForm(true);
  };

  const openAddForm = () => {
    setFormMode('add');
    setEditingId(null);
    setFormData({ symbol: '', name: '', quantity: '', average_price: '', type: 'Stock', sector: '' });
    setShowForm(true);
  };

  const toggleRow = (symbol) => setExpandedRow(prev => prev === symbol ? null : symbol);

  const getFilteredPortfolio = () => {
    let filtered = [...portfolio];
    if (filterSignal === 'BULLISH')
      filtered = filtered.filter(s => ['ADD', 'SPRING_CONFIRMED', 'SPRING_CANDIDATE', 'STRONG_BUY', 'BUY'].includes(s.signal || ''));
    else if (filterSignal === 'NOISE')
      filtered = filtered.filter(s => ['HOLD_NOISE', 'MARKET_NOISE', 'HOLD', 'NORMAL'].includes(s.signal || '') || s.regime === 'MARKET_NOISE');
    else if (filterSignal === 'BEARISH')
      filtered = filtered.filter(s => ['WATCH', 'TRIM_25', 'REDUCE', 'SELL', 'IDIOSYNCRATIC_DECAY'].includes(s.signal || ''));

    return filtered.sort((a, b) => {
      if (sortBy === 'moat') return (b.moat_score || 0) - (a.moat_score || 0);
      if (sortBy === 'alpha') return (b.excess_return || 0) - (a.excess_return || 0);
      if (sortBy === 'symbol') return a.symbol.localeCompare(b.symbol);
      if (sortBy === 'pnl') {
        const pA = ((a.current_price || 0) - (a.average_price || 0)) * (a.quantity || 0);
        const pB = ((b.current_price || 0) - (b.average_price || 0)) * (b.quantity || 0);
        return pB - pA;
      }
      return (b.latest_score || 0) - (a.latest_score || 0);
    });
  };

  const filteredPortfolio = getFilteredPortfolio();

  const totalVal = portfolio.reduce((s, x) => s + ((x.current_price || 0) * (x.quantity || 0)), 0);
  const totalCost = portfolio.reduce((s, x) => s + ((x.average_price || 0) * (x.quantity || 0)), 0);
  const totalPnL = totalVal - totalCost;
  const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

  const totalDayChange = portfolio.reduce((s, x) => {
    if (!x.current_price || x.change_percent == null || !x.quantity) return s;
    const prev = x.current_price / (1 + x.change_percent / 100);
    return s + (x.current_price - prev) * x.quantity;
  }, 0);

  const totalDayPct = totalVal > 0
    ? portfolio.reduce((s, x) => {
      if (!x.current_price || x.change_percent == null || !x.quantity) return s;
      return s + x.change_percent * ((x.current_price * x.quantity) / totalVal);
    }, 0) : 0;

  const avgScore = portfolio.length
    ? (portfolio.reduce((s, x) => s + (x.latest_score || 0), 0) / portfolio.length).toFixed(1) : '—';
  const bullCount = portfolio.filter(s => ['ADD', 'SPRING_CONFIRMED', 'SPRING_CANDIDATE', 'STRONG_BUY', 'BUY'].includes(s.signal || '')).length;
  const bearCount = portfolio.filter(s => ['WATCH', 'TRIM_25', 'REDUCE', 'SELL', 'IDIOSYNCRATIC_DECAY'].includes(s.signal || '')).length;

  if (loading && portfolio.length === 0) {
    return (
      <div className="dashboard-container">
        <NeuralBackground />
        <div className="loading-wrap"><div className="loading-ring" /></div>
      </div>
    );
  }

  const mr = (marketRegime && marketRegime.regime) ? marketRegime.regime : 'NORMAL';

  return (
    <div className="dashboard-container">
      <NeuralBackground />

      <div className="dashboard-header">
        <div>
          <h1>Alpha Compounder</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <p className="subtitle" style={{ margin: 0 }}>Regime-Aware · Long-Horizon · Fundamentals-First</p>
            {(marketRegime && marketRegime.regime) && marketRegime.regime !== 'NORMAL' && (
              <span style={{
                padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                fontFamily: 'var(--font-mono)',
                background: marketRegime.regime === 'BEAR' ? '#fef2f220' : '#fff7ed20',
                color: marketRegime.regime === 'BEAR' ? '#dc2626' : '#c2410c',
                border: `1px solid ${marketRegime.regime === 'BEAR' ? '#fca5a540' : '#fdba7440'}`,
              }}>
                {marketRegime.regime === 'BEAR' ? '🐻 BEAR MARKET' : '⚠ STRESSED'}
                {' · SPY '}{marketRegime.spy21d >= 0 ? '+' : ''}{(marketRegime.spy21d || 0).toFixed(1)}%
              </span>
            )}
          </div>
        </div>
        <div className="header-actions">
          {lastUpdate && (
            <div className="last-update">
              <span className="live-dot" />
              Last: {lastUpdate.toLocaleTimeString()}
            </div>
          )}
          <button onClick={openAddForm} className="btn-primary">+ Add Stock</button>
        </div>
      </div>

      <div className="summary-section">
        <div className="stats-grid">
          <div className="stat-card accent-card">
            <div className="stat-label">Portfolio Value</div>
            <div className="stat-value stat-value-sm">{fmtUSD((stats && stats.totalValue != null ? stats.totalValue : totalVal), true)}</div>
          </div>
          <div className={`stat-card ${totalDayChange >= 0 ? 'profit-card' : 'loss-card'}`}>
            <div className="stat-label">Today&apos;s Change</div>
            <div className="stat-value stat-value-sm" style={{ color: totalDayChange >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {totalDayChange >= 0 ? '+' : ''}{fmtUSD(totalDayChange, true)}
            </div>
            <div className={`stat-sub ${totalDayChange >= 0 ? 'pos' : 'neg'}`}>{fmtPct(totalDayPct)} vs yesterday</div>
          </div>
          <div className={`stat-card ${totalPnL >= 0 ? 'profit-card' : 'loss-card'}`}>
            <div className="stat-label">Total Gain / Loss</div>
            <div className="stat-value stat-value-sm" style={{ color: totalPnL >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {totalPnL >= 0 ? '+' : ''}{fmtUSD(totalPnL, true)}
            </div>
            <div className={`stat-sub ${totalPnL >= 0 ? 'pos' : 'neg'}`}>{fmtPct(totalPnLPct)} vs cost</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Avg Quality</div>
            <div className="stat-value" style={{ color: scoreCol(parseFloat(stats?.averageScore != null ? String(stats.averageScore) : String(avgScore))) }}>
              {(stats && stats.averageScore != null ? stats.averageScore : avgScore)}<span className="stat-unit">/10</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Buy Signals</div>
            <div className="stat-value" style={{ color: bullCount > 0 ? 'var(--green)' : 'var(--text-muted)' }}>{bullCount}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Risk Alerts</div>
            <div className="stat-value" style={{ color: bearCount > 0 ? 'var(--red)' : 'var(--text-muted)' }}>{bearCount}</div>
          </div>
        </div>
      </div>

      <div className="controls-section">
        <div className="filter-pills">
          {[
            { v: 'ALL', l: 'All' },
            { v: 'BULLISH', l: '▲ Buy Signals' },
            { v: 'NOISE', l: '— Noise' },
            { v: 'BEARISH', l: '▼ Risk Alerts' },
          ].map(({ v, l }) => (
            <button key={v}
              className={`pill ${filterSignal === v ? 'pill-active' : ''}`}
              onClick={() => setFilterSignal(v)}>{l}</button>
          ))}
        </div>
        <select className="minimal-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="score">Sort: Quality Score</option>
          <option value="moat">Sort: Moat Score</option>
          <option value="alpha">Sort: Outperformance (α)</option>
          <option value="pnl">Sort: Gain / Loss</option>
          <option value="symbol">Sort: Symbol A–Z</option>
        </select>
        <div className="results-count">{filteredPortfolio.length} of {portfolio.length} assets</div>
      </div>

      <div className="portfolio-section">
        {filteredPortfolio.length === 0 ? (
          <div className="no-results">
            No assets match this filter.&nbsp;
            <button className="btn-secondary" style={{ padding: '6px 14px' }}
              onClick={() => setFilterSignal('ALL')}>Clear filter</button>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="portfolio-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Price &amp; P&amp;L</th>
                  <th>Quality &amp; Moat</th>
                  <th>Context &amp; α</th>
                  <th>Recommendation</th>
                  <th>Position Value</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredPortfolio.map(stock => {
                  const tv = (parseFloat(String(stock.current_price)) || 0) * (parseFloat(String(stock.quantity)) || 0);
                  const pd = ((stock.current_price || 0) - (stock.average_price || 0)) * (stock.quantity || 0);
                  const pp = stock.average_price > 0
                    ? ((stock.current_price - stock.average_price) / stock.average_price) * 100
                    : null;
                  const sCfg = sig(stock.signal);
                  const isExpanded = expandedRow === stock.symbol;

                  // Weight assessment (REDESIGNED)
                  const score = (stock.latest_score != null ? stock.latest_score : 5);
                  const wPct = totalVal > 0 ? (tv / totalVal) * 100 : 0;
                  const wa = getWeightAssessment(wPct, score, stock.signal || '', portfolio, mr, stock.instrument_type === 'ETF', stock.excess_return);

                  return (
                    <React.Fragment key={stock.id}>
                      <tr className={`row-${sCfg.tier}${isExpanded ? ' row-expanded' : ''}`}>
                        <td>
                          <div className="symbol-row">
                            <strong className="stock-symbol">{stock.symbol}</strong>
                            {stock.instrument_type === 'ETF' && (
                              <span className="etf-badge" title="ETF — scored on momentum and news">ETF</span>
                            )}
                          </div>
                          {stock.name && <div className="stock-name">{stock.name}</div>}
                          {stock.sector && <span className="sector-pill">{stock.sector}</span>}
                        </td>

                        <td>
                          <div className="price-value">{fmtUSD(stock.current_price)}</div>
                          {stock.change_percent != null && (
                            <div className={`change ${stock.change_percent >= 0 ? 'positive' : 'negative'}`}>
                              {stock.change_percent >= 0 ? '+' : ''}{stock.change_percent.toFixed(2)}% today
                            </div>
                          )}
                          {stock.average_price > 0 && stock.current_price > 0 && (
                            <div className={`change ${pd >= 0 ? 'positive' : 'negative'}`} style={{ fontWeight: 600, marginTop: 4 }}>
                              {pd >= 0 ? '▲' : '▼'} {fmtUSD(Math.abs(pd))}
                              {pp != null && <span style={{ opacity: .75 }}> ({fmtPct(pp)})</span>}
                            </div>
                          )}
                        </td>

                        <td>
                          <div className="quality-moat-cell">
                            <ScoreRing score={stock.latest_score} />
                            {stock.moat_score != null && <MoatRing score={stock.moat_score} />}
                            {stock.capex_exception && (
                              <span className="capex-flag" title="Strategic capex: FCF penalty forgiven">🏗️</span>
                            )}
                          </div>
                          {stock.fcf_yield != null && stock.fcf_yield > 0 && (
                            <div className="compact-metric"
                              title={`FCF yield ${(stock.fcf_yield * 100).toFixed(1)}% — ${stock.fcf_yield > 0.05 ? 'cheap entry' : stock.fcf_yield > 0.03 ? 'fair value' : 'expensive'}`}>
                              <span className="compact-lbl">FCF yld</span>
                              <span className={`compact-val ${stock.fcf_yield * 100 > 3 ? 'pos' : stock.fcf_yield * 100 < 1.5 ? 'neg' : ''}`}>
                                {(stock.fcf_yield * 100).toFixed(1)}%
                              </span>
                            </div>
                          )}
                        </td>

                        {/* Context column: quantitative context only — NO regime label.
                            The signal badge in Recommendation already encodes the regime.
                            Showing it here too creates two conflicting signals. */}
                        <td>
                          {stock.excess_return != null && (
                            <div
                              className={`alpha-val change ${stock.excess_return >= 0 ? 'positive' : 'negative'}`}
                              title={'Jensen alpha: stock return vs SPY, adjusted for beta. Positive = outperforming the market on a risk-adjusted basis.'}>
                              α {fmtPct(stock.excess_return)}
                            </div>
                          )}
                          {stock.beta != null && (
                            <div className="beta-val"
                              title={`Beta ${Number(stock.beta).toFixed(2)}: ${Number(stock.beta) > 1.3 ? 'high volatility vs market' : Number(stock.beta) < 0.7 ? 'defensive vs market' : 'moves broadly with market'}`}>
                              β {Number(stock.beta).toFixed(2)}
                            </div>
                          )}
                          {stock.max_drawdown != null && (
                            <div className="compact-metric"
                              title={`Max drawdown ${stock.max_drawdown.toFixed(1)}% — largest peak-to-trough fall in the past year.${stock.max_drawdown < -30 ? ' Significant — check if thesis intact.' : ''}`}>
                              <span className="compact-lbl">MaxDD</span>
                              <span className={`compact-val ${stock.max_drawdown > -15 ? '' : 'neg'}`}>
                                {stock.max_drawdown.toFixed(1)}%
                              </span>
                            </div>
                          )}
                        </td>

                        <td>
                          {/* Signal badge — primary output. Bold and prominent. */}
                          <span
                            title={[sCfg.why, sCfg.action].filter(Boolean).join(' → ')}
                            className={`signal-badge ${
                              sCfg.tier === 'bull' ? 'signal-bull' :
                                sCfg.tier === 'bear' && ['WATCH', 'TRIM_25'].includes(stock.signal || '') ? 'signal-bear-soft' :
                                  sCfg.tier === 'bear' ? 'signal-bear-hard' : 'signal-neutral'
                            }`}
                            style={{ fontSize: 13, padding: '4px 10px', fontWeight: 800, letterSpacing: '0.01em' }}>
                            {sCfg.label}
                          </span>
                          {/* Action text — the "what to do" instruction, visually subordinate but readable */}
                          {sCfg.action && (
                            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4, lineHeight: 1.4, maxWidth: 145, fontStyle: 'italic' }}>
                              {sCfg.action}
                            </div>
                          )}
                          {stock.sharp_score_drop && (
                            <div title={`Quality score dropped ${Math.abs(stock.score_delta_1d || 0).toFixed(1)} pts vs yesterday`}
                              style={{
                                display: 'inline-block', marginLeft: 4, padding: '1px 5px', fontSize: 9, fontWeight: 700,
                                background: '#fef2f220', color: '#dc2626', border: '1px solid #fca5a540', borderRadius: 3, verticalAlign: 'middle',
                              }}>
                              ⚡ −{Math.abs(stock.score_delta_1d || 0).toFixed(1)}
                            </div>
                          )}
                          <SpringBar days={stock.spring_days} />
                          <CascadePips w1={stock.w1_signal} w2={stock.w2_confirmed} w3={stock.w3_confirmed} w4={stock.w4_confirmed} />
                        </td>

                        <td>
                          <div className="price-value">{fmtUSD(tv)}</div>
                          {totalVal > 0 && (
                            <div
                              title={
                                stock.instrument_type === 'ETF'
                                  ? (wPct.toFixed(1) + '% of portfolio | ETF anchor | ' + wa.verdict + (stock.excess_return != null ? ' | alpha vs SPY: ' + fmtPct(stock.excess_return) : ''))
                                  : (wPct.toFixed(1) + '% of portfolio (' + (wa.fairShare != null ? wPct.toFixed(1) + '% held vs ' + wa.fairShare.toFixed(1) + '% fair share' : '') + ') | ' + wa.verdict + (wa.absCeiling ? ' | ceiling: ' + wa.absCeiling + '%' : ''))
                              }
                              style={{
                                fontFamily: 'var(--font-mono)', fontSize: 11, color: wa.color,
                                marginTop: 3,
                                fontWeight: (wa.ratio != null && (wa.ratio > 1.35 || wa.ratio < 0.6)) ? 700 : 400,
                              }}>
                              {wPct.toFixed(1)}%
                              {wa.icon === 'OK'    && ' ✓'}
                              {wa.icon === 'add'   && ' ↑'}
                              {wa.icon === 'add+'  && ' ↑↑'}
                              {wa.icon === 'over'  && ' ⚠'}
                              {wa.icon === 'high'  && ' 🚫'}
                              {wa.icon === 'cap'   && ' 🚫'}
                              {wa.icon === 'trim'  && ' ⚠'}
                              {wa.icon === 'drag'  && ' ↓'}
                            </div>
                          )}
                        </td>

                        <td className="col-actions">
                          <button onClick={() => toggleRow(stock.symbol)}
                            className={`btn-icon btn-expand${isExpanded ? ' btn-expand-active' : ''}`}
                            title={isExpanded ? 'Collapse' : 'Expand detail'}>
                            {isExpanded ? '▲' : '▼'}
                          </button>
                          <button onClick={() => setNewsModalStock(stock)} className="btn-icon" title="Intelligence">📰</button>
                          <button onClick={() => openEditForm(stock)} className="btn-icon" title="Edit">✏️</button>
                          <button onClick={() => handleDeleteStock(stock.id)} className="btn-icon btn-icon-danger" title="Remove">✕</button>
                        </td>
                      </tr>
                      {isExpanded && <DetailPanel key={`detail-${stock.id}`} stock={stock} />}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CorrelationHeatmap />

      {/* Add / Edit Modal */}
      {showForm && (
        <Modal onClose={() => setShowForm(false)}>
          <div className="modal-header">
            <div className="modal-header-text">
              <h2>{formMode === 'add' ? 'Add Stock' : 'Edit Position'}</h2>
              <p className="modal-sub-label">
                {formMode === 'add' ? 'Enter ticker to begin tracking. Sector is auto-detected.' : `Editing ${formData.symbol}`}
              </p>
            </div>
            <button className="btn-close" onClick={() => setShowForm(false)}>✕</button>
          </div>
          <div className="modal-body">
            <div className="form-grid">
              <div className="form-group">
                <label>Symbol</label>
                <input type="text" placeholder="e.g. CRWD" value={formData.symbol}
                  onChange={e => setFormData({ ...formData, symbol: e.target.value.toUpperCase() })}
                  disabled={formMode === 'edit'} />
              </div>
              <div className="form-group">
                <label>Company Name</label>
                <input type="text" placeholder="Optional" value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Quantity</label>
                <input type="number" step="0.01" value={formData.quantity}
                  onChange={e => setFormData({ ...formData, quantity: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Avg Cost (per share)</label>
                <input type="number" step="0.01" value={formData.average_price}
                  onChange={e => setFormData({ ...formData, average_price: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Sector <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 400 }}>(auto-filled after first run)</span></label>
                <input type="text" placeholder="e.g. Technology" value={formData.sector}
                  onChange={e => setFormData({ ...formData, sector: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Type</label>
                <select value={formData.type} onChange={e => setFormData({ ...formData, type: e.target.value })}>
                  <option>Stock</option>
                  <option>ETF</option>
                </select>
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
            <button type="button" className="btn-primary"
              onClick={formMode === 'add' ? handleAddStock : handleEditStock}>
              {formMode === 'add' ? 'Add to Portfolio' : 'Save Changes'}
            </button>
          </div>
        </Modal>
      )}

      {/* Intelligence Modal */}
      {newsModalStock && (
        <Modal onClose={() => setNewsModalStock(null)} wide>
          <div className="modal-header">
            <div className="modal-header-text">
              <h2>Intelligence · {newsModalStock.symbol}</h2>
              <p className="modal-sub-label">
                {sig(newsModalStock.signal).label}
                {newsModalStock.excess_return != null ? (' · α ' + fmtPct(newsModalStock.excess_return)) : ''}
              </p>
            </div>
            <button className="btn-close" onClick={() => setNewsModalStock(null)}>✕</button>
          </div>
          <div className="modal-body">
            {newsModalStock.recent_news && newsModalStock.recent_news.length > 0 ? (
              newsModalStock.recent_news.map((n, i) => (
                <a href={n.url} target="_blank" rel="noopener noreferrer" key={i} className="news-card">
                  <span className="news-date">
                    {new Date(n.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                  <h3 className="news-headline">{n.headline}</h3>
                  {n.description && <p className="news-desc">{n.description.substring(0, 180)}…</p>}
                </a>
              ))
            ) : (
              <p className="no-news">No actionable intelligence found for this cycle.</p>
            )}
          </div>
        </Modal>
      )}

      {/* Signal guide */}
      <div style={{ marginTop: 32, padding: '16px 20px', background: '#1a1a1a18', borderRadius: 10, border: '1px solid #ffffff10' }}>
        <p style={{ textAlign: 'center', fontSize: 10, color: '#6b6b65', margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>
          Signal Guide
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '6px 16px' }}>
          {[
            { label: 'Strong Buy / Buy', color: '#3b82f6', desc: 'Score high + quality fundamentals. Add or initiate.' },
            { label: 'Spring Confirmed', color: '#047857', desc: 'Quality stock recovering from oversold dip. Best contrarian entry.' },
            { label: 'Spring Candidate', color: '#10b981', desc: 'Early dip recovery. Watch for Day 3 confirmation before adding.' },
            { label: 'Add', color: '#059669', desc: 'Accumulation zone: positive alpha + solid score + momentum.' },
            { label: 'Hold', color: '#6b7280', desc: 'Score 4.5-7.5 with no directional signal. Let the compounder compound.' },
            { label: 'Watch', color: '#d97706', desc: '3-week score decline. Do not add. Thesis review warranted.' },
            { label: 'Trim 25%', color: '#ea580c', desc: 'Material deterioration. Reduce position, lock partial gains.' },
            { label: 'Reduce', color: '#dc2626', desc: 'Score below 4.5 with W3 confirmed. Structural decline, not a blip.' },
            { label: 'Sell / Decay', color: '#991b1b', desc: 'Score below 3.5 + W4 or critical event. Exit in tax-efficient manner.' },
          ].map(({ label, color, desc }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, marginTop: 3 }} />
              <div>
                <span style={{ fontSize: 10, color: color, fontWeight: 700 }}>{label}</span>
                <span style={{ fontSize: 10, color: '#6b6b65' }}> — {desc}</span>
              </div>
            </div>
          ))}
        </div>
        <p style={{ textAlign: 'center', fontSize: 10, color: '#6b6b65', margin: '12px 0 0' }}>
          Weight colour: <span style={{ color: '#059669' }}>green = balanced</span> · <span style={{ color: '#d97706' }}>amber = slightly heavy</span> · <span style={{ color: '#dc2626' }}>red = overweight for score</span> · <span style={{ color: '#2563eb' }}>blue = room to add</span> · ETFs judged on alpha contribution, not weight size.
        </p>
      </div>
      <p style={{ textAlign: 'center', fontSize: 11, color: '#9ca3af', marginTop: 12, lineHeight: 1.6 }}>
        Alpha Compounder · For informational purposes only. Not financial advice.
        All signals are systematic — always apply your own judgement.{' '}
        <strong style={{ color: '#d97706' }}>Indian investors: weigh CGT (20% LTCG / 30% STCG) before acting on any sell signal.</strong>
      </p>
    </div>
  );
};

export default EnhancedPortfolioDashboard;
