import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import './enhanced-portfolio-dashboard.css';
import CorrelationHeatmap from './CorrelationHeatmap';

const SIGNAL_CFG = {
  ADD:                 { color: '#059669', label: 'Add',           tier: 'bull' },
  SPRING_CONFIRMED:    { color: '#047857', label: 'Spring ✓',      tier: 'bull' },
  SPRING_CANDIDATE:    { color: '#10b981', label: 'Spring ~',      tier: 'bull' },
  STRONG_BUY:          { color: '#2563eb', label: 'Strong Buy',    tier: 'bull' },
  BUY:                 { color: '#3b82f6', label: 'Buy',           tier: 'bull' },
  HOLD:                { color: '#6b7280', label: 'Hold',          tier: 'flat' },
  HOLD_NOISE:          { color: '#9ca3af', label: 'Hold · Noise',  tier: 'flat' },
  NORMAL:              { color: '#6b7280', label: 'Normal',        tier: 'flat' },
  MARKET_NOISE:        { color: '#9ca3af', label: 'Mkt Noise',     tier: 'flat' },
  WATCH:               { color: '#d97706', label: 'Watch',         tier: 'bear' },
  TRIM_25:             { color: '#ea580c', label: 'Trim 25%',      tier: 'bear' },
  REDUCE:              { color: '#dc2626', label: 'Reduce',        tier: 'bear' },
  SELL:                { color: '#b91c1c', label: 'Sell',          tier: 'bear' },
  IDIOSYNCRATIC_DECAY: { color: '#7f1d1d', label: 'Decay',         tier: 'bear' },
  INSUFFICIENT_DATA:   { color: '#9ca3af', label: 'No Data',       tier: 'flat' },
};
const REGIME_CFG = {
  MARKET_NOISE:        { color: '#9ca3af', label: 'Market Noise'        },
  WATCH:               { color: '#d97706', label: 'Watch'               },
  IDIOSYNCRATIC_DECAY: { color: '#dc2626', label: 'Idiosyncratic Decay' },
  INSUFFICIENT_DATA:   { color: '#9ca3af', label: 'Insufficient Data'   },
};
const sig = s => SIGNAL_CFG[s] || { color: '#6b7280', label: s || 'Pending', tier: 'flat' };
const reg = r => REGIME_CFG[r] || { color: '#6b7280', label: r  || 'Normal' };

const fmtUSD = (n, compact = false) => {
  if (n == null || isNaN(n)) return 'N/A';
  if (compact && Math.abs(n) >= 1_000_000) return `$${(n/1_000_000).toFixed(2)}M`;
  if (compact && Math.abs(n) >= 1_000)     return `$${(n/1_000).toFixed(1)}K`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
};
const fmtPct = (n, dp = 2) => {
  if (n == null || isNaN(n)) return null;
  return `${n >= 0 ? '+' : ''}${Number(n).toFixed(dp)}%`;
};
const scoreCol = s => {
  if (s == null) return '#9ca3af';
  if (s >= 8)   return '#059669';
  if (s >= 6.5) return '#2563eb';
  if (s >= 5)   return '#d97706';
  return '#dc2626';
};
const moatCol = s => {
  if (s == null) return '#9ca3af';
  if (s >= 7)   return '#059669';
  if (s >= 5)   return '#2563eb';
  if (s >= 3)   return '#d97706';
  return '#dc2626';
};

// ── Canvas Neural Network Background ─────────────────────────────────────────
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
  const mouseRef  = useRef({ x: -9999, y: -9999 });
  const rafRef    = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const resize = () => {
      canvas.width  = window.innerWidth;
      canvas.height = Math.max(window.innerHeight, document.documentElement.scrollHeight);
      if (!_nodesReady) buildNodes(canvas.width, canvas.height);
    };

    const onMouse = e => { mouseRef.current = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY }; };
    const onLeave = () => { mouseRef.current = { x: -9999, y: -9999 }; };
    window.addEventListener('mousemove', onMouse);
    window.addEventListener('mouseleave', onLeave);

    const EDGE_DIST = 170, REPEL_DIST = 130, REPEL_FORCE = 0.77;
    const H_DAMPING = 0.91, V_DAMPING = 0.991, H_RESTORE = 0.016, MAX_SPEED = 0.86;

    const draw = t => {
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      const nodes = _nodes, mx = mouseRef.current.x, my = mouseRef.current.y, now = t * 0.001;

      for (const n of nodes) {
        n.vy += Math.sin(now / n.oPeriod * Math.PI * 2 + n.oPhase) * 0.011;
        n.vx += (Math.random() - 0.5) * 0.011;
        n.vy += (Math.random() - 0.5) * 0.011;
        n.vx -= n.vx * H_RESTORE;
        const dx = n.x - mx, dy = n.y - my, dist = Math.sqrt(dx*dx+dy*dy);
        if (dist < REPEL_DIST && dist > 0) {
          const force = (REPEL_DIST - dist) / REPEL_DIST * REPEL_FORCE;
          n.vx += (dx/dist)*force; n.vy += (dy/dist)*force;
        }
        n.vx *= H_DAMPING; n.vy *= V_DAMPING;
        const spd = Math.sqrt(n.vx*n.vx+n.vy*n.vy);
        if (spd > MAX_SPEED) { n.vx = n.vx/spd*MAX_SPEED; n.vy = n.vy/spd*MAX_SPEED; }
        n.x += n.vx; n.y += n.vy;
        if (n.x < 0) { n.x = 0; n.vx = Math.abs(n.vx)*0.6; }
        if (n.x > W) { n.x = W; n.vx = -Math.abs(n.vx)*0.6; }
        if (n.y < 0) n.y = H;
        if (n.y > H) n.y = 0;
      }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i+1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j], dx = a.x-b.x, dy = a.y-b.y;
          const d = Math.sqrt(dx*dx+dy*dy);
          if (d > EDGE_DIST) continue;
          const ea = (1-d/EDGE_DIST)*0.16;
          const col = a.color === '#a0a09a' ? b.color : a.color;
          // FIX: Avoid nested ternary + template literals (caused JSX parse error at col 107)
          // Use if/else instead of chained ternary for strokeStyle assignment
          let edgeColor;
          if (col === '#059669') edgeColor = 'rgba(5,150,105,' + ea + ')';
          else if (col === '#dc2626') edgeColor = 'rgba(220,38,38,' + ea + ')';
          else edgeColor = 'rgba(160,160,154,' + ea + ')';
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y);
          ctx.strokeStyle = edgeColor;
          ctx.lineWidth=1; ctx.stroke();
        }
      }
      for (const n of nodes) {
        const pulse = 0.82 + 0.18*Math.sin(now*n.pulseSpeed*60+n.pulseOffset);
        ctx.beginPath(); ctx.arc(n.x,n.y,n.r*pulse,0,Math.PI*2);
        // FIX: Same pattern — use if/else instead of chained ternary + template literals
        let nodeColor;
        if (n.color === '#059669') nodeColor = 'rgba(5,150,105,' + (n.alpha*pulse) + ')';
        else if (n.color === '#dc2626') nodeColor = 'rgba(220,38,38,' + (n.alpha*pulse) + ')';
        else nodeColor = 'rgba(160,160,154,' + (n.alpha*pulse) + ')';
        ctx.fillStyle = nodeColor;
        ctx.fill();
      }
      rafRef.current = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener('resize', resize);
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouse);
      window.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  return <canvas ref={canvasRef} className="neural-canvas" aria-hidden="true"/>;
};

// ── Sub-components ────────────────────────────────────────────────────────────
const ScoreRing = ({ score }) => {
  const r = 17, circ = 2 * Math.PI * r;
  const col = scoreCol(score);
  return (
    <div className="score-ring" title={`Quality Score: ${score != null ? score.toFixed(1) : '—'}/10`}>
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r={r} fill="none" stroke="#e6e5df" strokeWidth="2.5"/>
        <circle cx="22" cy="22" r={r} fill="none" stroke={col} strokeWidth="2.5"
          strokeDasharray={`${Math.max(0,Math.min(10,score||0))/10*circ} ${circ}`}
          strokeLinecap="round" transform="rotate(-90 22 22)"
          style={{ transition: 'stroke-dasharray .5s ease' }}/>
      </svg>
      <span className="score-ring-num" style={{ color: col }}>
        {score != null ? score.toFixed(1) : '—'}
      </span>
    </div>
  );
};

const MoatRing = ({ score }) => {
  if (score == null) return null;
  const r = 11, circ = 2 * Math.PI * r;
  const col = moatCol(score);
  return (
    <div className="moat-ring" title={`Moat: ${score.toFixed(1)}/10 — competitive durability. Now contributes 20% to Quality Score.`}>
      <svg width="30" height="30" viewBox="0 0 30 30">
        <circle cx="15" cy="15" r={r} fill="none" stroke="#e6e5df" strokeWidth="2"/>
        <circle cx="15" cy="15" r={r} fill="none" stroke={col} strokeWidth="2"
          strokeDasharray={`${Math.max(0,Math.min(10,score))/10*circ} ${circ}`}
          strokeLinecap="round" transform="rotate(-90 15 15)"
          style={{ transition: 'stroke-dasharray .4s ease' }}/>
      </svg>
      <span className="moat-ring-num" style={{ color: col }}>{score.toFixed(1)}</span>
    </div>
  );
};

// CascadePips — W1 suppressed (7-day noise for 3-7yr mandate).
// Only show when W2+ is active — structurally meaningful signals only.
const CascadePips = ({ w1: _w1, w2, w3, w4 }) => {
  if (!w2 && !w3 && !w4) return null;
  const pips = [
    { k: 'W2', on: w2, col: '#d97706', tip: 'W2: 3-week score decline — monitor, don\'t panic.' },
    { k: 'W3', on: w3, col: '#dc2626', tip: 'W3: 3-month structural decline. Review your thesis.' },
    { k: 'W4', on: w4, col: '#7f1d1d', tip: 'W4: 12-month sustained deterioration. Strongest sell signal.' },
  ];
  const activeCount = pips.filter(p => p.on).length;
  const severity = activeCount >= 3 ? 'Serious (W2+W3+W4)' : activeCount === 2 ? 'Elevated' : 'Watch';
  return (
    <div className="cascade-pips" title={`Decay cascade — ${severity}`}>
      {pips.map(p => (
        <span key={p.k} className={`pip ${p.on ? 'pip-on' : 'pip-off'}`}
          style={p.on ? { background: p.col, borderColor: p.col } : {}}
          title={p.tip}>
          {p.k}
        </span>
      ))}
    </div>
  );
};

const SpringBar = ({ days }) => {
  if (!days || days <= 0) return null;
  const col = days >= 3 ? '#047857' : '#10b981';
  const tip = days >= 3
    ? 'Spring CONFIRMED: Quality stock recovered 3+ days from a dip. Good entry window for long-term investors.'
    : `Spring forming — Day ${days}/3. Wait for Day 3 before adding.`;
  return (
    <div className="spring-bar" title={tip}>
      <div className="spring-track">
        <div className="spring-fill" style={{ width: `${Math.min(days,3)/3*100}%`, background: col }}/>
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
    <div className="fund-row" title={hint}>
      <span className="fund-lbl">{label}</span>
      <span className="fund-val" style={
        positive === true  ? { color: '#059669' } :
        positive === false ? { color: '#dc2626' } : {}
      }>{value}</span>
    </div>
  );
};

// ── Detail Panel ──────────────────────────────────────────────────────────────
const DetailPanel = ({ stock }) => {
  const fcfYieldPct = (stock.fcf_yield != null && stock.fcf_yield > 0) ? (stock.fcf_yield * 100) : null;
  const sbcPct      = stock.sbc_to_market_cap;
  const filingScore = stock.filing_sentiment;
  const isETF       = stock.instrument_type === 'ETF';

  const filingLabel = filingScore == null ? null
    : filingScore >= 7 ? 'Positive tone' : filingScore >= 5 ? 'Neutral tone'
    : filingScore >= 3 ? 'Cautious tone' : 'Negative tone';
  const filingColor = filingScore == null ? '#9ca3af'
    : filingScore >= 7 ? '#059669' : filingScore >= 5 ? '#6b7280'
    : filingScore >= 3 ? '#d97706' : '#dc2626';

  // Gain calculation for tax note
  const gainPct = stock.average_price > 0 && stock.current_price != null
    ? ((stock.current_price - stock.average_price) / stock.average_price) * 100 : null;
  const gainAmt = gainPct != null
    ? (stock.current_price - stock.average_price) * stock.quantity : null;
  const showTaxNote = ['SELL','TRIM_25','REDUCE'].includes(stock.signal) && gainPct != null && gainPct > 20;

  return (
    <tr className="detail-panel-row">
      <td colSpan={7}>
        <div className="detail-panel">

          {/* Tax awareness note — Indian investor */}
          {showTaxNote && (
            <div style={{
              padding: '8px 12px', borderRadius: 8, marginBottom: 4,
              background: '#fff7ed', border: '1px solid #fed7aa',
              display: 'flex', alignItems: 'flex-start', gap: 8,
            }}>
              <span style={{ fontSize: 14, flexShrink: 0 }}>🇮🇳</span>
              <div style={{ fontSize: 11, color: '#92400e', lineHeight: 1.5 }}>
                <strong>Tax consideration:</strong>{' '}
                This position has a <strong>{gainPct.toFixed(0)}% unrealised gain</strong>{' '}
                (~${Math.abs(gainAmt).toFixed(0)} USD).{' '}
                {gainPct > 100
                  ? 'The system requires W4 (12-month structural decline) confirmation before escalating to SELL on large winners. Review the W3 cascade.'
                  : 'Review whether the signal strength justifies the capital gains tax bill (20% LTCG / 30% STCG) before selling.'}
              </div>
            </div>
          )}

          {/* ETF panel */}
          {isETF && (
            <div className="detail-section etf-info-section">
              <div className="detail-section-head">
                <span className="detail-section-title">📊 ETF Overview</span>
              </div>
              <div className="detail-rows">
                <FundRow label="Instrument" value="Exchange-Traded Fund"
                  hint="ETF scores are based on price momentum, trend strength, and news — not fundamental business metrics"/>
                {stock.expense_ratio != null && (
                  <FundRow label="Annual Cost (Expense Ratio)"
                    value={`${stock.expense_ratio.toFixed(2)}%/yr`}
                    hint="Annual fee drag. Under 0.20%/yr = low cost, over 0.50%/yr = high."
                    positive={stock.expense_ratio < 0.25}/>
                )}
                {stock.max_drawdown != null && (
                  <FundRow label="Max Drawdown (1Y)"
                    value={`${stock.max_drawdown.toFixed(1)}%`}
                    hint="Peak-to-trough decline over the last year"
                    positive={stock.max_drawdown > -20}/>
                )}
              </div>
            </div>
          )}

          {/* Moat — stocks only */}
          {!isETF && stock.moat_score != null && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">🏰 Competitive Moat</span>
                <span className="detail-section-score" style={{ color: moatCol(stock.moat_score) }}>
                  {stock.moat_score.toFixed(1)}/10
                </span>
              </div>
              <p style={{ fontSize: 11, color: '#6b6b65', margin: 0 }}>
                How durable and defensible is this business? Wide moat = pricing power + persistent profits.{' '}
                <span style={{ color: '#2563eb' }}>This score contributes 20% to the overall Quality Score.</span>
              </p>
              <div className="detail-rows">
                <FundRow label="Gross Margin"
                  value={stock.gross_margin_pct != null ? `${stock.gross_margin_pct.toFixed(1)}%` : null}
                  hint="Pricing power indicator. Over 40% = strong moat."
                  positive={stock.gross_margin_pct > 40}/>
                <FundRow label="Rev Growth (TTM)"
                  value={stock.revenue_growth_pct != null ? `${stock.revenue_growth_pct >= 0 ? '+' : ''}${stock.revenue_growth_pct.toFixed(1)}%` : null}
                  hint="Year-over-year revenue velocity"
                  positive={stock.revenue_growth_pct > 10}/>
                <FundRow label="Rev Growth (3Y CAGR)"
                  value={stock.revenue_growth_3y != null ? `${stock.revenue_growth_3y >= 0 ? '+' : ''}${stock.revenue_growth_3y.toFixed(1)}%` : null}
                  hint="3-year compounded growth — durability check. Over 10% sustained = strong moat."
                  positive={stock.revenue_growth_3y > 10}/>
              </div>
            </div>
          )}

          {/* Valuation — stocks only */}
          {!isETF && (fcfYieldPct != null || stock.ev_fcf != null) && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">💰 Valuation</span>
              </div>
              <div className="detail-rows">
                <FundRow label="Free Cash Flow Yield"
                  value={fcfYieldPct != null ? `${fcfYieldPct.toFixed(2)}%` : (stock.fcf_yield === 0 ? 'Pending data' : null)}
                  hint={fcfYieldPct != null
                    ? `FCF yield ${fcfYieldPct.toFixed(1)}% — ${fcfYieldPct > 5 ? 'cheap entry' : fcfYieldPct > 3 ? 'fair value' : fcfYieldPct > 1.5 ? 'expensive' : 'very expensive (>67x FCF)'}`
                    : 'FCF yield will update after next EOD run.'}
                  positive={fcfYieldPct != null && fcfYieldPct > 3}/>
                <FundRow label="EV/FCF"
                  value={stock.ev_fcf != null ? `${stock.ev_fcf.toFixed(1)}×` : null}
                  hint="Enterprise value vs free cash flow. Under 15× = cheap, 15-25× = fair, over 40× = expensive."
                  positive={stock.ev_fcf != null && stock.ev_fcf < 25}/>
              </div>
            </div>
          )}

          {/* Risk — stocks only */}
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
                      : stock.max_drawdown > -40 ? 'Significant drawdown — -0.5pt penalty on technical score.'
                      : 'Severe drawdown — -1.5pt penalty on technical score. Check if thesis intact.'
                    }`}
                    positive={stock.max_drawdown > -20}/>
                )}
                {sbcPct != null && (
                  <FundRow label="Dilution Rate (SBC)"
                    value={`${sbcPct.toFixed(2)}%/yr`}
                    hint="Stock-based compensation as % of market cap — hidden annual cost to shareholders. Under 2% = healthy."
                    positive={sbcPct < 2}/>
                )}
                {stock.sbc_millions != null && (
                  <FundRow label="Annual Dilution Cost" value={`$${stock.sbc_millions.toFixed(0)}M`}
                    hint="Annual stock grants to employees"/>
                )}
                {stock.earnings_quality_flag === 'risk' && (
                  <FundRow label="Earnings Quality" value="⚠ Profits outpace cash"
                    hint="Reported profits look good, but actual cash collected is lower. Early warning sign." positive={false}/>
                )}
                {stock.earnings_quality_flag === 'strong' && (
                  <FundRow label="Earnings Quality" value="✓ Strong cash conversion"
                    hint="The business collects more cash than its reported profits — a sign of quality." positive={true}/>
                )}
                {stock.debt_maturity_flag === 'wall' && (
                  <FundRow label="Debt Repayment Risk" value="⚠ Large debt due soon"
                    hint="Over 30% of debt needs refinancing within 12 months. Risk if rates are high." positive={false}/>
                )}
                {stock.dilution_flag === 'heavy' && (
                  <FundRow label="Share Dilution"
                    value={`⚠ Shares grew ${stock.shares_yoy_pct != null ? stock.shares_yoy_pct.toFixed(1) : '?'}% this year`}
                    hint="Shares outstanding growing faster than 5% per year." positive={false}/>
                )}
                {stock.dilution_flag === 'buyback' && (
                  <FundRow label="Share Count"
                    value={`✓ Buybacks: ${stock.shares_yoy_pct != null ? stock.shares_yoy_pct.toFixed(1) : '?'}% YoY`}
                    hint="Company reducing share count — good for long-term owners." positive={true}/>
                )}
                {stock.cyclical_peak_flag && (
                  <FundRow label="Cycle Warning" value="⚠ May be at earnings peak"
                    hint="Margins unusually high vs history — may be peak-cycle profitability. Quality score capped at 6.5." positive={false}/>
                )}
              </div>
            </div>
          )}

          {/* Filing tone */}
          {!isETF && filingScore != null && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">📄 Filing Tone</span>
                <span className="detail-section-score" style={{ color: filingColor }}>
                  {filingScore.toFixed(1)}/10
                </span>
              </div>
              <div className="detail-rows">
                <FundRow label={`${stock.filing_form ?? 'Filing'} Language`}
                  value={filingLabel}
                  hint="Language analysis of most recent SEC filing. Positive = confident tone."
                  positive={filingScore >= 6}/>
              </div>
            </div>
          )}

          {/* 8-K event */}
          {!isETF && stock.event_8k && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">📋 Recent 8-K</span>
              </div>
              <div className="detail-rows">
                <FundRow label="Event"
                  value={`${stock.event_8k_icon || ''} ${stock.event_8k}`}
                  hint="Material SEC filing within the last 60 days"
                  positive={stock.event_8k_hint === 'positive'}/>
                {stock.event_8k_date && <FundRow label="Filed" value={stock.event_8k_date}/>}
              </div>
            </div>
          )}

          {/* Score breakdown */}
          {(isETF ? stock.score_tech != null : stock.score_fund != null) && (
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
                  <span className="detail-section-score" style={{ color: scoreCol(stock.latest_score) }}>
                    {stock.latest_score != null ? stock.latest_score.toFixed(1) : '—'}/10
                  </span>
                </div>
              </div>
              <div className="detail-rows">
                {isETF ? (
                  <>
                    <FundRow label="Price Trend (65%)" value={stock.score_tech != null ? `${stock.score_tech.toFixed(1)}/10` : null}
                      hint="SMA-200 trend + RSI momentum — primary signal for ETFs" positive={stock.score_tech >= 6}/>
                    <FundRow label="News Sentiment (35%)" value={stock.score_news != null ? `${stock.score_news.toFixed(1)}/10` : null}
                      hint="Sector/theme news — macro events relevant to the fund" positive={stock.score_news >= 6}/>
                  </>
                ) : (
                  <>
                    <FundRow label="Business Quality (60%)" value={stock.score_fund != null ? `${stock.score_fund.toFixed(1)}/10` : null}
                      hint="ROIC quality · SBC-adjusted FCF (15% = perfect) · Debt level · Revenue growth · Competitive moat (20% blend) · FCF yield valuation adjuster"
                      positive={stock.score_fund >= 6}/>
                    {fcfYieldPct != null && (() => {
                      const fy = stock.fcf_yield;
                      const adj = fy > 0.06 ? +0.7 : fy > 0.04 ? +0.4 : fy > 0.025 ? +0.1 : fy > 0.015 ? 0 : fy > 0.008 ? -0.8 : -1.8;
                      const adjLabel = adj > 0 ? `+${adj.toFixed(1)} pts (cheap)` : adj < 0 ? `${adj.toFixed(1)} pts (expensive)` : '±0 (fair)';
                      return (
                        <FundRow label="  ↳ Valuation adj (in quality)"
                          value={adjLabel}
                          hint={`FCF yield of ${fcfYieldPct.toFixed(1)}% applied a ${adjLabel} valuation adjustment to Business Quality.`}/>
                      );
                    })()}
                    <FundRow label="Insider Activity (15%)" value={stock.score_insider != null ? `${stock.score_insider.toFixed(1)}/10` : null}
                      hint="CEO/CFO open-market buys (3x weight). Excludes grants, withholding, option exercises. Reduced from 25%: high-conviction but sparse signal."
                      positive={stock.score_insider >= 6}/>
                    <FundRow label="Analyst Consensus (10%)" value={stock.score_rating != null ? `${stock.score_rating.toFixed(1)}/10` : null}
                      hint="Buy/sell/hold consensus + upgrade/downgrade velocity" positive={stock.score_rating >= 6}/>
                    <FundRow label="Price Trend (8%)" value={stock.score_tech != null ? `${stock.score_tech.toFixed(1)}/10` : null}
                      hint="SMA-200 trend (60%) + RSI (40%). Oversold quality stocks score as high as healthy uptrends — buy-the-dip calibration."
                      positive={stock.score_tech >= 6}/>
                    <FundRow label="News Sentiment (7%)" value={stock.score_news != null ? `${stock.score_news.toFixed(1)}/10` : null}
                      hint="3x daily news runs weighted by recency. Low weight intentional: noise for a 3-7yr holder." positive={stock.score_news >= 6}/>
                  </>
                )}
              </div>
            </div>
          )}

        </div>
      </td>
    </tr>
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

// ── Main component ────────────────────────────────────────────────────────────
const EnhancedPortfolioDashboard = () => {
  const [portfolio,      setPortfolio]      = useState([]);
  const [stats,          setStats]          = useState(null);
  const [marketRegime,   setMarketRegime]   = useState({ regime: 'NORMAL', spy21d: 0 });
  const [loading,        setLoading]        = useState(true);
  const [lastUpdate,     setLastUpdate]     = useState(null);
  const [sortBy,         setSortBy]         = useState('score');
  const [filterSignal,   setFilterSignal]   = useState('ALL');
  const [showForm,       setShowForm]       = useState(false);
  const [formMode,       setFormMode]       = useState('add');
  const [formData,       setFormData]       = useState({
    symbol:'', name:'', quantity:'', average_price:'', type:'Stock', sector:''
  });
  const [editingId,      setEditingId]      = useState(null);
  const [newsModalStock, setNewsModalStock] = useState(null);
  const [expandedRow,    setExpandedRow]    = useState(null);

  const fetchPortfolio = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/portfolio');
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      if (data.status === 'success') {
        const sorted = [...data.portfolio].sort((a,b) => (b.latest_score||0)-(a.latest_score||0));
        setPortfolio(sorted);
        setStats(data.stats);
        setLastUpdate(new Date(data.timestamp));
        try {
          const mr = await fetch('/api/portfolio/market-regime');
          if (mr.ok) {
            const mrData = await mr.json();
            if (mrData?.regime) setMarketRegime(mrData);
          }
        } catch (e) { /* non-critical */ }
      }
    } catch (err) {
      console.error('Error fetching portfolio:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPortfolio();
    const interval = setInterval(fetchPortfolio, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchPortfolio]);

  const handleAddStock = async e => {
    e.preventDefault();
    if (!formData.symbol || !formData.quantity || !formData.average_price) return;
    try {
      const res = await fetch('/api/portfolio/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.ok) { setShowForm(false); fetchPortfolio(); }
    } catch (err) { console.error(err); }
  };

  const handleEditStock = async e => {
    e.preventDefault();
    try {
      const res = await fetch(`/api/portfolio/edit/${editingId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.ok) { setShowForm(false); setEditingId(null); fetchPortfolio(); }
    } catch (err) { console.error(err); }
  };

  const handleDeleteStock = async id => {
    if (!window.confirm('Remove this asset from the portfolio?')) return;
    try {
      const res = await fetch(`/api/portfolio/delete/${id}`, { method: 'DELETE' });
      if (res.ok) fetchPortfolio();
    } catch (err) { console.error(err); }
  };

  const openEditForm = stock => {
    setFormMode('edit'); setEditingId(stock.id);
    setFormData({
      symbol: stock.symbol, name: stock.name || '',
      quantity: stock.quantity.toString(), average_price: stock.average_price.toString(),
      type: stock.type || 'Stock', sector: stock.sector || '',
    });
    setShowForm(true);
  };

  const openAddForm = () => {
    setFormMode('add'); setEditingId(null);
    setFormData({ symbol:'', name:'', quantity:'', average_price:'', type:'Stock', sector:'' });
    setShowForm(true);
  };

  const toggleRow = symbol => setExpandedRow(prev => prev === symbol ? null : symbol);

  const getFilteredPortfolio = () => {
    let filtered = [...portfolio];
    if (filterSignal === 'BULLISH')
      filtered = filtered.filter(s => ['ADD','SPRING_CONFIRMED','SPRING_CANDIDATE','STRONG_BUY','BUY'].includes(s.signal));
    else if (filterSignal === 'NOISE')
      filtered = filtered.filter(s => ['HOLD_NOISE','MARKET_NOISE','HOLD','NORMAL'].includes(s.signal) || s.regime === 'MARKET_NOISE');
    else if (filterSignal === 'BEARISH')
      filtered = filtered.filter(s => ['WATCH','TRIM_25','REDUCE','SELL','IDIOSYNCRATIC_DECAY'].includes(s.signal));

    return filtered.sort((a, b) => {
      if (sortBy === 'moat')   return (b.moat_score||0) - (a.moat_score||0);
      if (sortBy === 'alpha')  return (b.excess_return||0) - (a.excess_return||0);
      if (sortBy === 'symbol') return a.symbol.localeCompare(b.symbol);
      if (sortBy === 'pnl') {
        const pA = ((a.current_price||0)-(a.average_price||0))*(a.quantity||0);
        const pB = ((b.current_price||0)-(b.average_price||0))*(b.quantity||0);
        return pB - pA;
      }
      return (b.latest_score||0) - (a.latest_score||0);
    });
  };

  const filteredPortfolio = getFilteredPortfolio();
  const totalVal  = portfolio.reduce((s,x) => s + ((x.current_price||0)*(x.quantity||0)), 0);
  const totalCost = portfolio.reduce((s,x) => s + ((x.average_price||0)*(x.quantity||0)), 0);
  const totalPnL  = totalVal - totalCost;
  const totalPnLPct = totalCost > 0 ? (totalPnL/totalCost)*100 : 0;
  const totalDayChange = portfolio.reduce((s,x) => {
    if (!x.current_price || x.change_percent == null || !x.quantity) return s;
    const prev = x.current_price / (1 + x.change_percent/100);
    return s + (x.current_price - prev) * x.quantity;
  }, 0);
  const totalDayPct = totalVal > 0
    ? portfolio.reduce((s,x) => {
        if (!x.current_price || x.change_percent == null || !x.quantity) return s;
        return s + x.change_percent * ((x.current_price*x.quantity)/totalVal);
      }, 0) : 0;
  const avgScore  = portfolio.length
    ? (portfolio.reduce((s,x) => s+(x.latest_score||0), 0)/portfolio.length).toFixed(1) : '—';
  const bullCount = portfolio.filter(s => ['ADD','SPRING_CONFIRMED','SPRING_CANDIDATE','STRONG_BUY','BUY'].includes(s.signal)).length;
  const bearCount = portfolio.filter(s => ['WATCH','TRIM_25','REDUCE','SELL','IDIOSYNCRATIC_DECAY'].includes(s.signal)).length;

  if (loading && portfolio.length === 0) {
    return (
      <div className="dashboard-container">
        <NeuralBackground/>
        <div className="loading-wrap"><div className="loading-ring"/></div>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <NeuralBackground/>

      <div className="dashboard-header">
        <div>
          <h1>Alpha Compounder</h1>
          <div style={{display:'flex', alignItems:'center', gap:10, flexWrap:'wrap'}}>
            <p className="subtitle" style={{margin:0}}>Regime-Aware · Long-Horizon · Fundamentals-First</p>
            {marketRegime?.regime && marketRegime.regime !== 'NORMAL' && (
              <span style={{
                padding:'2px 8px', borderRadius:4, fontSize:10, fontWeight:700,
                fontFamily:'DM Mono,monospace',
                background: marketRegime.regime === 'BEAR' ? '#fef2f2' : '#fff7ed',
                color:      marketRegime.regime === 'BEAR' ? '#dc2626'  : '#c2410c',
                border:    `1px solid ${marketRegime.regime === 'BEAR' ? '#fca5a5' : '#fdba74'}`,
              }}>
                {marketRegime.regime === 'BEAR' ? '🐻 BEAR MARKET' : '⚠ STRESSED'}
                {' · SPY '}{marketRegime.spy21d >= 0 ? '+' : ''}{(marketRegime.spy21d||0).toFixed(1)}%
              </span>
            )}
          </div>
        </div>
        <div className="header-actions">
          {lastUpdate && (
            <div className="last-update">
              <span className="live-dot"/>
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
            <div className="stat-value stat-value-sm">{fmtUSD(stats?.totalValue ?? totalVal, true)}</div>
          </div>
          <div className={`stat-card ${totalDayChange >= 0 ? 'profit-card' : 'loss-card'}`}>
            <div className="stat-label">Today's Change</div>
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
            <div className="stat-value" style={{ color: scoreCol(parseFloat(stats?.averageScore ?? avgScore)) }}>
              {stats?.averageScore ?? avgScore}<span className="stat-unit">/10</span>
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
          {[{v:'ALL',l:'All'},{v:'BULLISH',l:'▲ Buy Signals'},{v:'NOISE',l:'— Noise'},{v:'BEARISH',l:'▼ Risk Alerts'}]
            .map(({v,l}) => (
              <button key={v}
                className={`pill ${filterSignal===v?'pill-active':''}`}
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
            <button className="btn-secondary" style={{padding:'6px 14px'}}
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
                  const tv   = (parseFloat(stock.current_price)||0)*(parseFloat(stock.quantity)||0);
                  const pd   = ((stock.current_price||0)-(stock.average_price||0))*(stock.quantity||0);
                  const pp   = stock.average_price > 0
                    ? ((stock.current_price-stock.average_price)/stock.average_price)*100 : null;
                  const sCfg = sig(stock.signal);
                  const rCfg = reg(stock.regime);
                  const isExpanded = expandedRow === stock.symbol;
                  // Only show regime when it differs from signal and adds context
                  const showRegime = stock.regime !== stock.signal && stock.regime !== 'NORMAL' && stock.regime != null;

                  return (
                    <>
                      <tr key={stock.id} className={`row-${sCfg.tier}${isExpanded ? ' row-expanded' : ''}`}>
                        <td>
                          <div className="symbol-row">
                            <strong className="stock-symbol">{stock.symbol}</strong>
                            {stock.instrument_type === 'ETF' && (
                              <span className="etf-badge" title="ETF — scored on momentum and news">ETF</span>
                            )}
                          </div>
                          {stock.name   && <div className="stock-name">{stock.name}</div>}
                          {stock.sector && <span className="sector-pill">{stock.sector}</span>}
                        </td>

                        <td>
                          <div className="price-value">{fmtUSD(stock.current_price)}</div>
                          {stock.change_percent != null && (
                            <div className={`change ${stock.change_percent>=0?'positive':'negative'}`}>
                              {stock.change_percent>=0?'+':''}{stock.change_percent.toFixed(2)}% today
                            </div>
                          )}
                          {stock.average_price > 0 && stock.current_price > 0 && (
                            <div className={`change ${pd>=0?'positive':'negative'}`} style={{fontWeight:600,marginTop:4}}>
                              {pd>=0?'▲':'▼'} {fmtUSD(Math.abs(pd))}
                              {pp != null && <span style={{opacity:.75}}> ({fmtPct(pp)})</span>}
                            </div>
                          )}
                        </td>

                        <td>
                          <div className="quality-moat-cell">
                            <ScoreRing score={stock.latest_score}/>
                            {stock.moat_score != null && <MoatRing score={stock.moat_score}/>}
                            {stock.capex_exception && (
                              <span className="capex-flag" title="Strategic capex: FCF penalty forgiven">🏗️</span>
                            )}
                          </div>
                          {/* FCF yield: only show when genuinely available (> 0) */}
                          {stock.fcf_yield != null && stock.fcf_yield > 0 && (
                            <div className="compact-metric"
                              title={`FCF yield ${(stock.fcf_yield*100).toFixed(1)}% — ${stock.fcf_yield > 0.05 ? 'cheap entry' : stock.fcf_yield > 0.03 ? 'fair value' : 'expensive'}`}>
                              <span className="compact-lbl">FCF yld</span>
                              <span className={`compact-val ${stock.fcf_yield*100 > 3 ? 'pos' : stock.fcf_yield*100 < 1.5 ? 'neg' : ''}`}>
                                {(stock.fcf_yield*100).toFixed(1)}%
                              </span>
                            </div>
                          )}
                        </td>

                        <td>
                          {showRegime ? (
                            <div className="regime-name" style={{color:rCfg.color}} title={rCfg.label}>{rCfg.label}</div>
                          ) : (
                            <div className="regime-name" style={{color:'#9ca3af',fontWeight:400}}>Normal</div>
                          )}
                          {stock.excess_return != null && (
                            <div className={`alpha-val change ${stock.excess_return>=0?'positive':'negative'}`}>
                              α {fmtPct(stock.excess_return)}
                            </div>
                          )}
                          {stock.beta != null && <div className="beta-val">β {Number(stock.beta).toFixed(2)}</div>}
                          {stock.max_drawdown != null && (
                            <div className="compact-metric" title="Max drawdown — largest drop in past year">
                              <span className="compact-lbl">MaxDD</span>
                              <span className={`compact-val ${stock.max_drawdown > -15 ? '' : 'neg'}`}>
                                {stock.max_drawdown.toFixed(1)}%
                              </span>
                            </div>
                          )}
                        </td>

                        <td>
                          <span className={`signal-badge ${
                            sCfg.tier === 'bull' ? 'signal-bull' :
                            sCfg.tier === 'bear' && ['WATCH','TRIM_25'].includes(stock.signal) ? 'signal-bear-soft' :
                            sCfg.tier === 'bear' ? 'signal-bear-hard' : 'signal-neutral'
                          }`}>{sCfg.label}</span>
                          {stock.sharp_score_drop && (
                            <div title={`Score dropped ${Math.abs(stock.score_delta_1d||0).toFixed(1)} pts vs yesterday`}
                              style={{ display:'inline-block', marginLeft:4, padding:'1px 5px', fontSize:9, fontWeight:700,
                                background:'#fef2f2', color:'#dc2626', border:'1px solid #fca5a5', borderRadius:3, verticalAlign:'middle' }}>
                              ⚡ −{Math.abs(stock.score_delta_1d||0).toFixed(1)}
                            </div>
                          )}
                          <SpringBar days={stock.spring_days}/>
                          <CascadePips w1={stock.w1_signal} w2={stock.w2_confirmed} w3={stock.w3_confirmed} w4={stock.w4_confirmed}/>
                        </td>

                        <td>
                          <div className="price-value">{fmtUSD(tv)}</div>
                          {totalVal > 0 && (() => {
                            const wPct = (tv/totalVal)*100;
                            const sigStr = stock.signal || '';
                            const fnd = stock.score_fund ?? 5;
                            const isHighConviction = fnd >= 8.0 && ['ADD','SPRING_CONFIRMED','SPRING_CANDIDATE','STRONG_BUY'].includes(sigStr);
                            const isWeak = fnd < 6.5 || ['WATCH','REDUCE','TRIM_25','SELL','IDIOSYNCRATIC_DECAY'].includes(sigStr);
                            const isSpring = ['SPRING_CONFIRMED','SPRING_CANDIDATE'].includes(sigStr);
                            const mr = marketRegime?.regime || 'NORMAL';
                            const rawThreshold = isHighConviction ? 25 : isWeak ? 8 : 15;
                            const threshold = isSpring ? rawThreshold
                              : mr === 'BEAR' ? Math.min(rawThreshold, 15)
                              : mr === 'STRESSED' ? Math.min(rawThreshold, 20)
                              : rawThreshold;
                            const overweight = wPct > threshold;
                            const wColor = overweight ? '#dc2626' : wPct > threshold * 0.8 ? '#d97706' : '#6b6b65';
                            return (
                              <div title={`${wPct.toFixed(1)}% of portfolio (limit: ${threshold}%)`}
                                style={{ fontFamily:'var(--font-mono)', fontSize:11, color:wColor, marginTop:3, fontWeight: overweight ? 700 : 400 }}>
                                {wPct.toFixed(1)}% weight{overweight && ' ⚠'}
                              </div>
                            );
                          })()}
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
                      {isExpanded && <DetailPanel key={`detail-${stock.id}`} stock={stock}/>}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CorrelationHeatmap/>

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
                  onChange={e => setFormData({...formData, symbol: e.target.value.toUpperCase()})}
                  disabled={formMode === 'edit'}/>
              </div>
              <div className="form-group">
                <label>Company Name</label>
                <input type="text" placeholder="Optional" value={formData.name}
                  onChange={e => setFormData({...formData, name: e.target.value})}/>
              </div>
              <div className="form-group">
                <label>Quantity</label>
                <input type="number" step="0.01" value={formData.quantity}
                  onChange={e => setFormData({...formData, quantity: e.target.value})}/>
              </div>
              <div className="form-group">
                <label>Avg Cost (per share)</label>
                <input type="number" step="0.01" value={formData.average_price}
                  onChange={e => setFormData({...formData, average_price: e.target.value})}/>
              </div>
              <div className="form-group">
                <label>Sector <span style={{fontSize:10,color:'#9ca3af',fontWeight:400}}>(auto-filled after first run)</span></label>
                <input type="text" placeholder="e.g. Technology" value={formData.sector}
                  onChange={e => setFormData({...formData, sector: e.target.value})}/>
              </div>
              <div className="form-group">
                <label>Type</label>
                <select value={formData.type} onChange={e => setFormData({...formData, type: e.target.value})}>
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
                {newsModalStock.excess_return != null && ` · α ${fmtPct(newsModalStock.excess_return)}`}
              </p>
            </div>
            <button className="btn-close" onClick={() => setNewsModalStock(null)}>✕</button>
          </div>
          <div className="modal-body">
            {newsModalStock.recent_news?.length > 0 ? (
              newsModalStock.recent_news.map((n, i) => (
                <a href={n.url} target="_blank" rel="noopener noreferrer" key={i} className="news-card">
                  <span className="news-date">
                    {new Date(n.published_at).toLocaleDateString('en-US',{month:'short',day:'numeric'})}
                  </span>
                  <h3 className="news-headline">{n.headline}</h3>
                  {n.description && <p className="news-desc">{n.description.substring(0,180)}…</p>}
                </a>
              ))
            ) : (
              <p className="no-news">No actionable intelligence found for this cycle.</p>
            )}
          </div>
        </Modal>
      )}

      <p style={{ textAlign:'center', fontSize:11, color:'#9ca3af', marginTop:24, lineHeight:1.6 }}>
        Alpha Compounder · For informational purposes only. Not financial advice.
        All signals are systematic — always apply your own judgement.{' '}
        <strong style={{color:'#d97706'}}>Indian investors: weigh CGT (20% LTCG / 30% STCG) before acting on any sell signal.</strong>
      </p>
    </div>
  );
};

export default EnhancedPortfolioDashboard;
