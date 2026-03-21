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
const MOAT_COLOR = s => {
  if (s == null) return '#9ca3af';
  if (s >= 7)   return '#059669';
  if (s >= 5)   return '#d97706';
  return '#dc2626';
};

const sig = s => SIGNAL_CFG[s] || { color: '#6b7280', label: s || 'Pending', tier: 'flat' };
const reg = r => REGIME_CFG[r] || { color: '#6b7280', label: r || 'Normal' };

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
const fmtNum = (n, dp = 1, fallback = '—') =>
  n == null || isNaN(n) ? fallback : Number(n).toFixed(dp);

const scoreCol = s => {
  if (s == null) return '#9ca3af';
  if (s >= 8)    return '#059669';
  if (s >= 6.5)  return '#2563eb';
  if (s >= 5)    return '#d97706';
  return '#dc2626';
};

// ── Market background SVG ─────────────────────────────────────────────────────
const MarketBackground = () => (
  <svg className="market-bg" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">
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

// Moat ring — same visual as score ring but uses moat colour scale
const MoatRing = ({ score }) => {
  const r = 13, circ = 2 * Math.PI * r;
  const col = MOAT_COLOR(score);
  return (
    <div className="moat-ring" title={`Moat Score: ${score?.toFixed(1) ?? '—'}/10 — ROIC premium, gross margin, revenue durability, FCF quality`}>
      <svg width="34" height="34" viewBox="0 0 34 34">
        <circle cx="17" cy="17" r={r} fill="none" stroke="#e6e5df" strokeWidth="2"/>
        <circle cx="17" cy="17" r={r} fill="none" stroke={col} strokeWidth="2"
          strokeDasharray={`${Math.max(0,Math.min(10,score||0))/10*circ} ${circ}`}
          strokeLinecap="round" transform="rotate(-90 17 17)"
          style={{ transition: 'stroke-dasharray .5s ease' }}/>
      </svg>
      <span className="moat-ring-num" style={{ color: col }}>
        {score != null ? score.toFixed(1) : '—'}
      </span>
    </div>
  );
};

const CascadePips = ({ w1, w2, w3, w4 }) => {
  if (!w1 && !w2 && !w3 && !w4) return null;
  return (
    <div className="cascade-pips" title="W1=7d W2=21d W3=63d W4=252d">
      {[{k:'W1',on:w1,col:'#d97706'},{k:'W2',on:w2,col:'#ea580c'},{k:'W3',on:w3,col:'#dc2626'},{k:'W4',on:w4,col:'#7f1d1d'}]
        .map(p => (
          <span key={p.k} className={`pip ${p.on?'pip-on':'pip-off'}`}
            style={p.on?{background:p.col,borderColor:p.col}:{}}>
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
        <div className="spring-fill" style={{ width:`${Math.min(days,3)/3*100}%`, background:col }}/>
      </div>
      <span className="spring-label" style={{ color:col }}>
        {days >= 3 ? '🌱 Confirmed' : `🌱 Day ${days}/3`}
      </span>
    </div>
  );
};

// ── Detail Panel — expands below a row to show all new metrics ────────────────
const DetailPanel = ({ stock }) => {
  const hasMoat    = stock.moat_score != null;
  const hasFcfY    = stock.fcf_yield != null;
  const hasEvFcf   = stock.ev_fcf != null;
  const hasMaxDD   = stock.max_drawdown != null;
  const hasSbc     = stock.sbc_to_market_cap != null;
  const hasRevG3y  = stock.revenue_growth_3y != null;
  const hasRevGYoy = stock.revenue_growth_pct != null;
  const hasGM      = stock.gross_margin_pct != null;
  const hasFilS    = stock.filing_sentiment != null;

  const Metric = ({ label, value, color, note, good, bad }) => {
    let col = 'var(--text-main)';
    if (good != null && value != null) col = value >= good ? '#059669' : value <= bad ? '#dc2626' : '#d97706';
    return (
      <div className="detail-metric">
        <div className="detail-metric-label">{label}</div>
        <div className="detail-metric-value" style={{ color: color || col }}>{value ?? '—'}</div>
        {note && <div className="detail-metric-note">{note}</div>}
      </div>
    );
  };

  const fcfYieldPct   = hasFcfY  ? (stock.fcf_yield * 100).toFixed(1) + '%' : null;
  const maxDDLabel    = hasMaxDD ? `${stock.max_drawdown.toFixed(1)}%` : null;
  const sbcLabel      = hasSbc   ? `${Number(stock.sbc_to_market_cap).toFixed(2)}% of mkt cap` : null;
  const filSentLabel  = hasFilS  ? `${Number(stock.filing_sentiment).toFixed(1)}/10` : null;
  const evFcfLabel    = hasEvFcf ? `${Number(stock.ev_fcf).toFixed(0)}×` : null;

  return (
    <tr className="detail-row">
      <td colSpan={7}>
        <div className="detail-panel">

          {/* Moat breakdown */}
          <div className="detail-section">
            <div className="detail-section-head">
              <span className="detail-section-title">🏰 Moat &amp; Quality</span>
              <span className="detail-section-sub">Sustainable competitive advantage indicators</span>
            </div>
            <div className="detail-metrics-grid">
              {hasMoat && (
                <div className="detail-metric detail-metric-featured">
                  <div className="detail-metric-label">Moat Score</div>
                  <MoatRing score={stock.moat_score}/>
                  <div className="detail-metric-note">ROIC · Gross Margin · Rev CAGR · FCF Quality</div>
                </div>
              )}
              <Metric label="Gross Margin" value={hasGM ? `${fmtNum(stock.gross_margin_pct)}%` : null}
                good={50} bad={20}
                note=">50% = strong pricing power"/>
              <Metric label="Rev Growth YoY" value={hasRevGYoy ? fmtPct(stock.revenue_growth_pct) : null}
                good={15} bad={0}
                note="Current year velocity"/>
              <Metric label="Rev Growth 3Y CAGR" value={hasRevG3y ? fmtPct(stock.revenue_growth_3y) : null}
                good={15} bad={0}
                note="Durability confirmation"/>
              {hasFilS && (
                <Metric label={`Filing Tone (${stock.filing_form || '10-K/Q'})`}
                  value={filSentLabel}
                  good={6} bad={4}
                  note="Loughran-McDonald sentiment on SEC filing language"/>
              )}
            </div>
          </div>

          {/* Valuation */}
          <div className="detail-section">
            <div className="detail-section-head">
              <span className="detail-section-title">💰 Valuation &amp; Cash</span>
              <span className="detail-section-sub">Are you paying a fair price for the moat?</span>
            </div>
            <div className="detail-metrics-grid">
              <Metric label="FCF Yield" value={fcfYieldPct}
                good={5} bad={1}
                note=">5% = attractive, <1% = expensive"/>
              <Metric label="EV / FCF" value={evFcfLabel}
                color={hasEvFcf ? (stock.ev_fcf < 20 ? '#059669' : stock.ev_fcf < 40 ? '#d97706' : '#dc2626') : null}
                note="<20× cheap, 20–40× fair, >40× expensive"/>
              {hasSbc && (
                <Metric label="SBC Dilution" value={sbcLabel}
                  color={stock.sbc_to_market_cap > 3 ? '#dc2626' : stock.sbc_to_market_cap > 1 ? '#d97706' : '#059669'}
                  note=">3% = high dilution risk; adjusts FCF quality"/>
              )}
            </div>
          </div>

          {/* Risk */}
          <div className="detail-section">
            <div className="detail-section-head">
              <span className="detail-section-title">⚠️ Risk Context</span>
              <span className="detail-section-sub">Downside characteristics — not triggers, but context</span>
            </div>
            <div className="detail-metrics-grid">
              <Metric label="Max Drawdown (1Y)" value={maxDDLabel}
                color={hasMaxDD ? (stock.max_drawdown > -20 ? '#059669' : stock.max_drawdown > -40 ? '#d97706' : '#dc2626') : null}
                note="Peak-to-trough over trailing 252 days"/>
              <Metric label="Beta (63d)" value={stock.beta != null ? Number(stock.beta).toFixed(2) : null}
                note="Market sensitivity. >1.5 = high volatility"/>
              <Metric label="Excess Return (21d)" value={fmtPct(stock.excess_return)}
                color={stock.excess_return != null ? (stock.excess_return >= 0 ? '#059669' : '#dc2626') : null}
                note="Alpha over SPY after beta adjustment"/>
            </div>
          </div>

        </div>
      </td>
    </tr>
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
  const [expandedId,   setExpandedId]   = useState(null); // which row is expanded
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
      const res = await fetch('/api/portfolio');
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      if (data.status === 'success') {
        setPortfolio([...data.portfolio].sort((a,b) => (b.latest_score||0)-(a.latest_score||0)));
        setStats(data.stats);
        setLastUpdate(new Date(data.timestamp));
      }
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    fetchPortfolio();
    const iv = setInterval(fetchPortfolio, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  const handleAddStock = async (e) => {
    e.preventDefault();
    if (!formData.symbol || !formData.quantity || !formData.average_price) return;
    const res = await fetch('/api/portfolio/add', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(formData)
    });
    if (res.ok) { setShowForm(false); fetchPortfolio(); }
  };

  const handleEditStock = async (e) => {
    e.preventDefault();
    const res = await fetch(`/api/portfolio/edit/${editingId}`, {
      method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(formData)
    });
    if (res.ok) { setShowForm(false); setEditingId(null); fetchPortfolio(); }
  };

  const handleDeleteStock = async (id) => {
    if (!window.confirm('Remove this asset from the portfolio?')) return;
    const res = await fetch(`/api/portfolio/delete/${id}`, { method:'DELETE' });
    if (res.ok) fetchPortfolio();
  };

  const openEditForm = (stock) => {
    setFormMode('edit'); setEditingId(stock.id);
    setFormData({ symbol:stock.symbol, name:stock.name||'',
      quantity:stock.quantity.toString(), average_price:stock.average_price.toString(),
      type:stock.type||'Stock', region:stock.region||'Global', sector:stock.sector||'' });
    setShowForm(true);
  };

  const openAddForm = () => {
    setFormMode('add'); setEditingId(null);
    setFormData({ symbol:'', name:'', quantity:'', average_price:'', type:'Stock', region:'Global', sector:'' });
    setShowForm(true);
  };

  const getFilteredPortfolio = () => {
    let f = portfolio;
    if (filterSignal === 'BULLISH')  f = f.filter(s => ['ADD','SPRING_CONFIRMED','SPRING_CANDIDATE','STRONG_BUY','BUY'].includes(s.signal));
    else if (filterSignal === 'NOISE') f = f.filter(s => ['HOLD_NOISE','MARKET_NOISE','HOLD','NORMAL'].includes(s.signal) || s.regime === 'MARKET_NOISE');
    else if (filterSignal === 'BEARISH') f = f.filter(s => ['WATCH','TRIM_25','REDUCE','SELL','IDIOSYNCRATIC_DECAY'].includes(s.signal));
    else if (filterSignal !== 'ALL') f = f.filter(s => s.signal === filterSignal || s.regime === filterSignal);
    return f.sort((a,b) => {
      if (sortBy === 'alpha')  return (b.excess_return||0)-(a.excess_return||0);
      if (sortBy === 'moat')   return (b.moat_score||0)-(a.moat_score||0);
      if (sortBy === 'symbol') return a.symbol.localeCompare(b.symbol);
      if (sortBy === 'pnl') {
        return ((b.current_price||0)-(b.average_price||0))*(b.quantity||0) -
               ((a.current_price||0)-(a.average_price||0))*(a.quantity||0);
      }
      return (b.latest_score||0)-(a.latest_score||0);
    });
  };

  const fp = getFilteredPortfolio();
  const totalVal  = portfolio.reduce((s,x) => s + ((x.current_price||0)*(x.quantity||0)), 0);
  const totalCost = portfolio.reduce((s,x) => s + ((x.average_price||0)*(x.quantity||0)), 0);
  const totalPnL  = totalVal - totalCost;
  const totalPnLPct = totalCost > 0 ? (totalPnL/totalCost)*100 : 0;
  const totalDayChange = portfolio.reduce((s,x) => {
    if (!x.current_price || x.change_percent == null || !x.quantity) return s;
    return s + (x.current_price - x.current_price/(1+x.change_percent/100)) * x.quantity;
  }, 0);
  const totalDayPct = totalVal > 0
    ? portfolio.reduce((s,x) => {
        if (!x.current_price || x.change_percent == null || !x.quantity) return s;
        return s + x.change_percent * ((x.current_price*x.quantity)/totalVal);
      }, 0) : 0;

  const avgScore  = portfolio.length ? (portfolio.reduce((s,x)=>s+(x.latest_score||0),0)/portfolio.length).toFixed(1) : '—';
  const bullCount = portfolio.filter(s => ['ADD','SPRING_CONFIRMED','SPRING_CANDIDATE','STRONG_BUY','BUY'].includes(s.signal)).length;
  const bearCount = portfolio.filter(s => ['WATCH','TRIM_25','REDUCE','SELL','IDIOSYNCRATIC_DECAY'].includes(s.signal)).length;

  if (loading && portfolio.length === 0) return (
    <div className="dashboard-container">
      <MarketBackground/>
      <div className="loading-wrap"><div className="loading-ring"/></div>
    </div>
  );

  return (
    <div className="dashboard-container">
      <MarketBackground/>

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

      {/* Stats */}
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

      {/* Controls */}
      <div className="controls-section">
        <div className="filter-pills">
          {[{v:'ALL',l:'All'},{v:'BULLISH',l:'▲ Bullish'},{v:'NOISE',l:'— Noise'},{v:'BEARISH',l:'▼ Decay'}]
            .map(({v,l}) => (
              <button key={v} className={`pill ${filterSignal===v?'pill-active':''} pill-${v.toLowerCase()}`}
                onClick={() => setFilterSignal(v)}>{l}</button>
            ))}
        </div>
        <select className="minimal-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="score">Quality Score</option>
          <option value="moat">Moat Score</option>
          <option value="alpha">Jensen's Alpha</option>
          <option value="pnl">Unrealized P&amp;L</option>
          <option value="symbol">Symbol A–Z</option>
        </select>
        <div className="results-count">{fp.length} Assets · click row to expand</div>
      </div>

      {/* Table */}
      <div className="portfolio-section">
        {fp.length === 0 ? (
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
                  <th>Asset</th>
                  <th>Price &amp; P&amp;L</th>
                  <th>Quality</th>
                  <th>Moat</th>
                  <th>Regime &amp; α</th>
                  <th>Signal</th>
                  <th>Value</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {fp.map(stock => {
                  const tv   = (parseFloat(stock.current_price)||0) * (parseFloat(stock.quantity)||0);
                  const pd   = ((stock.current_price||0)-(stock.average_price||0)) * (stock.quantity||0);
                  const pp   = stock.average_price > 0
                    ? ((stock.current_price-stock.average_price)/stock.average_price)*100 : null;
                  const sCfg = sig(stock.signal);
                  const rCfg = reg(stock.regime);
                  const isExpanded = expandedId === stock.id;

                  return (
                    <React.Fragment key={stock.id}>
                      <tr
                        className={`row-${sCfg.tier} ${isExpanded ? 'row-expanded' : ''}`}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setExpandedId(isExpanded ? null : stock.id)}
                      >
                        {/* Asset */}
                        <td>
                          <div style={{display:'flex',alignItems:'center',gap:6}}>
                            <span className="row-expand-icon">{isExpanded ? '▾' : '▸'}</span>
                            <div>
                              <strong className="stock-symbol">{stock.symbol}</strong>
                              {stock.name && <div className="stock-name">{stock.name}</div>}
                              {stock.sector && <span className="sector-pill">{stock.sector}</span>}
                            </div>
                          </div>
                        </td>

                        {/* Price */}
                        <td onClick={e => e.stopPropagation()}>
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

                        {/* Quality score */}
                        <td>
                          <div style={{display:'flex',alignItems:'center',gap:5}}>
                            <ScoreRing score={stock.latest_score}/>
                            {stock.capex_exception && (
                              <span className="capex-flag" title="Capex Exception: Strategic reinvestment — FCF penalty forgiven">🏗️</span>
                            )}
                          </div>
                        </td>

                        {/* Moat score — new column */}
                        <td>
                          {stock.moat_score != null
                            ? <MoatRing score={stock.moat_score}/>
                            : <span style={{color:'var(--text-dim)',fontSize:11}}>—</span>
                          }
                        </td>

                        {/* Regime */}
                        <td>
                          <div className="regime-name" style={{color:rCfg.color}}>{rCfg.label}</div>
                          {stock.excess_return != null && (
                            <div className={`alpha-val change ${stock.excess_return>=0?'positive':'negative'}`}>
                              α {fmtPct(stock.excess_return)}
                            </div>
                          )}
                          {stock.beta != null && <div className="beta-val">β {Number(stock.beta).toFixed(2)}</div>}
                        </td>

                        {/* Signal */}
                        <td>
                          <span className="signal-badge" style={{
                            color: sCfg.color,
                            backgroundColor: `${sCfg.color}14`,
                            borderColor: `${sCfg.color}30`,
                          }}>{sCfg.label}</span>
                          <SpringBar days={stock.spring_days}/>
                          <CascadePips w1={stock.w1_signal} w2={stock.w2_confirmed} w3={stock.w3_confirmed} w4={stock.w4_confirmed}/>
                        </td>

                        {/* Value */}
                        <td>
                          <div className="price-value">{fmtUSD(tv)}</div>
                          {totalVal > 0 && <div className="weight-pct">{((tv/totalVal)*100).toFixed(1)}%</div>}
                        </td>

                        {/* Actions — stopPropagation so clicks don't toggle expand */}
                        <td className="col-actions" onClick={e => e.stopPropagation()}>
                          <button onClick={() => setNewsModalStock(stock)} className="btn-icon" title="Intelligence">📰</button>
                          <button onClick={() => openEditForm(stock)}      className="btn-icon" title="Edit">✏️</button>
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

      {/* Add/Edit modal */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{formMode === 'add' ? 'Add Asset' : 'Edit Position'}</h2>
              <button onClick={() => setShowForm(false)} className="btn-close">✕</button>
            </div>
            <form onSubmit={formMode === 'add' ? handleAddStock : handleEditStock}>
              <div className="form-grid">
                {[
                  {l:'Symbol',  k:'symbol',        ph:'e.g. CRWD',       dis:formMode==='edit', up:v=>v.toUpperCase()},
                  {l:'Name',    k:'name',           ph:'Company name'},
                  {l:'Quantity',k:'quantity',       ph:'',  t:'number'},
                  {l:'Avg Cost',k:'average_price',  ph:'',  t:'number'},
                  {l:'Sector',  k:'sector',         ph:'e.g. Technology'},
                ].map(({l,k,ph,t,dis,up}) => (
                  <div key={k} className="form-group">
                    <label>{l}</label>
                    <input type={t||'text'} step={t?'0.01':undefined} placeholder={ph}
                      value={formData[k]} disabled={dis}
                      onChange={e => setFormData({...formData, [k]: up ? up(e.target.value) : e.target.value})}/>
                  </div>
                ))}
                <div className="form-group">
                  <label>Region</label>
                  <select value={formData.region} onChange={e => setFormData({...formData, region:e.target.value})}>
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

      {/* Intelligence modal */}
      {newsModalStock && (
        <div className="modal-overlay" onClick={() => setNewsModalStock(null)}>
          <div className="modal-content news-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Intelligence · {newsModalStock.symbol}</h2>
                <p className="modal-sub-label">
                  {sig(newsModalStock.signal).label}
                  {newsModalStock.excess_return != null && ` · α ${fmtPct(newsModalStock.excess_return)}`}
                  {newsModalStock.moat_score != null && ` · Moat ${newsModalStock.moat_score.toFixed(1)}/10`}
                </p>
              </div>
              <button onClick={() => setNewsModalStock(null)} className="btn-close">✕</button>
            </div>
            <div className="news-container">
              {newsModalStock.recent_news?.length > 0 ? (
                newsModalStock.recent_news.map((n,i) => (
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
