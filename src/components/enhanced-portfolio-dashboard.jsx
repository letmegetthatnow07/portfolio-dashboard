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

// ── Market background — animated bull/bear candlesticks ───────────────────────
// CSS classes mkt-c1..mkt-c5 = bull (bob up), mkt-d1..mkt-d4 = bear (drop down)
// mkt-ln = rising trend line, mkt-lf = falling trend line
// Opacity 0.14–0.22 = clearly visible without competing with data
const MarketBackground = () => (
  <svg className="market-bg" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">

    {/* ── Bull candles — green, left third ── */}
    <g className="mkt-c1 mkt-gl" style={{ transformOrigin: '69px 570px' }}>
      <line x1="69" y1="455" x2="69" y2="480"  stroke="#059669" strokeWidth="2" opacity="0.22"/>
      <rect x="60" y="480" width="18" height="90"  fill="#059669" opacity="0.18" rx="2"/>
      <line x1="69" y1="570" x2="69" y2="595"  stroke="#059669" strokeWidth="2" opacity="0.22"/>
    </g>
    <g className="mkt-c2 mkt-gl" style={{ transformOrigin: '109px 550px' }}>
      <line x1="109" y1="415" x2="109" y2="440" stroke="#059669" strokeWidth="2" opacity="0.20"/>
      <rect x="100" y="440" width="18" height="110" fill="#059669" opacity="0.17" rx="2"/>
      <line x1="109" y1="550" x2="109" y2="575" stroke="#059669" strokeWidth="2" opacity="0.20"/>
    </g>
    <g className="mkt-c3 mkt-gl" style={{ transformOrigin: '149px 520px' }}>
      <line x1="149" y1="375" x2="149" y2="400" stroke="#059669" strokeWidth="2" opacity="0.20"/>
      <rect x="140" y="400" width="18" height="120" fill="#059669" opacity="0.17" rx="2"/>
      <line x1="149" y1="520" x2="149" y2="546" stroke="#059669" strokeWidth="2" opacity="0.20"/>
    </g>
    <g className="mkt-c4 mkt-gl" style={{ transformOrigin: '189px 490px' }}>
      <line x1="189" y1="335" x2="189" y2="360" stroke="#059669" strokeWidth="2" opacity="0.20"/>
      <rect x="180" y="360" width="18" height="130" fill="#059669" opacity="0.17" rx="2"/>
      <line x1="189" y1="490" x2="189" y2="516" stroke="#059669" strokeWidth="2" opacity="0.20"/>
    </g>
    <g className="mkt-c5 mkt-gl" style={{ transformOrigin: '229px 460px' }}>
      <line x1="229" y1="294" x2="229" y2="320" stroke="#059669" strokeWidth="2" opacity="0.20"/>
      <rect x="220" y="320" width="18" height="140" fill="#059669" opacity="0.17" rx="2"/>
      <line x1="229" y1="460" x2="229" y2="486" stroke="#059669" strokeWidth="2" opacity="0.20"/>
    </g>

    {/* ── Bear candles — red, right third ── */}
    <g className="mkt-d1 mkt-gl" style={{ transformOrigin: '869px 300px' }}>
      <line x1="869" y1="185" x2="869" y2="200" stroke="#dc2626" strokeWidth="2" opacity="0.18"/>
      <rect x="860" y="200" width="18" height="100" fill="#dc2626" opacity="0.15" rx="2"/>
      <line x1="869" y1="300" x2="869" y2="320" stroke="#dc2626" strokeWidth="2" opacity="0.18"/>
    </g>
    <g className="mkt-d2 mkt-gl" style={{ transformOrigin: '909px 350px' }}>
      <line x1="909" y1="225" x2="909" y2="240" stroke="#dc2626" strokeWidth="2" opacity="0.17"/>
      <rect x="900" y="240" width="18" height="110" fill="#dc2626" opacity="0.14" rx="2"/>
      <line x1="909" y1="350" x2="909" y2="372" stroke="#dc2626" strokeWidth="2" opacity="0.17"/>
    </g>
    <g className="mkt-d3 mkt-gl" style={{ transformOrigin: '949px 400px' }}>
      <line x1="949" y1="265" x2="949" y2="280" stroke="#dc2626" strokeWidth="2" opacity="0.17"/>
      <rect x="940" y="280" width="18" height="120" fill="#dc2626" opacity="0.14" rx="2"/>
      <line x1="949" y1="400" x2="949" y2="424" stroke="#dc2626" strokeWidth="2" opacity="0.17"/>
    </g>
    <g className="mkt-d4 mkt-gl" style={{ transformOrigin: '989px 430px' }}>
      <line x1="989" y1="305" x2="989" y2="320" stroke="#dc2626" strokeWidth="2" opacity="0.16"/>
      <rect x="980" y="320" width="18" height="110" fill="#dc2626" opacity="0.13" rx="2"/>
      <line x1="989" y1="430" x2="989" y2="454" stroke="#dc2626" strokeWidth="2" opacity="0.16"/>
    </g>

    {/* ── Price trend lines ── */}
    <g className="mkt-ln">
      <polyline points="40,570 120,500 200,430 280,375 360,335"
        fill="none" stroke="#059669" strokeWidth="1.8" opacity="0.20"
        strokeLinecap="round" strokeLinejoin="round"/>
    </g>
    <g className="mkt-lf">
      <polyline points="600,335 680,378 760,428 840,478 920,520 1010,558"
        fill="none" stroke="#dc2626" strokeWidth="1.8" opacity="0.17"
        strokeLinecap="round" strokeLinejoin="round"/>
    </g>

    {/* Faint grid reference lines */}
    <line x1="40" y1="300" x2="1160" y2="300" stroke="#a0a09a" strokeWidth="0.6" opacity="0.06" strokeDasharray="5 10"/>
    <line x1="40" y1="450" x2="1160" y2="450" stroke="#a0a09a" strokeWidth="0.6" opacity="0.06" strokeDasharray="5 10"/>
    <line x1="40" y1="600" x2="1160" y2="600" stroke="#a0a09a" strokeWidth="0.6" opacity="0.06" strokeDasharray="5 10"/>
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
    // Auto-refresh every 5 minutes — no manual refresh button needed
    const interval = setInterval(fetchPortfolio, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

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

      {/* ── Header — refresh button removed; auto-refresh runs every 5min ── */}
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

      {/* ── Add / Edit Modal — position:fixed in CSS ensures it centres on viewport ── */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{formMode === 'add' ? 'Add Asset' : 'Edit Position'}</h2>
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

      {/* ── Intelligence Modal ── */}
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
