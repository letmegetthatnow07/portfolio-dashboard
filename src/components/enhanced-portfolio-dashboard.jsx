import React, { useState, useEffect } from 'react';
import './enhanced-portfolio-dashboard.css';

const EnhancedPortfolioDashboard = () => {
  const [portfolio, setPortfolio] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [sortBy, setSortBy] = useState('score');
  const [filterSignal, setFilterSignal] = useState('ALL');
  
  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState('add'); 
  const [formData, setFormData] = useState({
    symbol: '', name: '', quantity: '', average_price: '', type: 'Stock', region: 'Global', sector: ''
  });
  const [editingId, setEditingId] = useState(null);
  
  // New state for the News Modal
  const [newsModalStock, setNewsModalStock] = useState(null);

  const fetchPortfolio = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/portfolio');
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();

      if (data.status === 'success') {
        const sorted = [...data.portfolio].sort((a, b) => (b.latest_score || 0) - (a.latest_score || 0));
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

  useEffect(() => {
    fetchPortfolio();
    const interval = setInterval(fetchPortfolio, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

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
      const response = await fetch(`/api/portfolio/delete/${id}`, { method: 'DELETE' });
      if (response.ok) {
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
      symbol: stock.symbol, name: stock.name || '', quantity: stock.quantity.toString(),
      average_price: stock.average_price.toString(), type: stock.type || 'Stock',
      region: stock.region || 'Global', sector: stock.sector || ''
    });
    setShowForm(true);
  };

  const openAddForm = () => {
    setFormMode('add');
    setEditingId(null);
    setFormData({ symbol: '', name: '', quantity: '', average_price: '', type: 'Stock', region: 'Global', sector: '' });
    setShowForm(true);
  };

  const getFilteredPortfolio = () => {
    let filtered = portfolio;
    if (filterSignal !== 'ALL') {
      filtered = filtered.filter(stock => stock.signal === filterSignal);
    }
    return filtered.sort((a, b) => {
      switch (sortBy) {
        case 'score': return (b.latest_score || 0) - (a.latest_score || 0);
        case 'upside': return (b.upside_downside_percent || 0) - (a.upside_downside_percent || 0);
        case 'symbol': return a.symbol.localeCompare(b.symbol);
        default: return 0;
      }
    });
  };

  const filteredPortfolio = getFilteredPortfolio();

  const getSignalColor = (signal) => {
    const colors = { 'STRONG_BUY': '#10b981', 'BUY': '#3b82f6', 'HOLD': '#f59e0b', 'REDUCE': '#ef4444', 'SELL': '#7f1d1d' };
    return colors[signal] || '#6b7280';
  };

  const getSignalEmoji = (signal) => {
    const emojis = { 'STRONG_BUY': '🚀', 'BUY': '✅', 'HOLD': '⏸️', 'REDUCE': '⚠️', 'SELL': '❌' };
    return emojis[signal] || '•';
  };

  const formatPercent = (num) => {
    if (!num) return '0%';
    return `${num > 0 ? '+' : ''}${num.toFixed(1)}%`;
  };

  const formatPrice = (num) => {
    if (!num && num !== 0) return 'N/A';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
  };

  if (loading && portfolio.length === 0) {
    return (
      <div className="dashboard-container">
        <div className="loading-spinner"><div className="spinner"></div></div>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <div>
          <h1>Alpha Dashboard</h1>
          <p className="subtitle">Structural Alpha Tracking & Portfolio Audit</p>
        </div>
        <div className="header-actions">
          {lastUpdate && <div className="last-update">Updated: {lastUpdate.toLocaleTimeString()}</div>}
          <button onClick={() => openAddForm()} className="btn-primary">Add Asset</button>
          <button onClick={fetchPortfolio} className="btn-secondary">Refresh</button>
        </div>
      </div>

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
                  <input type="text" placeholder="e.g. CRWD" value={formData.symbol} onChange={(e) => setFormData({...formData, symbol: e.target.value.toUpperCase()})} disabled={formMode === 'edit'} />
                </div>
                <div className="form-group">
                  <label>Quantity</label>
                  <input type="number" step="0.01" value={formData.quantity} onChange={(e) => setFormData({...formData, quantity: e.target.value})} />
                </div>
                <div className="form-group">
                  <label>Average Price</label>
                  <input type="number" step="0.01" value={formData.average_price} onChange={(e) => setFormData({...formData, average_price: e.target.value})} />
                </div>
              </div>
              <div className="form-actions">
                <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
                <button type="submit" className="btn-primary">{formMode === 'add' ? 'Save' : 'Update'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* NEWS MODAL */}
      {newsModalStock && (
        <div className="modal-overlay" onClick={() => setNewsModalStock(null)}>
          <div className="modal-content news-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Latest Intelligence: {newsModalStock.symbol}</h2>
              <button onClick={() => setNewsModalStock(null)} className="btn-close">✕</button>
            </div>
            <div className="news-container">
              {newsModalStock.recent_news && newsModalStock.recent_news.length > 0 ? (
                newsModalStock.recent_news.map((news, idx) => (
                  <a href={news.url} target="_blank" rel="noopener noreferrer" key={idx} className="news-card">
                    <span className="news-date">{new Date(news.published_at).toLocaleDateString()}</span>
                    <h3 className="news-headline">{news.headline}</h3>
                    {news.description && <p className="news-desc">{news.description.substring(0, 150)}...</p>}
                  </a>
                ))
              ) : (
                <p className="no-news">No actionable intelligence found for this asset in the current cycle.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {stats && (
        <div className="summary-section">
          <div className="stats-grid">
            <div className="stat-card total-value">
              <div className="stat-label">Total Value</div>
              <div className="stat-value">{formatPrice(stats.totalValue)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Average Score</div>
              <div className="stat-value">{stats.averageScore}/10</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Strong Buys</div>
              <div className="stat-value" style={{color: 'var(--color-strong-buy)'}}>{stats.strongBuys}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Buys</div>
              <div className="stat-value" style={{color: 'var(--color-buy)'}}>{stats.buys}</div>
            </div>
          </div>
        </div>
      )}

      <div className="controls-section">
        <select className="minimal-select" value={filterSignal} onChange={(e) => setFilterSignal(e.target.value)}>
          <option value="ALL">All Signals</option>
          <option value="STRONG_BUY">Strong Buy</option>
          <option value="BUY">Buy</option>
          <option value="HOLD">Hold</option>
          <option value="REDUCE">Reduce</option>
          <option value="SELL">Sell</option>
        </select>
        <select className="minimal-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <option value="score">Score (High to Low)</option>
          <option value="symbol">Symbol (A-Z)</option>
        </select>
        <div className="results-count">{filteredPortfolio.length} Assets</div>
      </div>

      <div className="portfolio-section">
        {filteredPortfolio.length === 0 ? (
          <div className="no-results">Portfolio empty. Initiate tracking by adding an asset.</div>
        ) : (
          <div className="table-wrapper">
            <table className="portfolio-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Price</th>
                  <th>Score</th>
                  <th>Signal</th>
                  <th>Total Value</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredPortfolio.map((stock) => {
                  const totalValue = (parseFloat(stock.current_price) || 0) * (parseFloat(stock.quantity) || 0);
                  
                  return (
                  <tr key={stock.id}>
                    <td>
                      <strong className="stock-symbol">{stock.symbol}</strong>
                    </td>
                    <td>
                      <div className="price-value">{formatPrice(stock.current_price)}</div>
                      {stock.change_percent && (
                        <div className={`change ${stock.change_percent > 0 ? 'positive' : 'negative'}`}>
                          {stock.change_percent > 0 ? '+' : ''}{stock.change_percent.toFixed(2)}%
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="score-badge">
                        <span className="score-number">{stock.latest_score?.toFixed(1) || '—'}</span>
                      </div>
                    </td>
                    <td>
                      <span className="signal-badge" style={{ color: getSignalColor(stock.signal), backgroundColor: `${getSignalColor(stock.signal)}15` }}>
                        {stock.signal?.replace('_', ' ') || 'PENDING'}
                      </span>
                    </td>
                    <td>
                      <div className="price-value">{formatPrice(totalValue)}</div>
                    </td>
                    <td className="col-actions">
                      <button onClick={() => setNewsModalStock(stock)} className="btn-icon" title="View Intelligence">📰</button>
                      <button onClick={() => openEditForm(stock)} className="btn-icon" title="Edit">✏️</button>
                      <button onClick={() => handleDeleteStock(stock.id)} className="btn-icon" title="Remove">🗑️</button>
                    </td>
                  </tr>
                )})}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default EnhancedPortfolioDashboard;
