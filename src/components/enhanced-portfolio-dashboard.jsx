import React, { useState, useEffect, useRef, useCallback } from 'react';
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
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y);
          ctx.strokeStyle = col==='#059669' ? `rgba(5,150,105,${ea})` : col==='#dc2626' ? `rgba(220,38,38,${ea})` : `rgba(160,160,154,${ea})`;
          ctx.lineWidth=1; ctx.stroke();
        }
      }
      for (const n of nodes) {
        const pulse = 0.82 + 0.18*Math.sin(now*n.pulseSpeed*60+n.pulseOffset);
        ctx.beginPath(); ctx.arc(n.x,n.y,n.r*pulse,0,Math.PI*2);
        ctx.fillStyle = n.color==='#059669'?`rgba(5,150,105,${n.alpha*pulse})`:n.color==='#dc2626'?`rgba(220,38,38,${n.alpha*pulse})`:`rgba(160,160,154,${n.alpha*pulse})`;
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
    <div className="score-ring" title={`Quality Score: ${score?.toFixed(1) ?? '—'}/10`}>
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

// Moat ring — smaller, displayed alongside score ring
const MoatRing = ({ score }) => {
  if (score == null) return null;
  const r = 11, circ = 2 * Math.PI * r;
  const col = moatCol(score);
  return (
    <div className="moat-ring" title={`Moat Score: ${score.toFixed(1)}/10 — ROIC premium, gross margin, revenue durability, FCF conversion`}>
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

const CascadePips = ({ w1, w2, w3, w4 }) => {
  if (!w1 && !w2 && !w3 && !w4) return null;
  return (
    <div className="cascade-pips" title="W1=7d  W2=21d  W3=63d  W4=252d">
      {[{k:'W1',on:w1,col:'#d97706'},{k:'W2',on:w2,col:'#ea580c'},{k:'W3',on:w3,col:'#dc2626'},{k:'W4',on:w4,col:'#7f1d1d'}]
        .map(p => (
          <span key={p.k} className={`pip ${p.on ? 'pip-on' : 'pip-off'}`}
            style={p.on ? { background: p.col, borderColor: p.col } : {}}>
            {p.k}
          </span>
        ))}
    </div>
  );
};

const SpringBar = ({ days }) => {
  if (!days || days <= 0) return null;
  const col = days >= 3 ? '#047857' : '#10b981';
  return (
    <div className="spring-bar">
      <div className="spring-track">
        <div className="spring-fill" style={{ width: `${Math.min(days,3)/3*100}%`, background: col }}/>
      </div>
      <span className="spring-label" style={{ color: col }}>
        {days >= 3 ? '🌱 Confirmed' : `🌱 Day ${days}/3`}
      </span>
    </div>
  );
};

// ── Fundamental detail row — shown inside the Detail Panel ───────────────────
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

// ── Filing Narrative Card — shown in detail panel after new 10-K/10-Q ─────────
const FilingNarrativeCard = ({ narrative }) => {
  if (!narrative?.gemini) return null;
  const g = narrative.gemini;

  const statusColor = g.thesis_status === 'strengthening' ? '#059669'
                    : g.thesis_status === 'stable'        ? '#2563eb'
                    : g.thesis_status === 'weakening'     ? '#dc2626'
                    : '#9ca3af';

  const statusLabel = g.thesis_status === 'strengthening' ? '▲ Thesis Strengthening'
                    : g.thesis_status === 'stable'        ? '→ Thesis Stable'
                    : g.thesis_status === 'weakening'     ? '▼ Thesis Weakening'
                    : '? Unclear';

  return (
    <div className="detail-section filing-narrative-card">
      <div className="detail-section-head">
        <span className="detail-section-title">📑 {narrative.form} Narrative · {narrative.period ?? narrative.filed}</span>
        <span style={{
          fontSize:10, fontFamily:'DM Mono,monospace', fontWeight:700,
          padding:'2px 7px', borderRadius:4,
          background: statusColor + '18', color: statusColor,
          border: `1px solid ${statusColor}40`,
        }}>{statusLabel}</span>
      </div>

      <p style={{ fontSize:12, color:'#3a3835', lineHeight:1.55, margin:0 }}>{g.summary}</p>

      {/* Key changes */}
      {g.key_changes?.length > 0 && (
        <div>
          <span style={{ fontSize:10, color:'#6b6b65', textTransform:'uppercase', letterSpacing:'0.06em', fontWeight:600 }}>Key Changes</span>
          <div style={{ marginTop:4, display:'flex', flexDirection:'column', gap:3 }}>
            {g.key_changes.map((c,i) => (
              <span key={i} style={{ fontSize:11, color:'#3a3835', fontFamily:'DM Mono,monospace' }}>→ {c}</span>
            ))}
          </div>
        </div>
      )}

      {/* Thesis confirms */}
      {g.thesis_confirms?.length > 0 && (
        <div style={{ background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:5, padding:'7px 10px', display:'flex', flexDirection:'column', gap:3 }}>
          {g.thesis_confirms.map((c,i) => (
            <span key={i} style={{ fontSize:11, color:'#166534', fontFamily:'DM Mono,monospace' }}>✓ {c}</span>
          ))}
        </div>
      )}

      {/* Thesis risks + new risks */}
      {(g.thesis_risks?.length > 0 || g.new_risks?.length > 0) && (
        <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:5, padding:'7px 10px', display:'flex', flexDirection:'column', gap:3 }}>
          {g.thesis_risks?.map((r,i) => (
            <span key={`r${i}`} style={{ fontSize:11, color:'#991b1b', fontFamily:'DM Mono,monospace' }}>⚠ {r}</span>
          ))}
          {g.new_risks?.map((r,i) => (
            <span key={`n${i}`} style={{ fontSize:11, color:'#7f1d1d', fontFamily:'DM Mono,monospace', fontWeight:600 }}>🆕 {r}</span>
          ))}
        </div>
      )}

      {/* Guidance changes */}
      {g.guidance_changes?.length > 0 && (
        <div style={{ background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:5, padding:'7px 10px', display:'flex', flexDirection:'column', gap:3 }}>
          {g.guidance_changes.map((c,i) => (
            <span key={i} style={{ fontSize:11, color:'#1e40af', fontFamily:'DM Mono,monospace' }}>📋 {c}</span>
          ))}
        </div>
      )}

      <span style={{ fontSize:10, color:'#a0a09a', fontFamily:'DM Mono,monospace' }}>
        {narrative.form} · Filed {new Date(narrative.filed).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
      </span>
    </div>
  );
};

// ── Earnings Event Card — shown in detail panel for 90 days after earnings ────
const EarningsCard = ({ event }) => {
  if (!event?.gemini) return null;
  const g = event.gemini;

  const guidanceColor = g.guidance_direction === 'raised'   ? '#059669'
                      : g.guidance_direction === 'lowered'  ? '#dc2626'
                      : '#6b7280';

  const guidanceLabel = g.guidance_direction === 'raised'   ? '▲ Guidance Raised'
                      : g.guidance_direction === 'lowered'  ? '▼ Guidance Lowered'
                      : g.guidance_direction === 'maintained' ? '→ Guidance Maintained'
                      : 'No Guidance';

  const toneBar = (score, max = 5) => {
    const pct = ((score - 1) / (max - 1)) * 100;
    const col = score >= 4 ? '#059669' : score >= 3 ? '#d97706' : '#dc2626';
    return (
      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
        <div style={{ flex:1, height:4, background:'#e6e5df', borderRadius:2, overflow:'hidden' }}>
          <div style={{ width:`${pct}%`, height:'100%', background:col, borderRadius:2 }}/>
        </div>
        <span style={{ fontSize:10, fontFamily:'DM Mono,monospace', color:col, minWidth:12 }}>{score}/5</span>
      </div>
    );
  };

  return (
    <div className="detail-section earnings-card">
      <div className="detail-section-head">
        <span className="detail-section-title">📞 Earnings · Q{event.quarter} {event.year}</span>
        <span style={{
          fontSize:10, fontFamily:'DM Mono,monospace', fontWeight:700,
          padding:'2px 7px', borderRadius:4,
          background: guidanceColor + '18', color: guidanceColor,
          border: `1px solid ${guidanceColor}40`,
        }}>{guidanceLabel}</span>
      </div>

      {/* EPS and Revenue beat chips */}
      <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
        {g.eps_beat != null && (
          <span style={{
            fontSize:11, padding:'3px 8px', borderRadius:4,
            background: g.eps_beat ? '#05966918' : '#dc262618',
            color: g.eps_beat ? '#059669' : '#dc2626',
            border: `1px solid ${g.eps_beat ? '#05966940' : '#dc262640'}`,
            fontWeight:600,
          }}>
            {g.eps_beat ? '✓ EPS Beat' : '✗ EPS Miss'}
          </span>
        )}
        {g.revenue_beat != null && (
          <span style={{
            fontSize:11, padding:'3px 8px', borderRadius:4,
            background: g.revenue_beat ? '#05966918' : '#dc262618',
            color: g.revenue_beat ? '#059669' : '#dc2626',
            border: `1px solid ${g.revenue_beat ? '#05966940' : '#dc262640'}`,
            fontWeight:600,
          }}>
            {g.revenue_beat ? '✓ Rev Beat' : '✗ Rev Miss'}
          </span>
        )}
      </div>

      {/* Summary */}
      <p style={{ fontSize:12, color:'#3a3835', lineHeight:1.55, margin:0 }}>{g.summary}</p>

      {/* Confidence bar */}
      {g.management_confidence != null && (
        <div className="detail-rows" style={{ gap:6 }}>
          <div className="fund-row">
            <span className="fund-lbl">Mgmt Confidence</span>
            <div style={{ flex:1 }}>{toneBar(g.management_confidence)}</div>
          </div>
        </div>
      )}

      {/* Thesis confirms */}
      {g.thesis_confirms?.length > 0 && (
        <div style={{
          background:'#f0fdf4', border:'1px solid #bbf7d0',
          borderRadius:5, padding:'7px 10px', display:'flex', flexDirection:'column', gap:3,
        }}>
          {g.thesis_confirms.map((c,i) => (
            <span key={i} style={{ fontSize:11, color:'#166534', fontFamily:'DM Mono,monospace' }}>✓ {c}</span>
          ))}
        </div>
      )}

      {/* Thesis risks */}
      {g.thesis_risks?.length > 0 && (
        <div style={{
          background:'#fef2f2', border:'1px solid #fecaca',
          borderRadius:5, padding:'7px 10px', display:'flex', flexDirection:'column', gap:3,
        }}>
          {g.thesis_risks.map((r,i) => (
            <span key={i} style={{ fontSize:11, color:'#991b1b', fontFamily:'DM Mono,monospace' }}>⚠ {r}</span>
          ))}
        </div>
      )}

      <span style={{ fontSize:10, color:'#a0a09a', fontFamily:'DM Mono,monospace' }}>
        Filed {new Date(event.processedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})} · Visible 90 days
      </span>
    </div>
  );
};

// ── Detail Panel — slides out below a row when expanded ──────────────────────
// Shows all the new metrics that don't fit in the main table:
// Moat breakdown, FCF Yield, EV/FCF, MaxDD, Rev Growth 3Y, Gross Margin, SBC, Filing Sentiment
const DetailPanel = ({ stock }) => {
  const [earningsEvent,    setEarningsEvent]    = useState(null);
  const [filingNarrative,  setFilingNarrative]  = useState(null);

  // Fetch earnings event (90-day TTL)
  useEffect(() => {
    fetch(`/api/portfolio/earnings-event/${stock.symbol}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.event) setEarningsEvent(d.event); })
      .catch(() => {});
  }, [stock.symbol]);

  // Fetch 10-K/10-Q filing narrative (no TTL — most recent filing)
  useEffect(() => {
    fetch(`/api/portfolio/filing-narrative/${stock.symbol}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.narrative) setFilingNarrative(d.narrative); })
      .catch(() => {});
  }, [stock.symbol]);

  const fcfYieldPct = stock.fcf_yield != null ? (stock.fcf_yield * 100) : null;
  const sbcPct      = stock.sbc_to_market_cap;
  const filingScore = stock.filing_sentiment;

  // Filing sentiment label
  const filingLabel = filingScore == null ? null
    : filingScore >= 7 ? 'Positive tone'
    : filingScore >= 5 ? 'Neutral tone'
    : filingScore >= 3 ? 'Cautious tone'
    : 'Negative tone';

  const filingColor = filingScore == null ? '#9ca3af'
    : filingScore >= 7 ? '#059669'
    : filingScore >= 5 ? '#6b7280'
    : filingScore >= 3 ? '#d97706'
    : '#dc2626';

  const isETFInstrument = stock.instrument_type === 'ETF';
  const hasData = isETFInstrument
    ? (stock.max_drawdown != null || stock.expense_ratio != null || stock.score_tech != null)
    : (stock.moat_score != null || fcfYieldPct != null || stock.ev_fcf != null
       || stock.max_drawdown != null || stock.revenue_growth_3y != null
       || stock.gross_margin_pct != null || sbcPct != null || filingScore != null
       || stock.event_8k != null || stock.score_fund != null);

  if (!hasData) {
    return (
      <tr className="detail-panel-row">
        <td colSpan={7}>
          <div className="detail-panel">
            <span className="detail-empty">Fundamental detail data will appear after the next EOD run.</span>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="detail-panel-row">
      <td colSpan={7}>
        <div className="detail-panel">

          {/* ETF-specific panel — shown instead of stock fundamentals */}
          {isETFInstrument && (
            <div className="detail-section etf-info-section">
              <div className="detail-section-head">
                <span className="detail-section-title">📊 ETF Overview</span>
              </div>
              <div className="detail-rows">
                <FundRow label="Instrument" value="Exchange-Traded Fund"
                  hint="ETF scores are based on price momentum, trend strength, and news — not fundamental business metrics"/>
                {stock.expense_ratio != null && (
                  <FundRow label="Expense Ratio"
                    value={`${stock.expense_ratio.toFixed(2)}%/yr`}
                    hint="Annual cost drag on returns. <0.20% = low cost, >0.50% = high cost."
                    positive={stock.expense_ratio < 0.25}/>
                )}
                {stock.max_drawdown != null && (
                  <FundRow label="Max Drawdown (1Y)"
                    value={`${stock.max_drawdown.toFixed(1)}%`}
                    hint="Peak-to-trough decline over the last 252 trading days"
                    positive={stock.max_drawdown > -20}/>
                )}
                <FundRow label="Scoring Method"
                  value="Tech (50%) + News (30%) + Analyst (20%)"
                  hint="ETFs use a simplified composite: no fundamentals, no insiders, no filings"/>
              </div>
            </div>
          )}

          {/* Moat section — stocks only */}
          {!isETFInstrument && stock.moat_score != null && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">🏰 Moat</span>
                <span className="detail-section-score" style={{ color: moatCol(stock.moat_score) }}>
                  {stock.moat_score.toFixed(1)}/10
                </span>
              </div>
              <div className="detail-rows">
                <FundRow label="Gross Margin"
                  value={stock.gross_margin_pct != null ? `${stock.gross_margin_pct.toFixed(1)}%` : null}
                  hint="Pricing power — higher = stronger moat"
                  positive={stock.gross_margin_pct > 40}/>
                <FundRow label="Rev Growth (TTM YoY)"
                  value={stock.revenue_growth_pct != null ? `${stock.revenue_growth_pct >= 0 ? '+' : ''}${stock.revenue_growth_pct.toFixed(1)}%` : null}
                  hint="Trailing 12-month revenue growth vs same period prior year — velocity check"
                  positive={stock.revenue_growth_pct > 10}/>
                <FundRow label="Rev Growth (3Y CAGR)"
                  value={stock.revenue_growth_3y != null ? `${stock.revenue_growth_3y >= 0 ? '+' : ''}${stock.revenue_growth_3y.toFixed(1)}%` : null}
                  hint="3-year compounded annual growth — durability check"
                  positive={stock.revenue_growth_3y > 10}/>
              </div>
            </div>
          )}

          {/* Valuation section — stocks only */}
          {!isETFInstrument && (fcfYieldPct != null || stock.ev_fcf != null) && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">💰 Valuation</span>
              </div>
              <div className="detail-rows">
                <FundRow label="FCF Yield"
                  value={fcfYieldPct != null ? `${fcfYieldPct.toFixed(2)}%` : null}
                  hint=">5% = attractive, <2% = expensive relative to cash generation"
                  positive={fcfYieldPct > 3}/>
                <FundRow label="EV/FCF"
                  value={stock.ev_fcf != null ? `${stock.ev_fcf.toFixed(1)}×` : null}
                  hint="<15 = cheap, 15-25 = fair, >40 = expensive for a compounder"
                  positive={stock.ev_fcf != null && stock.ev_fcf < 25}/>
              </div>
            </div>
          )}

          {/* Risk section — stocks only (MaxDD shown in ETF panel above) */}
          {!isETFInstrument && (stock.max_drawdown != null || sbcPct != null || stock.earnings_quality_flag || stock.debt_maturity_flag) && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">⚠️ Risk</span>
              </div>
              <div className="detail-rows">
                <FundRow label="Max Drawdown (1Y)"
                  value={stock.max_drawdown != null ? `${stock.max_drawdown.toFixed(1)}%` : null}
                  hint="Peak-to-trough decline over the last 252 trading days"
                  positive={stock.max_drawdown != null && stock.max_drawdown > -20}/>
                <FundRow label="SBC / Mkt Cap"
                  value={sbcPct != null ? `${sbcPct.toFixed(2)}%` : null}
                  hint="Stock-based compensation as % of market cap — dilution rate. >3% is high."
                  positive={sbcPct != null && sbcPct < 2}/>
                {stock.sbc_millions != null && (
                  <FundRow label="SBC (annual)"
                    value={`$${stock.sbc_millions.toFixed(0)}M`}
                    hint="Annual stock-based compensation from most recent 10-K"/>
                )}
                {stock.earnings_quality_flag === 'risk' && (
                  <FundRow label="Earnings Quality"
                    value="⚠ Cash/Profit Divergence"
                    hint="GAAP net income is positive but operating cash flow is negative — accrual earnings quality risk"
                    positive={false}/>
                )}
                {stock.earnings_quality_flag === 'strong' && (
                  <FundRow label="Earnings Quality"
                    value="✓ Strong Cash Conversion"
                    hint="Operating cash flow exceeds GAAP net income by >50% — high earnings quality"
                    positive={true}/>
                )}
                {stock.debt_maturity_flag === 'wall' && (
                  <FundRow label="Debt Maturity"
                    value="⚠ Near-term Wall"
                    hint=">30% of long-term debt matures within 12 months — refinancing risk in high-rate environment"
                    positive={false}/>
                )}
                {stock.debt_maturity_flag === 'watch' && (
                  <FundRow label="Debt Maturity"
                    value="~ Watch"
                    hint="15-30% of long-term debt matures within 12 months — monitor for refinancing conditions"
                    positive={null}/>
                )}
                {stock.dilution_flag === 'heavy' && (
                  <FundRow label="Share Dilution"
                    value={`⚠ +${stock.shares_yoy_pct?.toFixed(1)}% YoY`}
                    hint="Shares outstanding grew >5% YoY — economic dilution beyond SBC (possible secondary offering or M&A)"
                    positive={false}/>
                )}
                {stock.dilution_flag === 'watch' && (
                  <FundRow label="Share Dilution"
                    value={`~ +${stock.shares_yoy_pct?.toFixed(1)}% YoY`}
                    hint="Shares outstanding grew 3-5% YoY — monitor for secondary offerings or excessive equity grants"
                    positive={null}/>
                )}
                {stock.dilution_flag === 'buyback' && (
                  <FundRow label="Share Count"
                    value={`✓ ${stock.shares_yoy_pct?.toFixed(1)}% YoY`}
                    hint="Shares outstanding declining — net buyback program returning capital to owners"
                    positive={true}/>
                )}
                {stock.cyclical_peak_flag && (
                  <FundRow label="Cycle Position"
                    value="⚠ Cyclical Peak Signal"
                    hint="Current gross margin is >50% above 5-year average — likely at earnings cycle peak. Fundamental score capped at 6.5."
                    positive={false}/>
                )}
              </div>
            </div>
          )}

          {/* Filing sentiment section — stocks only */}
          {!isETFInstrument && filingScore != null && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">📄 Filing Tone</span>
                <span className="detail-section-score" style={{ color: filingColor }}>
                  {filingScore.toFixed(1)}/10
                </span>
              </div>
              <div className="detail-rows">
                <FundRow label="10-K/10-Q Tone"
                  value={filingLabel}
                  hint="Loughran-McDonald positive/negative word ratio in most recent SEC filing"
                  positive={filingScore >= 6}/>
                {stock.filing_form && (
                  <FundRow label="Filing Type" value={stock.filing_form}/>
                )}
              </div>
            </div>
          )}

          {/* 8-K material event section — stocks only */}
          {!isETFInstrument && stock.event_8k && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">📋 Recent 8-K</span>
              </div>
              <div className="detail-rows">
                <FundRow label="Event"
                  value={`${stock.event_8k_icon || ''} ${stock.event_8k}`}
                  hint="Material SEC filing within the last 30 days"
                  positive={stock.event_8k_hint === 'positive'}/>
                {stock.event_8k_date && (
                  <FundRow label="Filed" value={stock.event_8k_date}/>
                )}
              </div>
            </div>
          )}

          {/* Filing Narrative card — stocks only, shown after new 10-K/10-Q */}
          {!isETFInstrument && filingNarrative && (
            <FilingNarrativeCard narrative={filingNarrative}/>
          )}

          {/* Earnings Event card — stocks only, shown for 90 days after earnings */}
          {!isETFInstrument && earningsEvent && (
            <EarningsCard event={earningsEvent}/>
          )}

          {/* Score breakdown — weights differ for ETFs vs stocks */}
          {(isETFInstrument ? stock.score_tech != null : stock.score_fund != null) && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">📐 Score Breakdown</span>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  {stock.hypergrowth_mode && (
                    <span style={{
                      fontSize:10, padding:'2px 6px', borderRadius:4,
                      background:'#7c3aed18', color:'#7c3aed',
                      border:'1px solid #7c3aed40', fontWeight:600,
                      fontFamily:'DM Mono,monospace',
                    }}>⚡ Hypergrowth</span>
                  )}
                  <span className="detail-section-score" style={{ color: scoreCol(stock.latest_score) }}>
                    {stock.latest_score?.toFixed(1)}/10
                  </span>
                </div>
              </div>
              <div className="detail-rows">
                {isETFInstrument ? (
                  <>
                    <FundRow label="Technicals (50%)"
                      value={stock.score_tech != null ? `${stock.score_tech.toFixed(1)}/10` : null}
                      hint="SMA-200 trend + RSI — price momentum is the primary signal for ETFs"
                      positive={stock.score_tech >= 6}/>
                    <FundRow label="News Sentiment (30%)"
                      value={stock.score_news != null ? `${stock.score_news.toFixed(1)}/10` : null}
                      hint="Sector/theme news — captures macro and sector-level events relevant to the fund"
                      positive={stock.score_news >= 6}/>
                    <FundRow label="Analyst Consensus (20%)"
                      value={stock.score_rating != null ? `${stock.score_rating.toFixed(1)}/10` : null}
                      hint="Analyst ratings on the ETF where available"
                      positive={stock.score_rating >= 6}/>
                  </>
                ) : (
                  <>
                    <FundRow label="Fundamentals (45%)"
                      value={stock.score_fund != null ? `${stock.score_fund.toFixed(1)}/10` : null}
                      hint="ROIC (40%) · SBC-adj FCF (30%) · D/E (20%) · Revenue growth dual-window (10%)"
                      positive={stock.score_fund >= 6}/>
                    <FundRow label="Insider (25%)"
                      value={stock.score_insider != null ? `${stock.score_insider.toFixed(1)}/10` : null}
                      hint="CEO/CFO open-market buys (3× weight) · cluster detection · excludes tax withholding, grants, option exercises"
                      positive={stock.score_insider >= 6}/>
                    <FundRow label="Analyst Rating (10%)"
                      value={stock.score_rating != null ? `${stock.score_rating.toFixed(1)}/10` : null}
                      hint="Snapshot consensus + revision delta — upgrades/downgrades vs prior month are amplified"
                      positive={stock.score_rating >= 6}/>
                    <FundRow label="Technicals (10%)"
                      value={stock.score_tech != null ? `${stock.score_tech.toFixed(1)}/10` : null}
                      hint="SMA-200 (60%) + SMA-50 (40%) trend confirmation · RSI sweet spot 45-65 · oversold <35 = opportunity"
                      positive={stock.score_tech >= 6}/>
                    <FundRow label="News (10%)"
                      value={stock.score_news != null ? `${stock.score_news.toFixed(1)}/10` : null}
                      hint="Recency-weighted average of 3 intraday news runs — 9 AM, 1 PM, 4:15 PM ET"
                      positive={stock.score_news >= 6}/>
                    {stock.fcf_yield_score != null && (
                      <FundRow label="FCF Yield (display)"
                        value={`${stock.fcf_yield_score.toFixed(1)}%`}
                        hint="Valuation context only — not in score. >5% attractive, <2% expensive."
                        positive={stock.fcf_yield_score > 3}/>
                    )}
                    {stock.momentum_label && stock.momentum_label !== 'NEUTRAL' && (
                      <FundRow label="Price Momentum"
                        value={stock.momentum_label}
                        hint="SMA50/SMA200 trend cross + 21d rate-of-change. STRONG = golden cross + positive ROC."
                        positive={['STRONG','POSITIVE'].includes(stock.momentum_label)}/>
                    )}
                    {stock.realized_vol != null && (
                      <FundRow label="Realised Vol (ann.)"
                        value={`${stock.realized_vol.toFixed(1)}%`}
                        hint="Annualised 21-day realised volatility. Context for position sizing alongside beta."
                        positive={stock.realized_vol < 30}/>
                    )}
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
  const [loading,        setLoading]        = useState(true);
  const [lastUpdate,     setLastUpdate]     = useState(null);
  const [sortBy,         setSortBy]         = useState('score');
  const [filterSignal,   setFilterSignal]   = useState('ALL');
  const [showForm,       setShowForm]       = useState(false);
  const [formMode,       setFormMode]       = useState('add');
  const [formData,       setFormData]       = useState({
    symbol:'', name:'', quantity:'', average_price:'', type:'Stock', region:'Global', sector:''
  });
  const [editingId,      setEditingId]      = useState(null);
  const [newsModalStock, setNewsModalStock] = useState(null);
  const [expandedRow,    setExpandedRow]    = useState(null); // symbol string

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
      type: stock.type || 'Stock', region: stock.region || 'Global', sector: stock.sector || '',
    });
    setShowForm(true);
  };

  const openAddForm = () => {
    setFormMode('add'); setEditingId(null);
    setFormData({ symbol:'', name:'', quantity:'', average_price:'', type:'Stock', region:'Global', sector:'' });
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
    else if (filterSignal !== 'ALL')
      filtered = filtered.filter(s => s.signal === filterSignal || s.regime === filterSignal);

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
      }, 0)
    : 0;
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

      {/* ── Header ── */}
      <div className="dashboard-header">
        <div>
          <h1>Alpha Compounder</h1>
          <p className="subtitle">Regime-Aware · Long-Horizon · Fundamentals-First</p>
        </div>
        <div className="header-actions">
          {lastUpdate && (
            <div className="last-update">
              <span className="live-dot"/>
              Auto-refreshes · Last: {lastUpdate.toLocaleTimeString()}
            </div>
          )}
          <button onClick={openAddForm} className="btn-primary">+ Add Asset</button>
        </div>
      </div>

      {/* ── Stats ── */}
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
            <div className="stat-label">Total P&amp;L</div>
            <div className="stat-value stat-value-sm" style={{ color: totalPnL >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {totalPnL >= 0 ? '+' : ''}{fmtUSD(totalPnL, true)}
            </div>
            <div className={`stat-sub ${totalPnL >= 0 ? 'pos' : 'neg'}`}>{fmtPct(totalPnLPct)} vs cost basis</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Avg Quality</div>
            <div className="stat-value" style={{ color: scoreCol(parseFloat(stats?.averageScore ?? avgScore)) }}>
              {stats?.averageScore ?? avgScore}<span className="stat-unit">/10</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Alpha Signals</div>
            <div className="stat-value" style={{ color: bullCount > 0 ? 'var(--green)' : 'var(--text-muted)' }}>
              {stats?.strongBuys ?? bullCount}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Decay Warnings</div>
            <div className="stat-value" style={{ color: bearCount > 0 ? 'var(--red)' : 'var(--text-muted)' }}>
              {stats?.buys ?? bearCount}
            </div>
          </div>
        </div>
      </div>

      {/* ── Controls ── */}
      <div className="controls-section">
        <div className="filter-pills">
          {[{v:'ALL',l:'All'},{v:'BULLISH',l:'▲ Bullish'},{v:'NOISE',l:'— Noise'},{v:'BEARISH',l:'▼ Decay'}]
            .map(({v,l}) => (
              <button key={v}
                className={`pill ${filterSignal===v?'pill-active':''} pill-${v.toLowerCase()}`}
                onClick={() => setFilterSignal(v)}>{l}</button>
            ))}
        </div>
        <select className="minimal-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="score">Score (High to Low)</option>
          <option value="moat">Moat Score</option>
          <option value="alpha">Jensen's Alpha</option>
          <option value="pnl">Unrealized P&amp;L</option>
          <option value="symbol">Symbol (A–Z)</option>
        </select>
        <div className="results-count">{filteredPortfolio.length} Assets</div>
      </div>

      {/* ── Table ── */}
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
                  <th>Regime &amp; α</th>
                  <th>Signal</th>
                  <th>Total Value</th>
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

                  return (
                    <React.Fragment key={stock.id}>
                      <tr className={`row-${sCfg.tier}${isExpanded ? ' row-expanded' : ''}`}>

                        {/* Asset */}
                        <td>
                          <div className="symbol-row">
                            <strong className="stock-symbol">{stock.symbol}</strong>
                            {stock.instrument_type === 'ETF' && (
                              <span className="etf-badge" title="ETF — judged on momentum, trend and news only">ETF</span>
                            )}
                          </div>
                          {stock.name   && <div className="stock-name">{stock.name}</div>}
                          {stock.sector && <span className="sector-pill">{stock.sector}</span>}
                        </td>

                        {/* Price & P&L */}
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

                        {/* Quality + Moat rings side by side */}
                        <td>
                          <div className="quality-moat-cell">
                            <ScoreRing score={stock.latest_score}/>
                            {stock.moat_score != null && <MoatRing score={stock.moat_score}/>}
                            {stock.capex_exception && (
                              <span className="capex-flag" title="Capex Exception: Strategic investment. FCF penalty forgiven.">🏗️</span>
                            )}
                          </div>
                          {/* Compact FCF Yield below rings */}
                          {stock.fcf_yield != null && (
                            <div className="compact-metric" title="FCF Yield — >5% attractive, <2% expensive">
                              <span className="compact-lbl">FCF yld</span>
                              <span className={`compact-val ${stock.fcf_yield*100 > 3 ? 'pos' : stock.fcf_yield*100 < 1 ? 'neg' : ''}`}>
                                {(stock.fcf_yield*100).toFixed(1)}%
                              </span>
                            </div>
                          )}
                        </td>

                        {/* Regime & Alpha */}
                        <td>
                          <div className="regime-name" style={{color:rCfg.color}}>{rCfg.label}</div>
                          {stock.excess_return != null && (
                            <div className={`alpha-val change ${stock.excess_return>=0?'positive':'negative'}`}>
                              α {fmtPct(stock.excess_return)}
                            </div>
                          )}
                          {stock.beta != null && <div className="beta-val">β {Number(stock.beta).toFixed(2)}</div>}
                          {/* Max drawdown in this column — risk context */}
                          {stock.max_drawdown != null && (
                            <div className="compact-metric" title="Max Drawdown (trailing 252 days)">
                              <span className="compact-lbl">MaxDD</span>
                              <span className={`compact-val ${stock.max_drawdown > -15 ? '' : 'neg'}`}>
                                {stock.max_drawdown.toFixed(1)}%
                              </span>
                            </div>
                          )}
                        </td>

                        {/* Signal */}
                        <td>
                          <span className={`signal-badge ${
                            sCfg.tier === 'bull' ? 'signal-bull' :
                            sCfg.tier === 'bear' && ['WATCH','TRIM_25'].includes(stock.signal) ? 'signal-bear-soft' :
                            sCfg.tier === 'bear' ? 'signal-bear-hard' :
                            'signal-neutral'
                          }`}>{sCfg.label}</span>
                          <SpringBar days={stock.spring_days}/>
                          <CascadePips w1={stock.w1_signal} w2={stock.w2_confirmed} w3={stock.w3_confirmed} w4={stock.w4_confirmed}/>
                        </td>

                        {/* Total Value */}
                        <td>
                          <div className="price-value">{fmtUSD(tv)}</div>
                          {totalVal > 0 && <div className="weight-pct">{((tv/totalVal)*100).toFixed(1)}%</div>}
                        </td>

                        {/* Actions */}
                        <td className="col-actions">
                          <button
                            onClick={() => toggleRow(stock.symbol)}
                            className={`btn-icon btn-expand${isExpanded ? ' btn-expand-active' : ''}`}
                            title="View fundamental detail">
                            {isExpanded ? '▲' : '▼'}
                          </button>
                          <button onClick={() => setNewsModalStock(stock)} className="btn-icon" title="View Intelligence">📰</button>
                          <button onClick={() => openEditForm(stock)} className="btn-icon" title="Edit position">✏️</button>
                          <button onClick={() => handleDeleteStock(stock.id)} className="btn-icon btn-icon-danger" title="Remove">✕</button>
                        </td>
                      </tr>

                      {/* Expandable detail panel */}
                      {isExpanded && <DetailPanel stock={stock}/>}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CorrelationHeatmap/>

      {/* ── Add / Edit Modal ── */}
      {showForm && (
        <Modal onClose={() => setShowForm(false)}>
          <div className="modal-header">
            <div className="modal-header-text">
              <h2>{formMode === 'add' ? 'Add Asset' : 'Edit Position'}</h2>
              <p className="modal-sub-label">
                {formMode === 'add' ? 'Enter ticker details to begin tracking.' : `Editing ${formData.symbol}`}
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
                <label>Name</label>
                <input type="text" placeholder="Company name" value={formData.name}
                  onChange={e => setFormData({...formData, name: e.target.value})}/>
              </div>
              <div className="form-group">
                <label>Quantity</label>
                <input type="number" step="0.01" value={formData.quantity}
                  onChange={e => setFormData({...formData, quantity: e.target.value})}/>
              </div>
              <div className="form-group">
                <label>Avg Cost</label>
                <input type="number" step="0.01" value={formData.average_price}
                  onChange={e => setFormData({...formData, average_price: e.target.value})}/>
              </div>
              <div className="form-group">
                <label>Sector</label>
                <input type="text" placeholder="e.g. Technology" value={formData.sector}
                  onChange={e => setFormData({...formData, sector: e.target.value})}/>
              </div>
              <div className="form-group">
                <label>Region</label>
                <select value={formData.region} onChange={e => setFormData({...formData, region: e.target.value})}>
                  <option>Global</option><option>US</option><option>Europe</option>
                  <option>Asia</option><option>EM</option>
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

      {/* ── Intelligence Modal ── */}
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
                  {n.description && <p className="news-desc">{n.description.substring(0,150)}…</p>}
                </a>
              ))
            ) : (
              <p className="no-news">No actionable intelligence found for this cycle.</p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
};

export default EnhancedPortfolioDashboard;
