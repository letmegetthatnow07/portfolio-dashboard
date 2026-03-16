import React, { useState, useEffect } from 'react';
import './enhanced-portfolio-dashboard.css';
import CorrelationHeatmap from './CorrelationHeatmap';

// ─── Signal & Regime config ────────────────────────────────────────────────────
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

const sig = (s) => SIGNAL_CFG[s] || { color: '#6b7280', label: s || 'Pending', tier: 'flat' };
const reg = (r) => REGIME_CFG[r] || { color: '#6b7280', label: r  || 'Normal' };

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtUSD = (n) => {
  if (n == null || isNaN(n)) return 'N/A';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
};

const fmtPct = (n, dp = 2) => {
  if (n == null || isNaN(n)) return null;
  return `${n >= 0 ? '+' : ''}${Number(n).toFixed(dp)}%`;
};

const scoreCol = (s) => {
  if (s == null) return '#9ca3af';
  if (s >= 8)    return '#059669';
  if (s >= 6.5)  return '#2563eb';
  if (s >= 5)    return '#d97706';
  return '#dc2626';
};

// ─── Sub-components ────────────────────────────────────────────────────────────

// SVG ring — replaces old flat score-badge
const ScoreRing = ({ score }) => {
  const r = 17, circ = 2 * Math.PI * r;
  const pct  = Math.max(0, Math.min(10, score || 0)) / 10;
  const dash = pct * circ;
  const col  = scoreCol(score);
  return (
    <div className="score-ring" title={`Quality Score: ${score?.toFixed(1) ?? '—'}/10`}>
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r={r} fill="none" stroke="#e8e8e4" strokeWidth="2.5" />
        <circle
          cx="22" cy="22" r={r} fill="none"
          stroke={col} strokeWidth="2.5"
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          transform="rotate(-90 22 22)"
          style={{ transition: 'stroke-dasharray .5s ease' }}
        />
      </svg>
      <span className="score-ring-num" style={{ color: col }}>
        {score != null ? score.toFixed(1) : '—'}
      </span>
    </div>
  );
};

// W1–W4 pips — only rendered when at least one window is active
const CascadePips = ({ w1, w2, w3, w4 }) => {
  if (!w1 && !w2 && !w3 && !w4) return null;
  const pips = [
    { k: 'W1', on: w1, col: '#d97706' },
    { k: 'W2', on: w2, col: '#ea580c' },
    { k: 'W3', on: w3, col: '#dc2626' },
    { k: 'W4', on: w4, col: '#7f1d1d' },
  ];
  return (
    <div className="cascade-pips" title="W1=7d  W2=21d  W3=63d  W4=252d">
      {pips.map(p => (
        <span
          key={p.k}
          className={`pip ${p.on ? 'pip-on' : 'pip-off'}`}
          style={p.on ? { background: p.col, borderColor: p.col } : {}}
        >{p.k}</span>
      ))}
    </div>
  );
};

// Spring bar — only rendered when spring_days > 0
const SpringBar = ({ days }) => {
  if (!days || days <= 0) return null;
  const col = days >= 3 ? '#047857' : '#10b981';
  return (
    <div className="spring-bar">
      <div className="spring-track">
        <div className="spring-fill" style={{ width: `${Math.min(days, 3) / 3 * 100}%`, background: col }} />
      </div>
      <span className="spring-label" style={{ color: col }}>
        {days >= 3 ? '🌱 Confirmed' : `🌱 Day ${days}/3`}
      </span>
    </div>
  );
};

// ─── Main component ────────────────────────────────────────────────────────────
const EnhancedPortfolioDashboard = () => {

  // State — same shape as old code, API contract unchanged
  const [portfolio,    setPortfolio]    = useState([]);
  const [stats,        setStats]        = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [lastUpdate,   setLastUpdate]   = useState(null);
  const [sortBy,       setSortBy]       = useState('score');
  const [filterSignal, setFilterSignal] = useState('ALL');

  const [showForm,   setShowForm]   = useState(false);
  const [formMode,   setFormMode]   = useState('add');
  const [formData,   setFormData]   = useState({
    symbol: '', name: '', quantity: '', average_price: '',
    type: 'Stock', region: 'Global', sector: ''
  });
  const [editingId,      setEditingId]      = useState(null);
  const [newsModalStock, setNewsModalStock] = useState(null);

  // ── Fetch — identical to old code ───────────────────────────────────────────
  const fetchPortfolio = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/portfolio');
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      if (data.status === 'success') {
        const sorted = [...data.portfolio].sort(
          (a, b) => (b.latest_score || 0) - (a.latest_score || 0)
        );
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

  // ── CRUD — identical to old code ────────────────────────────────────────────
  const handleAddStock = async (e) => {
    e.preventDefault();
    if (!formData.symbol || !formData.quantity || !formData.average_price) return;
    try {
      const res = await fetch('/api/portfolio/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      if (res.ok) { setShowForm(false); fetchPortfolio(); }
    } catch (err) { console.error(err); }
  };

  const handleEditStock = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`/api/portfolio/edit/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      if (res.ok) { setShowForm(false); setEditingId(null); fetchPortfolio(); }
    } catch (err) { console.error(err); }
  };

  const handleDeleteStock = async (id) => {
    if (!window.confirm('Are you sure you want to delete this stock?')) return;
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
      type: stock.type || 'Stock', region: stock.region || 'Global',
      sector: stock.sector || ''
    });
    setShowForm(true);
  };

  const openAddForm = () => {
    setFormMode('add'); setEditingId(null);
    setFormData({ symbol: '', name: '', quantity: '', average_price: '', type: 'Stock', region: 'Global', sector: '' });
    setShowForm(true);
  };

  // ── Filter & sort — old logic kept, new signal names added ──────────────────
  const getFilteredPortfolio = () => {
    let filtered = portfolio;

    if (filterSignal !== 'ALL') {
      if (filterSignal === 'BULLISH') {
        filtered = filtered.filter(s =>
          ['ADD','SPRING_CONFIRMED','SPRING_CANDIDATE','STRONG_BUY','BUY'].includes(s.signal)
        );
      } else if (filterSignal === 'NOISE') {
        filtered = filtered.filter(s =>
          ['HOLD_NOISE','MARKET_NOISE','HOLD','NORMAL'].includes(s.signal) ||
          s.regime === 'MARKET_NOISE'
        );
      } else if (filterSignal === 'BEARISH') {
        filtered = filtered.filter(s =>
          ['WATCH','TRIM_25','REDUCE','SELL','IDIOSYNCRATIC_DECAY'].includes(s.signal)
        );
      } else {
        // old single-value filter — backward compat
        filtered = filtered.filter(s => s.signal === filterSignal || s.regime === filterSignal);
      }
    }

    return filtered.sort((a, b) => {
      switch (sortBy) {
        case 'score':  return (b.latest_score  || 0) - (a.latest_score  || 0);
        case 'upside': return (b.upside_downside_percent || 0) - (a.upside_downside_percent || 0); // old key
        case 'alpha':  return (b.excess_return || 0) - (a.excess_return || 0);
        case 'symbol': return a.symbol.localeCompare(b.symbol);
        case 'pnl': {
          const pA = ((a.current_price||0)-(a.average_price||0))*(a.quantity||0);
          const pB = ((b.current_price||0)-(b.average_price||0))*(b.quantity||0);
          return pB - pA;
        }
        default: return 0;
      }
    });
  };

  const filteredPortfolio = getFilteredPortfolio();

  // Computed stats — supplement/replace API stats object
  const totalVal  = portfolio.reduce((s, x) => s + ((x.current_price||0)*(x.quantity||0)), 0);
  const avgScore  = portfolio.length
    ? (portfolio.reduce((s, x) => s + (x.latest_score||0), 0) / portfolio.length).toFixed(1)
    : '—';
  const bullCount = portfolio.filter(s => ['ADD','SPRING_CONFIRMED','SPRING_CANDIDATE','STRONG_BUY','BUY'].includes(s.signal)).length;
  const bearCount = portfolio.filter(s => ['WATCH','TRIM_25','REDUCE','SELL','IDIOSYNCRATIC_DECAY'].includes(s.signal)).length;

  // Kept for backward compat
  const getSignalColor = (signal) => sig(signal).color;
  const formatPrice    = (num) => fmtUSD(num);

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (loading && portfolio.length === 0) {
    return (
      <div className="dashboard-container">
        <div className="loading-wrap"><div className="loading-ring" /></div>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="dashboard-container">

      {/* ── Header ── */}
      <div className="dashboard-header">
        <div>
          <h1>Alpha Compounder</h1>
          <p className="subtitle">Regime-Aware · Long-Horizon · Fundamentals-First</p>
        </div>
        <div className="header-actions">
          {lastUpdate && (
            <div className="last-update">
              <span className="live-dot" />
              Updated: {lastUpdate.toLocaleTimeString()}
            </div>
          )}
          <button onClick={openAddForm} className="btn-primary">+ Add Asset</button>
          <button onClick={fetchPortfolio} className="btn-secondary" disabled={loading}>
            {loading ? '…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* ── Stats ── */}
      <div className="summary-section">
        <div className="stats-grid">
          <div className="stat-card accent-card">
            <div className="stat-label">Portfolio Value</div>
            <div className="stat-value">{fmtUSD(stats?.totalValue ?? totalVal)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Avg Quality Score</div>
            <div className="stat-value" style={{ color: scoreCol(parseFloat(stats?.averageScore ?? avgScore)) }}>
              {stats?.averageScore ?? avgScore}<span className="stat-unit">/10</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Alpha / Spring</div>
            <div className="stat-value" style={{ color: bullCount > 0 ? 'var(--color-strong-buy)' : 'var(--text-muted)' }}>
              {stats?.strongBuys ?? bullCount}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Decay Warnings</div>
            <div className="stat-value" style={{ color: bearCount > 0 ? 'var(--color-reduce)' : 'var(--text-muted)' }}>
              {stats?.buys ?? bearCount}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Positions</div>
            <div className="stat-value">{portfolio.length}</div>
          </div>
        </div>
      </div>

      {/* ── Controls ── */}
      <div className="controls-section">
        <div className="filter-pills">
          {[
            { v: 'ALL',     label: 'All'       },
            { v: 'BULLISH', label: '▲ Bullish' },
            { v: 'NOISE',   label: '— Noise'   },
            { v: 'BEARISH', label: '▼ Decay'   },
          ].map(({ v, label }) => (
            <button
              key={v}
              className={`pill ${filterSignal === v ? 'pill-active' : ''} pill-${v.toLowerCase()}`}
              onClick={() => setFilterSignal(v)}
            >{label}</button>
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
            <button className="btn-secondary" style={{ padding: '6px 14px' }} onClick={() => setFilterSignal('ALL')}>
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
                  <th>Regime &amp; α</th>
                  <th>Signal</th>
                  <th>Total Value</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredPortfolio.map((stock) => {
                  const totalValue   = (parseFloat(stock.current_price)||0) * (parseFloat(stock.quantity)||0);
                  const profitDollar = ((stock.current_price||0)-(stock.average_price||0)) * (stock.quantity||0);
                  const profitPct    = stock.average_price > 0
                    ? ((stock.current_price - stock.average_price) / stock.average_price) * 100
                    : null;
                  const isProfit = profitDollar >= 0;
                  const sCfg    = sig(stock.signal);
                  const rCfg    = reg(stock.regime);

                  return (
                    <tr key={stock.id} className={`row-${sCfg.tier}`}>

                      {/* Asset — symbol + name + sector tag */}
                      <td>
                        <strong className="stock-symbol">{stock.symbol}</strong>
                        {stock.name && <div className="stock-name">{stock.name}</div>}
                        {stock.sector && <span className="sector-pill">{stock.sector}</span>}
                      </td>

                      {/* Price & P&L — old intraday % + old unrealized P&L, both kept */}
                      <td>
                        <div className="price-value">{fmtUSD(stock.current_price)}</div>
                        {stock.change_percent != null && (
                          <div className={`change ${stock.change_percent >= 0 ? 'positive' : 'negative'}`}>
                            {stock.change_percent >= 0 ? '+' : ''}{stock.change_percent.toFixed(2)}% today
                          </div>
                        )}
                        {stock.average_price > 0 && stock.current_price > 0 && (
                          <div className={`change ${isProfit ? 'positive' : 'negative'}`} style={{ fontWeight: 600, marginTop: 4 }}>
                            {isProfit ? '▲' : '▼'} {fmtUSD(Math.abs(profitDollar))}
                            {profitPct != null && (
                              <span style={{ opacity: 0.75 }}> ({fmtPct(profitPct)})</span>
                            )}
                          </div>
                        )}
                      </td>

                      {/* Quality — SVG ring replaces flat badge */}
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <ScoreRing score={stock.latest_score} />
                          {stock.capex_exception && (
                            <span className="capex-flag" title="Capex Exception: Strategic investment. FCF penalty forgiven.">
                              🏗️
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Regime & Alpha — new columns */}
                      <td>
                        <div className="regime-name" style={{ color: rCfg.color }}>{rCfg.label}</div>
                        {stock.excess_return != null && (
                          <div className={`alpha-val change ${stock.excess_return >= 0 ? 'positive' : 'negative'}`}>
                            α {fmtPct(stock.excess_return)}
                          </div>
                        )}
                        {stock.beta != null && (
                          <div className="beta-val">β {Number(stock.beta).toFixed(2)}</div>
                        )}
                      </td>

                      {/* Signal — badge + spring bar + cascade pips */}
                      <td>
                        <span
                          className="signal-badge"
                          style={{
                            color:           sCfg.color,
                            backgroundColor: `${sCfg.color}14`,
                            borderColor:     `${sCfg.color}30`,
                          }}
                        >
                          {sCfg.label}
                        </span>
                        <SpringBar days={stock.spring_days} />
                        <CascadePips
                          w1={stock.w1_signal}
                          w2={stock.w2_confirmed}
                          w3={stock.w3_confirmed}
                          w4={stock.w4_confirmed}
                        />
                      </td>

                      {/* Total Value + weight */}
                      <td>
                        <div className="price-value">{fmtUSD(totalValue)}</div>
                        {totalVal > 0 && (
                          <div className="weight-pct">{((totalValue / totalVal) * 100).toFixed(1)}%</div>
                        )}
                      </td>

                      {/* Actions — identical to old code */}
                      <td className="col-actions">
                        <button onClick={() => setNewsModalStock(stock)} className="btn-icon" title="View Intelligence">📰</button>
                        <button onClick={() => openEditForm(stock)}      className="btn-icon" title="Edit">✏️</button>
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

      {/* Heatmap — untouched */}
      <CorrelationHeatmap />

      {/* ── Add / Edit modal — same fields as old code ── */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{formMode === 'add' ? 'Add Asset' : 'Edit Asset'}</h2>
              <button onClick={() => setShowForm(false)} className="btn-close">✕</button>
            </div>
            <form onSubmit={formMode === 'add' ? handleAddStock : handleEditStock}>
              <div className="form-grid">
                <div className="form-group">
                  <label>Symbol</label>
                  <input type="text" placeholder="e.g. CRWD" value={formData.symbol}
                    onChange={e => setFormData({ ...formData, symbol: e.target.value.toUpperCase() })}
                    disabled={formMode === 'edit'} />
                </div>
                <div className="form-group">
                  <label>Name</label>
                  <input type="text" placeholder="Company name" value={formData.name}
                    onChange={e => setFormData({ ...formData, name: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Quantity</label>
                  <input type="number" step="0.01" value={formData.quantity}
                    onChange={e => setFormData({ ...formData, quantity: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Average Price</label>
                  <input type="number" step="0.01" value={formData.average_price}
                    onChange={e => setFormData({ ...formData, average_price: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Sector</label>
                  <input type="text" placeholder="e.g. Technology" value={formData.sector}
                    onChange={e => setFormData({ ...formData, sector: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Region</label>
                  <select value={formData.region} onChange={e => setFormData({ ...formData, region: e.target.value })}>
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

      {/* ── Intelligence modal ── */}
      {newsModalStock && (
        <div className="modal-overlay" onClick={() => setNewsModalStock(null)}>
          <div className="modal-content news-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h2>Latest Intelligence: {newsModalStock.symbol}</h2>
                <p className="modal-sub-label">
                  {sig(newsModalStock.signal).label}
                  {newsModalStock.excess_return != null && ` · α ${fmtPct(newsModalStock.excess_return)}`}
                </p>
              </div>
              <button onClick={() => setNewsModalStock(null)} className="btn-close">✕</button>
            </div>
            <div className="news-container">
              {newsModalStock.recent_news?.length > 0 ? (
                newsModalStock.recent_news.map((news, idx) => (
                  <a href={news.url} target="_blank" rel="noopener noreferrer" key={idx} className="news-card">
                    <span className="news-date">
                      {new Date(news.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                    <h3 className="news-headline">{news.headline}</h3>
                    {news.description && (
                      <p className="news-desc">{news.description.substring(0, 150)}…</p>
                    )}
                  </a>
                ))
              ) : (
                <p className="no-news">No actionable intelligence found for this asset in the current cycle.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EnhancedPortfolioDashboard;
