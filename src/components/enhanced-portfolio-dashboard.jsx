import React, { useState, useEffect } from 'react';
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
  if (compact && Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (compact && Math.abs(n) >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
};
const fmtPct = (n, dp = 2) => {
  if (n == null || isNaN(n)) return null;
  return `${n >= 0 ? '+' : ''}${Number(n).toFixed(dp)}%`;
};
const scoreCol = s => {
  if (s == null) return '#9ca3af';
  if (s >= 8)    return '#059669';
  if (s >= 6.5)  return '#2563eb';
  if (s >= 5)    return '#d97706';
  return '#dc2626';
};

// ── Neural Network Market Background ──────────────────────────────────────────
// Two networks: green bull (left side) + red bear (right side).
// Each has static edge lines (low opacity glow) + animated signal packets
// (stroke-dashoffset) travelling along edges + pulsing nodes.
// Uses SVG percentage coordinates — scales to any viewport.
// All elements are subtle (opacity 0.15–0.30 edges, 0.30–0.65 nodes).
const MarketBackground = () => (
  <svg className="market-bg" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"
       viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">

    {/* ── GREEN BULL NETWORK — left third ────────────────────────────────────
        Nodes: A(80,640), B(160,490), C(260,580), D(200,370), E(340,450), F(120,280)
        Arranged in a graph topology — larger vertical spread for visual depth.
    ───────────────────────────────────────────────────────────────────────── */}

    {/* Static edges */}
    <line className="mkt-eg"  x1="80"  y1="640" x2="160" y2="490" stroke="#059669" strokeWidth="1.3"/>
    <line className="mkt-eg"  x1="160" y1="490" x2="260" y2="580" stroke="#059669" strokeWidth="1.3"/>
    <line className="mkt-eg2" x1="160" y1="490" x2="200" y2="370" stroke="#059669" strokeWidth="1.1"/>
    <line className="mkt-eg2" x1="200" y1="370" x2="340" y2="450" stroke="#059669" strokeWidth="1.1"/>
    <line className="mkt-eg"  x1="200" y1="370" x2="120" y2="280" stroke="#059669" strokeWidth="1.1"/>
    <line className="mkt-eg2" x1="120" y1="280" x2="340" y2="450" stroke="#059669" strokeWidth="0.7"/>
    <line className="mkt-eg2" x1="80"  y1="640" x2="260" y2="580" stroke="#059669" strokeWidth="0.7"/>

    {/* Signal packets — green (18px dash travelling along each edge) */}
    <line className="mkt-sg1"
      x1="80" y1="640" x2="160" y2="490"
      stroke="#059669" strokeWidth="3"
      strokeDasharray="18 260" strokeDashoffset="260"/>
    <line className="mkt-sg2"
      x1="160" y1="490" x2="200" y2="370"
      stroke="#059669" strokeWidth="3"
      strokeDasharray="18 260" strokeDashoffset="260"/>
    <line className="mkt-sg3"
      x1="200" y1="370" x2="340" y2="450"
      stroke="#059669" strokeWidth="3"
      strokeDasharray="18 260" strokeDashoffset="260"/>
    <line className="mkt-sg4"
      x1="200" y1="370" x2="120" y2="280"
      stroke="#059669" strokeWidth="3"
      strokeDasharray="18 260" strokeDashoffset="260"/>
    <line className="mkt-sg5"
      x1="160" y1="490" x2="260" y2="580"
      stroke="#059669" strokeWidth="3"
      strokeDasharray="18 260" strokeDashoffset="260"/>

    {/* Green nodes */}
    <circle className="mkt-ng"   cx="80"  cy="640" r="5"   fill="#059669"/>
    <circle className="mkt-ng-s" cx="160" cy="490" r="5.5" fill="#059669"/>
    <circle className="mkt-ng"   cx="260" cy="580" r="4.5" fill="#059669"/>
    <circle className="mkt-ng-s" cx="200" cy="370" r="5"   fill="#059669"/>
    <circle className="mkt-ng"   cx="340" cy="450" r="4.5" fill="#059669"/>
    <circle className="mkt-ng-s" cx="120" cy="280" r="4"   fill="#059669"/>

    {/* ── RED BEAR NETWORK — right third ─────────────────────────────────────
        Nodes: P(900,200), Q(1000,340), R(1100,220), S(960,480), T(1080,400), U(860,360)
    ───────────────────────────────────────────────────────────────────────── */}

    {/* Static edges */}
    <line className="mkt-er"  x1="900"  y1="200" x2="1000" y2="340" stroke="#dc2626" strokeWidth="1.3"/>
    <line className="mkt-er"  x1="1000" y1="340" x2="1100" y2="220" stroke="#dc2626" strokeWidth="1.3"/>
    <line className="mkt-er2" x1="1000" y1="340" x2="960"  y2="480" stroke="#dc2626" strokeWidth="1.1"/>
    <line className="mkt-er2" x1="960"  y1="480" x2="1080" y2="400" stroke="#dc2626" strokeWidth="1.1"/>
    <line className="mkt-er"  x1="1100" y1="220" x2="1080" y2="400" stroke="#dc2626" strokeWidth="1.1"/>
    <line className="mkt-er2" x1="900"  y1="200" x2="860"  y2="360" stroke="#dc2626" strokeWidth="0.7"/>
    <line className="mkt-er2" x1="860"  y1="360" x2="1000" y2="340" stroke="#dc2626" strokeWidth="0.7"/>

    {/* Signal packets — red */}
    <line className="mkt-sr1"
      x1="900" y1="200" x2="1000" y2="340"
      stroke="#dc2626" strokeWidth="3"
      strokeDasharray="18 260" strokeDashoffset="260"/>
    <line className="mkt-sr2"
      x1="1000" y1="340" x2="1100" y2="220"
      stroke="#dc2626" strokeWidth="3"
      strokeDasharray="18 260" strokeDashoffset="260"/>
    <line className="mkt-sr3"
      x1="1000" y1="340" x2="960" y2="480"
      stroke="#dc2626" strokeWidth="3"
      strokeDasharray="18 260" strokeDashoffset="260"/>
    <line className="mkt-sr4"
      x1="960" y1="480" x2="1080" y2="400"
      stroke="#dc2626" strokeWidth="3"
      strokeDasharray="18 260" strokeDashoffset="260"/>

    {/* Red nodes */}
    <circle className="mkt-nr"   cx="900"  cy="200" r="5"   fill="#dc2626"/>
    <circle className="mkt-nr-s" cx="1000" cy="340" r="5.5" fill="#dc2626"/>
    <circle className="mkt-nr"   cx="1100" cy="220" r="4.5" fill="#dc2626"/>
    <circle className="mkt-nr-s" cx="960"  cy="480" r="5"   fill="#dc2626"/>
    <circle className="mkt-nr"   cx="1080" cy="400" r="4.5" fill="#dc2626"/>
    <circle className="mkt-nr-s" cx="860"  cy="360" r="4"   fill="#dc2626"/>

    {/* ── NEUTRAL CONNECTORS — centre + bottom ────────────────────────────────
        Very dim grey — just enough to fill the middle ground.
    ───────────────────────────────────────────────────────────────────────── */}
    <line x1="340" y1="450" x2="560" y2="520" stroke="#a0a09a" strokeWidth="0.8" opacity="0.10"/>
    <line x1="560" y1="520" x2="720" y2="460" stroke="#a0a09a" strokeWidth="0.8" opacity="0.08"/>
    <line x1="720" y1="460" x2="860" y2="360" stroke="#a0a09a" strokeWidth="0.8" opacity="0.08"/>
    <circle cx="560" cy="520" r="3.5" fill="#a0a09a" opacity="0.18"/>
    <circle cx="720" cy="460" r="3"   fill="#a0a09a" opacity="0.14"/>

    {/* Faint horizontal grid reference lines — very subtle */}
    <line x1="40" y1="300" x2="1160" y2="300" stroke="#a0a09a" strokeWidth="0.5" opacity="0.05" strokeDasharray="4 12"/>
    <line x1="40" y1="500" x2="1160" y2="500" stroke="#a0a09a" strokeWidth="0.5" opacity="0.05" strokeDasharray="4 12"/>
    <line x1="40" y1="680" x2="1160" y2="680" stroke="#a0a09a" strokeWidth="0.5" opacity="0.04" strokeDasharray="4 12"/>
  </svg>
);

// ── Sub-components ─────────────────────────────────────────────────────────────
const ScoreRing = ({ score }) => {
  const r = 17, circ = 2 * Math.PI * r;
  const col = scoreCol(score);
  return (
    <div className="score-ring" title={`Quality Score: ${score?.toFixed(1) ?? '—'}/10`}>
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r={r} fill="none" stroke="#e6e5df" strokeWidth="2.5"/>
        <circle cx="22" cy="22" r={r} fill="none" stroke={col} strokeWidth="2.5"
          strokeDasharray={`${Math.max(0, Math.min(10, score||0))/10 * circ} ${circ}`}
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

// ── Main component ─────────────────────────────────────────────────────────────
const EnhancedPortfolioDashboard = () => {
  const [portfolio,    setPortfolio]    = useState([]);
  const [stats,        setStats]        = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [lastUpdate,   setLastUpdate]   = useState(null);
  const [sortBy,       setSortBy]       = useState('score');
  const [filterSignal, setFilterSignal] = useState('ALL');
  const [showForm,     setShowForm]     = useState(false);
  const [formMode,     setFormMode]     = useState('add');
  const [formData,     setFormData]     = useState({
    symbol:'', name:'', quantity:'', average_price:'', type:'Stock', region:'Global', sector:''
  });
  const [editingId,      setEditingId]      = useState(null);
  const [newsModalStock, setNewsModalStock] = useState(null);

  const fetchPortfolio = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/portfolio');
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      if (data.status === 'success') {
        const sorted = [...data.portfolio].sort((a, b) => (b.latest_score||0) - (a.latest_score||0));
        setPortfolio(sorted);
        setStats(data.stats);
        setLastUpdate(new Date(data.timestamp));
      }
    } catch (err) {
      console.error('Error fetching portfolio:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPortfolio();
    const interval = setInterval(fetchPortfolio, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Lock body scroll when a modal is open so the page doesn't scroll behind it
  useEffect(() => {
    const open = showForm || !!newsModalStock;
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [showForm, newsModalStock]);

  const handleAddStock = async (e) => {
    e.preventDefault();
    if (!formData.symbol || !formData.quantity || !formData.average_price) return;
    try {
      const res = await fetch('/api/portfolio/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      if (res.ok) { setShowForm(false); fetchPortfolio(); }
    } catch (err) { console.error(err); }
  };

  const handleEditStock = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`/api/portfolio/edit/${editingId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      if (res.ok) { setShowForm(false); setEditingId(null); fetchPortfolio(); }
    } catch (err) { console.error(err); }
  };

  const handleDeleteStock = async (id) => {
    if (!window.confirm('Remove this asset from the portfolio?')) return;
    try {
      const res = await fetch(`/api/portfolio/delete/${id}`, { method: 'DELETE' });
      if (res.ok) fetchPortfolio();
    } catch (err) { console.error(err); }
  };

  const openEditForm = (stock) => {
    setFormMode('edit'); setEditingId(stock.id);
    setFormData({
      symbol: stock.symbol, name: stock.name || '',
      quantity: stock.quantity.toString(),
      average_price: stock.average_price.toString(),
      type: stock.type || 'Stock', region: stock.region || 'Global', sector: stock.sector || ''
    });
    setShowForm(true);
  };

  const openAddForm = () => {
    setFormMode('add'); setEditingId(null);
    setFormData({ symbol:'', name:'', quantity:'', average_price:'', type:'Stock', region:'Global', sector:'' });
    setShowForm(true);
  };

  const getFilteredPortfolio = () => {
    let filtered = portfolio;
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
  const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;
  const totalDayChange = portfolio.reduce((s,x) => {
    if (!x.current_price || x.change_percent == null || !x.quantity) return s;
    const prev = x.current_price / (1 + x.change_percent / 100);
    return s + (x.current_price - prev) * x.quantity;
  }, 0);
  const totalDayPct = totalVal > 0
    ? portfolio.reduce((s,x) => {
        if (!x.current_price || x.change_percent == null || !x.quantity) return s;
        return s + x.change_percent * ((x.current_price * x.quantity) / totalVal);
      }, 0)
    : 0;

  const avgScore  = portfolio.length
    ? (portfolio.reduce((s,x) => s + (x.latest_score||0), 0) / portfolio.length).toFixed(1) : '—';
  const bullCount = portfolio.filter(s => ['ADD','SPRING_CONFIRMED','SPRING_CANDIDATE','STRONG_BUY','BUY'].includes(s.signal)).length;
  const bearCount = portfolio.filter(s => ['WATCH','TRIM_25','REDUCE','SELL','IDIOSYNCRATIC_DECAY'].includes(s.signal)).length;

  if (loading && portfolio.length === 0) {
    return (
      <div className="dashboard-container">
        <MarketBackground />
        <div className="loading-wrap"><div className="loading-ring"/></div>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <MarketBackground />

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
              <button key={v} className={`pill ${filterSignal===v?'pill-active':''} pill-${v.toLowerCase()}`}
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
            <button className="btn-secondary" style={{padding:'6px 14px'}} onClick={() => setFilterSignal('ALL')}>
              Clear filter
            </button>
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
                  const tv  = (parseFloat(stock.current_price)||0) * (parseFloat(stock.quantity)||0);
                  const pd  = ((stock.current_price||0)-(stock.average_price||0)) * (stock.quantity||0);
                  const pp  = stock.average_price > 0
                    ? ((stock.current_price - stock.average_price) / stock.average_price) * 100 : null;
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
                          backgroundColor: `${sCfg.color}14`,
                          borderColor: `${sCfg.color}30`,
                        }}>{sCfg.label}</span>
                        <SpringBar days={stock.spring_days}/>
                        <CascadePips w1={stock.w1_signal} w2={stock.w2_confirmed} w3={stock.w3_confirmed} w4={stock.w4_confirmed}/>
                      </td>
                      <td>
                        <div className="price-value">{fmtUSD(tv)}</div>
                        {totalVal > 0 && <div className="weight-pct">{((tv/totalVal)*100).toFixed(1)}%</div>}
                      </td>
                      <td className="col-actions">
                        <button onClick={() => setNewsModalStock(stock)} className="btn-icon" title="View Intelligence">📰</button>
                        <button onClick={() => openEditForm(stock)}      className="btn-icon" title="Edit position">✏️</button>
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

      {/* ── Add / Edit Modal ─────────────────────────────────────────────────────
          position:fixed on .modal-overlay (in CSS) ensures this always appears
          centred on the visible viewport regardless of scroll position.        */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>{formMode === 'add' ? 'Add Asset' : 'Edit Position'}</h2>
                <p className="modal-sub-label">
                  {formMode === 'add' ? 'Enter ticker details to begin tracking.' : `Editing ${formData.symbol}`}
                </p>
              </div>
              <button onClick={() => setShowForm(false)} className="btn-close">✕</button>
            </div>
            <form onSubmit={formMode === 'add' ? handleAddStock : handleEditStock}>
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
              <div className="form-actions">
                <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">
                  {formMode === 'add' ? 'Add to Portfolio' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Intelligence Modal ─────────────────────────────────────────────────── */}
      {newsModalStock && (
        <div className="modal-overlay" onClick={() => setNewsModalStock(null)}>
          <div className="modal-content news-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Intelligence · {newsModalStock.symbol}</h2>
                <p className="modal-sub-label">
                  {sig(newsModalStock.signal).label}
                  {newsModalStock.excess_return != null && ` · α ${fmtPct(newsModalStock.excess_return)}`}
                </p>
              </div>
              <button onClick={() => setNewsModalStock(null)} className="btn-close">✕</button>
            </div>
            <div className="news-container">
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
          </div>
        </div>
      )}
    </div>
  );
};

export default EnhancedPortfolioDashboard;
