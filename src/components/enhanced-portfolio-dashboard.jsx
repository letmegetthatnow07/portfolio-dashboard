/**
 * Enhanced Portfolio Dashboard
 * Displays portfolio with composite scores from professional analysis
 * Shows all 6 data sources: Ratings, Grades, Sentiment, Technical, Insider, Filings
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
  const [sortBy, setSortBy] = useState('score'); // score, signal, upside
  const [filterSignal, setFilterSignal] = useState('ALL'); // ALL, STRONG_BUY, BUY, HOLD, REDUCE, SELL

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
        // Sort portfolio by score descending
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
    // Fetch on component mount
    fetchPortfolio();

    // Refresh every 5 minutes
    const interval = setInterval(fetchPortfolio, 5 * 60 * 1000);
    
    return () => clearInterval(interval);
  }, []);

  // ============================================
  // FILTER & SORT
  // ============================================

  const getFilteredPortfolio = () => {
    let filtered = portfolio;

    // Filter by signal
    if (filterSignal !== 'ALL') {
      filtered = filtered.filter(stock => stock.signal === filterSignal);
    }

    // Sort
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
    switch (signal) {
      case 'STRONG_BUY':
        return '#10b981'; // Green
      case 'BUY':
        return '#3b82f6'; // Blue
      case 'HOLD':
        return '#f59e0b'; // Amber
      case 'REDUCE':
        return '#ef4444'; // Red
      case 'SELL':
        return '#7f1d1d'; // Dark Red
      default:
        return '#6b7280'; // Gray
    }
  };

  const getSignalEmoji = (signal) => {
    switch (signal) {
      case 'STRONG_BUY':
        return '🚀';
      case 'BUY':
        return '✅';
      case 'HOLD':
        return '⏸️';
      case 'REDUCE':
        return '⚠️';
      case 'SELL':
        return '❌';
      default:
        return '•';
    }
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
  // RENDER LOADING STATE
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

  // ============================================
  // RENDER ERROR STATE
  // ============================================

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

  // ============================================
  // RENDER DASHBOARD
  // ============================================

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
          <button onClick={fetchPortfolio} className="btn-refresh">
            🔄 Refresh Now
          </button>
        </div>
      </div>

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

      {/* FILTERS & SORTING */}
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
            <p>No stocks match your filter</p>
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
                  <th className="col-breakdown">Component Scores</th>
                </tr>
              </thead>
              <tbody>
                {filteredPortfolio.map((stock) => (
                  <tr key={stock.symbol} className={`row-${stock.signal?.toLowerCase()}`}>
                    {/* Symbol */}
                    <td className="col-symbol">
                      <strong className="stock-symbol">{stock.symbol}</strong>
                      <span className="stock-name">{stock.name}</span>
                    </td>

                    {/* Current Price */}
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

                    {/* Composite Score */}
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

                    {/* Signal */}
                    <td className="col-signal">
                      <span 
                        className="signal-badge"
                        style={{ backgroundColor: getSignalColor(stock.signal) }}
                      >
                        {getSignalEmoji(stock.signal)} {stock.signal}
                      </span>
                    </td>

                    {/* Price Target */}
                    <td className="col-target">
                      {formatPrice(stock.analyst_price_target)}
                    </td>

                    {/* Upside/Downside */}
                    <td className="col-upside">
                      <span className={stock.upside_downside_percent > 0 ? 'positive' : 'negative'}>
                        {stock.upside_downside_percent ? 
                          `${stock.upside_downside_percent > 0 ? '+' : ''}${stock.upside_downside_percent.toFixed(1)}%` 
                          : '—'
                        }
                      </span>
                    </td>

                    {/* Confidence */}
                    <td className="col-confidence">
                      <span className="confidence-badge">
                        {stock.confidence}%
                      </span>
                    </td>

                    {/* Component Breakdown */}
                    <td className="col-breakdown">
                      <div className="components">
                        <span className="component" title="Analyst Rating">
                          R: {stock.analyst_rating_score?.toFixed(1) || '—'}
                        </span>
                        <span className="component" title="News Sentiment">
                          S: {stock.news_sentiment_score?.toFixed(1) || '—'}
                        </span>
                        <span className="component" title="Technical">
                          T: {stock.technical_score?.toFixed(1) || '—'}
                        </span>
                        <span className="component" title="Insider">
                          I: {stock.insider_score?.toFixed(1) || '—'}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* LEGEND */}
      <div className="legend-section">
        <h3>Legend</h3>
        <div className="legend-grid">
          <div className="legend-item">
            <span className="legend-symbol">R:</span>
            <span>Analyst Ratings (Finnhub)</span>
          </div>
          <div className="legend-item">
            <span className="legend-symbol">G:</span>
            <span>Stock Grades (FMP)</span>
          </div>
          <div className="legend-item">
            <span className="legend-symbol">S:</span>
            <span>News Sentiment (newsdata.io)</span>
          </div>
          <div className="legend-item">
            <span className="legend-symbol">T:</span>
            <span>Technical (Alpha Vantage)</span>
          </div>
          <div className="legend-item">
            <span className="legend-symbol">I:</span>
            <span>Insider (SEC Form 4)</span>
          </div>
          <div className="legend-item">
            <span className="legend-symbol">F:</span>
            <span>Filings (SEC-API.io)</span>
          </div>
        </div>
      </div>

      {/* FOOTER */}
      <div className="dashboard-footer">
        <p>
          💡 <strong>Data Updated Daily at 5 PM ET</strong> via GitHub Actions automation
        </p>
        <p className="footer-note">
          Composite scores are calculated from 6 professional data sources using institutional-grade weighting.
          This is analytical data for informational purposes only, not financial advice.
        </p>
      </div>
    </div>
  );
};

export default EnhancedPortfolioDashboard;
