/**
 * Enhanced Portfolio Dashboard - WITH ADD/EDIT STOCKS
 * Professional investment dashboard with composite scores
 * Displays portfolio with real data from 6 APIs
 * Allows add/edit/delete stocks
 */

import React, { useState, useEffect } from 'react';
import './enhanced-portfolio-dashboard.css';

const EnhancedPortfolioDashboard = () => {
  // ============================================
  // STATE
  // ============================================
  
  const [portfolio, setPortfolio] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [sortBy, setSortBy] = useState('score');
  const [filterSignal, setFilterSignal] = useState('ALL');
  
  // Form state for adding/editing stocks
  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState('add'); // 'add' or 'edit'
  const [formData, setFormData] = useState({
    symbol: '',
    name: '',
    quantity: '',
    average_price: '',
    type: 'Stock',
    region: 'Global',
    sector: ''
  });
  const [editingId, setEditingId] = useState(null);

  // ============================================
  // FETCH PORTFOLIO DATA
  // ============================================

  const fetchPortfolio = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch('/api/portfolio');
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();

      if (data.status === 'success') {
        const sorted = [...data.portfolio].sort((a, b) => 
          (b.latest_score || 0) - (a.latest_score || 0)
        );
        
        setPortfolio(sorted);
        setStats(data.stats);
        setLastUpdate(new Date(data.timestamp));
      } else {
        throw new Error('Invalid response format');
      }
    } catch (err) {
      console.error('Error fetching portfolio:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ============================================
  // EFFECTS
  // ============================================

  useEffect(() => {
    fetchPortfolio();
    const interval = setInterval(fetchPortfolio, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // ============================================
  // ADD/EDIT STOCK HANDLERS
  // ============================================

  const handleAddStock = async (e) => {
    e.preventDefault();

    if (!formData.symbol || !formData.quantity || !formData.average_price) {
      alert('Please fill all required fields');
      return;
    }

    try {
      const response = await fetch('/api/portfolio/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });

      if (response.ok) {
        alert('Stock added successfully! Dashboard will update in next refresh.');
        setFormData({
          symbol: '',
          name: '',
          quantity: '',
          average_price: '',
          type: 'Stock',
          region: 'Global',
          sector: ''
        });
        setShowForm(false);
        fetchPortfolio();
      } else {
        alert('Error adding stock. Check console for details.');
      }
    } catch (err) {
      alert('Error adding stock: ' + err.message);
    }
  };

  const handleEditStock = async (e) => {
    e.preventDefault();

    try {
      const response = await fetch(`/api/portfolio/edit/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });

      if (response.ok) {
        alert('Stock updated successfully!');
        setFormData({
          symbol: '',
          name: '',
          quantity: '',
          average_price: '',
          type: 'Stock',
          region: 'Global',
          sector: ''
        });
        setShowForm(false);
        setEditingId(null);
        fetchPortfolio();
      } else {
        alert('Error editing stock.');
      }
    } catch (err) {
      alert('Error editing stock: ' + err.message);
    }
  };

  const handleDeleteStock = async (id) => {
    if (!window.confirm('Are you sure you want to delete this stock?')) return;

    try {
      const response = await fetch(`/api/portfolio/delete/${id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        alert('Stock deleted successfully!');
        fetchPortfolio();
      } else {
        alert('Error deleting stock.');
      }
    } catch (err) {
      alert('Error deleting stock: ' + err.message);
    }
  };

  const openEditForm = (stock) => {
    setFormMode('edit');
    setEditingId(stock.id);
    setFormData({
      symbol: stock.symbol,
      name: stock.name || '',
      quantity: stock.quantity.toString(),
      average_price: stock.average_price.toString(),
      type: stock.type || 'Stock',
      region: stock.region || 'Global',
      sector: stock.sector || ''
    });
    setShowForm(true);
  };

  const openAddForm = () => {
    setFormMode('add');
    setEditingId(null);
    setFormData({
      symbol: '',
      name: '',
      quantity: '',
      average_price: '',
      type: 'Stock',
      region: 'Global',
      sector: ''
    });
    setShowForm(true);
  };

  // ============================================
  // FILTER & SORT
  // ============================================

  const getFilteredPortfolio = () => {
    let filtered = portfolio;

    if (filterSignal !== 'ALL') {
      filtered = filtered.filter(stock => stock.signal === filterSignal);
    }

    return filtered.sort((a, b) => {
      switch (sortBy) {
        case 'score':
          return (b.latest_score || 0) - (a.latest_score || 0);
        case 'upside':
          return (b.upside_downside_percent || 0) - (a.upside_downside_percent || 0);
        case 'symbol':
          return a.symbol.localeCompare(b.symbol);
        default:
          return 0;
      }
    });
  };

  const filteredPortfolio = getFilteredPortfolio();

  // ============================================
  // HELPER FUNCTIONS
  // ============================================

  const getSignalColor = (signal) => {
    const colors = {
      'STRONG_BUY': '#10b981',
      'BUY': '#3b82f6',
      'HOLD': '#f59e0b',
      'REDUCE': '#ef4444',
      'SELL': '#7f1d1d'
    };
    return colors[signal] || '#6b7280';
  };

  const getSignalEmoji = (signal) => {
    const emojis = {
      'STRONG_BUY': '🚀',
      'BUY': '✅',
      'HOLD': '⏸️',
      'REDUCE': '⚠️',
      'SELL': '❌'
    };
    return emojis[signal] || '•';
  };

  const formatPercent = (num) => {
    if (!num) return '0%';
    return `${num > 0 ? '+' : ''}${num.toFixed(1)}%`;
  };

  const formatPrice = (num) => {
    if (!num) return 'N/A';
    return `$${num.toFixed(2)}`;
  };

  // ============================================
  // RENDER
  // ============================================

  if (loading && portfolio.length === 0) {
    return (
      <div className="dashboard-container">
        <div className="loading-spinner">
          <div className="spinner"></div>
          <p>Loading portfolio analysis...</p>
        </div>
      </div>
    );
  }

  if (error && portfolio.length === 0) {
    return (
      <div className="dashboard-container">
        <div className="error-box">
          <h2>⚠️ Error Loading Portfolio</h2>
          <p>{error}</p>
          <button onClick={fetchPortfolio} className="btn-primary">
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      {/* HEADER */}
      <div className="dashboard-header">
        <div>
          <h1>📊 Professional Portfolio Dashboard</h1>
          <p className="subtitle">
            AI-Powered Stock Analysis | 6 Data Sources | Professional Grade Scoring
          </p>
        </div>
        <div className="header-actions">
          {lastUpdate && (
            <div className="last-update">
              🕐 Last updated: {lastUpdate.toLocaleTimeString()}
            </div>
          )}
          <button onClick={() => openAddForm()} className="btn-add">
            ➕ Add Stock
          </button>
          <button onClick={fetchPortfolio} className="btn-refresh">
            🔄 Refresh
          </button>
        </div>
      </div>

      {/* ADD/EDIT FORM MODAL */}
      {showForm && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h2>{formMode === 'add' ? '➕ Add New Stock' : '✏️ Edit Stock'}</h2>
              <button onClick={() => setShowForm(false)} className="btn-close">✕</button>
            </div>
            
            <form onSubmit={formMode === 'add' ? handleAddStock : handleEditStock}>
              <div className="form-grid">
                <div className="form-group">
                  <label>Symbol *</label>
                  <input
                    type="text"
                    placeholder="e.g., CRWD, TCS"
                    value={formData.symbol}
                    onChange={(e) => setFormData({...formData, symbol: e.target.value.toUpperCase()})}
                    disabled={formMode === 'edit'}
                  />
                </div>

                <div className="form-group">
                  <label>Company Name</label>
                  <input
                    type="text"
                    placeholder="e.g., CrowdStrike Holdings"
                    value={formData.name}
                    onChange={(e) => setFormData({...formData, name: e.target.value})}
                  />
                </div>

                <div className="form-group">
                  <label>Quantity *</label>
                  <input
                    type="number"
                    placeholder="Number of shares"
                    step="0.01"
                    value={formData.quantity}
                    onChange={(e) => setFormData({...formData, quantity: e.target.value})}
                  />
                </div>

                <div className="form-group">
                  <label>Average Price ($) *</label>
                  <input
                    type="number"
                    placeholder="Entry price per share"
                    step="0.01"
                    value={formData.average_price}
                    onChange={(e) => setFormData({...formData, average_price: e.target.value})}
                  />
                </div>

                <div className="form-group">
                  <label>Type</label>
                  <select value={formData.type} onChange={(e) => setFormData({...formData, type: e.target.value})}>
                    <option>Stock</option>
                    <option>ETF</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Region</label>
                  <select value={formData.region} onChange={(e) => setFormData({...formData, region: e.target.value})}>
                    <option>Global</option>
                    <option>India</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Sector</label>
                  <input
                    type="text"
                    placeholder="e.g., Technology, Healthcare"
                    value={formData.sector}
                    onChange={(e) => setFormData({...formData, sector: e.target.value})}
                  />
                </div>
              </div>

              <div className="form-actions">
                <button type="submit" className="btn-submit">
                  {formMode === 'add' ? 'Add Stock' : 'Update Stock'}
                </button>
                <button type="button" onClick={() => setShowForm(false)} className="btn-cancel">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SUMMARY STATS */}
      {stats && (
        <div className="summary-section">
          <h2>Portfolio Summary</h2>
          <div className="stats-grid">
            <div className="stat-card strong-buy">
              <div className="stat-icon">🚀</div>
              <div className="stat-content">
                <p className="stat-label">Strong Buys</p>
                <p className="stat-value">{stats.strongBuys}</p>
              </div>
            </div>

            <div className="stat-card buy">
              <div className="stat-icon">✅</div>
              <div className="stat-content">
                <p className="stat-label">Buys</p>
                <p className="stat-value">{stats.buys}</p>
              </div>
            </div>

            <div className="stat-card hold">
              <div className="stat-icon">⏸️</div>
              <div className="stat-content">
                <p className="stat-label">Holds</p>
                <p className="stat-value">{stats.holds}</p>
              </div>
            </div>

            <div className="stat-card reduce">
              <div className="stat-icon">⚠️</div>
              <div className="stat-content">
                <p className="stat-label">Reduces</p>
                <p className="stat-value">{stats.reduces}</p>
              </div>
            </div>

            <div className="stat-card sell">
              <div className="stat-icon">❌</div>
              <div className="stat-content">
                <p className="stat-label">Sells</p>
                <p className="stat-value">{stats.sells}</p>
              </div>
            </div>

            <div className="stat-card average">
              <div className="stat-icon">📈</div>
              <div className="stat-content">
                <p className="stat-label">Average Score</p>
                <p className="stat-value">{stats.averageScore}/10</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* CONTROLS */}
      <div className="controls-section">
        <div className="filter-group">
          <label>Filter by Signal:</label>
          <select value={filterSignal} onChange={(e) => setFilterSignal(e.target.value)}>
            <option value="ALL">All Signals</option>
            <option value="STRONG_BUY">🚀 Strong Buy</option>
            <option value="BUY">✅ Buy</option>
            <option value="HOLD">⏸️ Hold</option>
            <option value="REDUCE">⚠️ Reduce</option>
            <option value="SELL">❌ Sell</option>
          </select>
        </div>

        <div className="sort-group">
          <label>Sort by:</label>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="score">Score (High to Low)</option>
            <option value="upside">Upside % (High to Low)</option>
            <option value="symbol">Symbol (A-Z)</option>
          </select>
        </div>

        <div className="results-count">
          Showing {filteredPortfolio.length} of {portfolio.length} stocks
        </div>
      </div>

      {/* PORTFOLIO TABLE */}
      <div className="portfolio-section">
        <h2>Portfolio Analysis</h2>
        
        {filteredPortfolio.length === 0 ? (
          <div className="no-results">
            <p>No stocks in portfolio. Click "Add Stock" to get started!</p>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="portfolio-table">
              <thead>
                <tr>
                  <th className="col-symbol">Symbol</th>
                  <th className="col-price">Price</th>
                  <th className="col-score">Score</th>
                  <th className="col-signal">Signal</th>
                  <th className="col-target">Price Target</th>
                  <th className="col-upside">Upside</th>
                  <th className="col-confidence">Confidence</th>
                  <th className="col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredPortfolio.map((stock) => (
                  <tr key={stock.id} className={`row-${stock.signal?.toLowerCase()}`}>
                    <td className="col-symbol">
                      <strong className="stock-symbol">{stock.symbol}</strong>
                      <span className="stock-name">{stock.name}</span>
                    </td>

                    <td className="col-price">
                      <span className="price-value">
                        {formatPrice(stock.current_price)}
                      </span>
                      {stock.change_percent && (
                        <span className={`change ${stock.change_percent > 0 ? 'positive' : 'negative'}`}>
                          {stock.change_percent > 0 ? '▲' : '▼'} {formatPercent(stock.change_percent)}
                        </span>
                      )}
                    </td>

                    <td className="col-score">
                      <div className="score-badge">
                        <span className="score-number">
                          {stock.latest_score?.toFixed(1) || '—'}
                        </span>
                        <span className="score-max">/10</span>
                      </div>
                      <div className="score-bar">
                        <div 
                          className="score-fill"
                          style={{
                            width: `${((stock.latest_score || 0) / 10) * 100}%`,
                            backgroundColor: getSignalColor(stock.signal)
                          }}
                        ></div>
                      </div>
                    </td>

                    <td className="col-signal">
                      <span 
                        className="signal-badge"
                        style={{ backgroundColor: getSignalColor(stock.signal) }}
                      >
                        {getSignalEmoji(stock.signal)} {stock.signal}
                      </span>
                    </td>

                    <td className="col-target">
                      {formatPrice(stock.analyst_price_target)}
                    </td>

                    <td className="col-upside">
                      <span className={stock.upside_downside_percent > 0 ? 'positive' : 'negative'}>
                        {stock.upside_downside_percent ? 
                          `${stock.upside_downside_percent > 0 ? '+' : ''}${stock.upside_downside_percent.toFixed(1)}%` 
                          : '—'
                        }
                      </span>
                    </td>

                    <td className="col-confidence">
                      <span className="confidence-badge">
                        {stock.confidence}%
                      </span>
                    </td>

                    <td className="col-actions">
                      <button 
                        onClick={() => openEditForm(stock)}
                        className="btn-action btn-edit"
                        title="Edit stock"
                      >
                        ✏️
                      </button>
                      <button 
                        onClick={() => handleDeleteStock(stock.id)}
                        className="btn-action btn-delete"
                        title="Delete stock"
                      >
                        🗑️
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* FOOTER */}
      <div className="dashboard-footer">
        <p>
          💡 <strong>Data Updated Daily at 5 PM ET</strong> via GitHub Actions automation
        </p>
        <p className="footer-note">
          News analyzed every 6 hours (weekdays) and 24 hours (weekends). All data from real market sources.
        </p>
      </div>
    </div>
  );
};

export default EnhancedPortfolioDashboard;
