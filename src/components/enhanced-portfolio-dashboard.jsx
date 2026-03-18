import React, { useState, useEffect, useRef, useCallback } from 'react';
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

// ── Canvas Neural Network Background ─────────────────────────────────────────
// Nodes drift randomly, repel from mouse cursor.
// Green nodes occupy left 45% of screen, red nodes right 45%, a few neutral
// nodes in the centre. Edges drawn between nearby nodes.
// All rendered on a <canvas> with pointer-events:none so it never blocks clicks.
const NeuralBackground = () => {
  const canvasRef = useRef(null);
  const mouseRef  = useRef({ x: -9999, y: -9999 });
  const nodesRef  = useRef([]);
  const rafRef    = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // ── Resize handler ──────────────────────────────────────────────────────
    const resize = () => {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      initNodes();
    };

    // ── Build node list ─────────────────────────────────────────────────────
    // 28 nodes, ALL randomly scattered across the full viewport.
    // Colours are assigned randomly — no fixed left/right zones.
    // ~40% green, ~40% red, ~20% neutral, mixed like a live market.
    const initNodes = () => {
      const W = canvas.width, H = canvas.height;
      const COLORS = [
        { c: '#059669', a: () => 0.42 + Math.random() * 0.25 },
        { c: '#dc2626', a: () => 0.38 + Math.random() * 0.22 },
        { c: '#a0a09a', a: () => 0.20 + Math.random() * 0.14 },
      ];
      const pickColor = () => {
        const r = Math.random();
        if (r < 0.40) return COLORS[0];
        if (r < 0.80) return COLORS[1];
        return COLORS[2];
      };
      const nodes = [];
      for (let i = 0; i < 28; i++) {
        const col = pickColor();
        const x = W * (0.03 + Math.random() * 0.94);
        const y = H * (0.03 + Math.random() * 0.94);
        nodes.push({
          x, y,
          baseX: x, baseY: y,
          vx: (Math.random() - 0.5) * 0.5,
          vy: (Math.random() - 0.5) * 0.5,
          r: 2.5 + Math.random() * 2.5,
          color: col.c,
          alpha: col.a(),
          pulseOffset: Math.random() * Math.PI * 2,
          pulseSpeed:  0.010 + Math.random() * 0.020,
        });
      }
      nodesRef.current = nodes;
    };

    // ── Mouse tracking ──────────────────────────────────────────────────────
    const onMouse = e => { mouseRef.current = { x: e.clientX, y: e.clientY }; };
    const onLeave = () => { mouseRef.current = { x: -9999, y: -9999 }; };
    window.addEventListener('mousemove', onMouse);
    window.addEventListener('mouseleave', onLeave);

    // ── Draw loop ───────────────────────────────────────────────────────────
    const EDGE_DIST    = 180; // max px to draw an edge
    const REPEL_DIST   = 120; // mouse repulsion radius
    const REPEL_FORCE  = 1.8;
    const DAMPING      = 0.96;
    const REVERT_FORCE = 0.004; // gentle pull back to home position

    const draw = (t) => {
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const nodes = nodesRef.current;
      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;

      // Update positions
      for (const n of nodes) {
        // Gentle mean-reversion toward home
        n.vx += (n.baseX - n.x) * REVERT_FORCE;
        n.vy += (n.baseY - n.y) * REVERT_FORCE;

        // Random drift nudge (small, applied every frame)
        n.vx += (Math.random() - 0.5) * 0.06;
        n.vy += (Math.random() - 0.5) * 0.06;

        // Mouse repulsion
        const dx = n.x - mx, dy = n.y - my;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < REPEL_DIST && dist > 0) {
          const force = (REPEL_DIST - dist) / REPEL_DIST * REPEL_FORCE;
          n.vx += (dx / dist) * force;
          n.vy += (dy / dist) * force;
        }

        n.vx *= DAMPING;
        n.vy *= DAMPING;

        // Clamp velocity
        const speed = Math.sqrt(n.vx*n.vx + n.vy*n.vy);
        if (speed > 2.5) { n.vx = n.vx/speed*2.5; n.vy = n.vy/speed*2.5; }

        n.x += n.vx;
        n.y += n.vy;

        // Soft boundary bounce
        if (n.x < 0)   { n.x = 0;  n.vx *= -0.5; }
        if (n.x > W)   { n.x = W;  n.vx *= -0.5; }
        if (n.y < 0)   { n.y = 0;  n.vy *= -0.5; }
        if (n.y > H)   { n.y = H;  n.vy *= -0.5; }
      }

      // Draw edges between nearby nodes of same or adjacent colour families
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d  = Math.sqrt(dx*dx + dy*dy);
          if (d > EDGE_DIST) continue;

          // Only connect same-colour or neutral to any
          const sameFamily = a.color === b.color
            || a.color === '#a0a09a'
            || b.color === '#a0a09a';
          if (!sameFamily) continue;

          const alpha = (1 - d / EDGE_DIST) * 0.18; // max edge opacity 0.18
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = a.color === '#a0a09a' ? `rgba(160,160,154,${alpha})` :
                            a.color === '#059669' ? `rgba(5,150,105,${alpha})` :
                                                    `rgba(220,38,38,${alpha})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // Draw nodes
      const now = t * 0.001;
      for (const n of nodes) {
        const pulse = 0.85 + 0.15 * Math.sin(now * n.pulseSpeed * 60 + n.pulseOffset);
        const r     = n.r * pulse;
        const alpha = n.alpha * pulse;

        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);

        if (n.color === '#059669') ctx.fillStyle = `rgba(5,150,105,${alpha})`;
        else if (n.color === '#dc2626') ctx.fillStyle = `rgba(220,38,38,${alpha})`;
        else ctx.fillStyle = `rgba(160,160,154,${alpha})`;

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
          strokeDasharray={`${Math.max(0, Math.min(10, score||0))/10*circ} ${circ}`}
          strokeLinecap="round" transform="rotate(-90 22 22)"
          style={{ transition: 'stroke-dasharray .5s ease' }}/>
      </svg>
      <span className="score-ring-num" style={{ color: col }}>
        {score != null ? score.toFixed(1) : '—'}
      </span>
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

// ── Modal component ───────────────────────────────────────────────────────────
// Backdrop fades the page. The modal box anchors near the click origin,
// nudged inward so it never overflows the screen edges.
const Modal = ({ onClose, children, wide = false, origin = null }) => {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const boxW = wide ? 600 : 500;
  const boxH = 420; // approximate

  let style = {};
  if (origin) {
    // Prefer below-right of click; flip if too close to edge
    let left = origin.x - 20;
    let top  = origin.y + 16;
    if (left + boxW > W - 16) left = W - boxW - 16;
    if (top  + boxH > H - 16) top  = origin.y - boxH - 8;
    if (left < 16) left = 16;
    if (top  < 16) top  = 16;
    style = { position: 'fixed', left, top, transform: 'none', margin: 0 };
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}
         style={origin ? { alignItems: 'flex-start', justifyContent: 'flex-start' } : {}}>
      <div
        className={`modal-box${wide ? ' modal-news' : ''}`}
        style={style}
        onMouseDown={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};

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
  const [modalOrigin,    setModalOrigin]    = useState(null); // {x, y} click position

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

  const openEditForm = (stock, e) => {
    setModalOrigin(e ? { x: e.clientX, y: e.clientY } : null);
    setFormMode('edit'); setEditingId(stock.id);
    setFormData({
      symbol: stock.symbol, name: stock.name || '',
      quantity: stock.quantity.toString(), average_price: stock.average_price.toString(),
      type: stock.type || 'Stock', region: stock.region || 'Global', sector: stock.sector || '',
    });
    setShowForm(true);
  };

  const openAddForm = (e) => {
    setModalOrigin(e ? { x: e.clientX, y: e.clientY } : null);
    setFormMode('add'); setEditingId(null);
    setFormData({ symbol:'', name:'', quantity:'', average_price:'', type:'Stock', region:'Global', sector:'' });
    setShowForm(true);
  };

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
  const totalPnLPct  = totalCost > 0 ? (totalPnL/totalCost)*100 : 0;
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
          <button onClick={e => openAddForm(e)} className="btn-primary">+ Add Asset</button>
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
                  <th>Asset</th><th>Price &amp; P&amp;L</th><th>Quality</th>
                  <th>Regime &amp; α</th><th>Signal</th><th>Total Value</th><th></th>
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
                  return (
                    <tr key={stock.id} className={`row-${sCfg.tier}`}>
                      <td>
                        <strong className="stock-symbol">{stock.symbol}</strong>
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
                        <div style={{display:'flex',alignItems:'center',gap:6}}>
                          <ScoreRing score={stock.latest_score}/>
                          {stock.capex_exception && (
                            <span className="capex-flag" title="Capex Exception: Strategic investment. FCF penalty forgiven.">🏗️</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="regime-name" style={{color:rCfg.color}}>{rCfg.label}</div>
                        {stock.excess_return != null && (
                          <div className={`alpha-val change ${stock.excess_return>=0?'positive':'negative'}`}>
                            α {fmtPct(stock.excess_return)}
                          </div>
                        )}
                        {stock.beta != null && <div className="beta-val">β {Number(stock.beta).toFixed(2)}</div>}
                      </td>
                      <td>
                        <span className="signal-badge" style={{
                          color: sCfg.color,
                          backgroundColor: `${sCfg.color}22`,
                          borderColor: `${sCfg.color}55`,
                          fontWeight: 700,
                        }}>{sCfg.label}</span>
                        <SpringBar days={stock.spring_days}/>
                        <CascadePips w1={stock.w1_signal} w2={stock.w2_confirmed} w3={stock.w3_confirmed} w4={stock.w4_confirmed}/>
                      </td>
                      <td>
                        <div className="price-value">{fmtUSD(tv)}</div>
                        {totalVal > 0 && <div className="weight-pct">{((tv/totalVal)*100).toFixed(1)}%</div>}
                      </td>
                      <td className="col-actions">
                        <button onClick={e => { e.stopPropagation(); setModalOrigin({x:e.clientX,y:e.clientY}); setNewsModalStock(stock); }} className="btn-icon" title="View Intelligence">📰</button>
                        <button onClick={e => openEditForm(stock, e)} className="btn-icon" title="Edit position">✏️</button>
                        <button onClick={() => handleDeleteStock(stock.id)} className="btn-icon btn-icon-danger" title="Remove">✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CorrelationHeatmap/>

      {/* ── Add / Edit Modal ──────────────────────────────────────────────────
          Modal component uses onMouseDown on overlay to close.
          onMouseDown on inner box stops propagation.
          form onSubmit handles submission — NO page freeze.               */}
      {showForm && (
        <Modal onClose={() => setShowForm(false)} origin={modalOrigin}>
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
            <button
              type="button"
              className="btn-primary"
              onClick={formMode === 'add' ? handleAddStock : handleEditStock}
            >
              {formMode === 'add' ? 'Add to Portfolio' : 'Save Changes'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Intelligence Modal ── */}
      {newsModalStock && (
        <Modal onClose={() => setNewsModalStock(null)} wide origin={modalOrigin}>
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
