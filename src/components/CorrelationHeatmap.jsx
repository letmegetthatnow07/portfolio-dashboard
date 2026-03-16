import React, { useState, useEffect } from 'react';
import './CorrelationHeatmap.css'; 

const CorrelationHeatmap = () => {
  const [matrixData, setMatrixData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchCorrelation = async () => {
      try {
        const response = await fetch('/api/portfolio/correlation');
        if (response.ok) {
          const data = await response.json();
          setMatrixData(data);
        }
      } catch (err) {
        console.error('Failed to load correlation matrix', err);
      } finally {
        setLoading(false);
      }
    };
    fetchCorrelation();
  }, []);

  const getColor = (value) => {
    if (value === 1) return '#374151'; // Neutral Dark (Self)
    if (value > 0.65) return '#ef4444'; // Red (Danger - Highly Correlated based on Returns)
    if (value > 0.3) return '#fca5a5'; // Light Red (Mild Correlation)
    if (value > -0.3) return '#10b981'; // Green (Excellent Hedge - Uncorrelated)
    return '#059669'; // Dark Green (Strong Hedge - Negatively Correlated)
  };

  if (loading) return <div className="heatmap-loading">Calculating Hedging Physics...</div>;
  if (!matrixData || !matrixData.tickers) return null;

  const { tickers, matrix, insights } = matrixData;

  return (
    <div className="correlation-container">
      <div className="heatmap-header">
        <h2>Structural Hedging Matrix</h2>
        <p className="subtitle">Identify portfolio vulnerabilities. Red = High Risk Correlation. Green = Structural Hedge.</p>
      </div>
      
      <div className="heatmap-wrapper">
        <table className="heatmap-table">
          <thead>
            <tr>
              <th></th>
              {tickers.map(t => <th key={`header-${t}`}>{t}</th>)}
            </tr>
          </thead>
          <tbody>
            {tickers.map(rowTicker => (
              <tr key={`row-${rowTicker}`}>
                <td className="row-header"><strong>{rowTicker}</strong></td>
                {tickers.map(colTicker => {
                  const val = matrix[rowTicker][colTicker];
                  return (
                    <td 
                      key={`cell-${rowTicker}-${colTicker}`}
                      style={{ backgroundColor: getColor(val), color: '#ffffff' }}
                      title={`${rowTicker} vs ${colTicker}: ${val}`}
                    >
                      {val.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
      <div className="matrix-legend">
        <div className="legend-item"><span className="color-box" style={{backgroundColor: '#ef4444'}}></span> High Risk</div>
        <div className="legend-item"><span className="color-box" style={{backgroundColor: '#374151'}}></span> Self</div>
        <div className="legend-item"><span className="color-box" style={{backgroundColor: '#10b981'}}></span> Excellent Hedge</div>
      </div>

      {/* --- NEW CAPITAL OPTIMIZATION SECTION --- */}
      {insights && insights.length > 0 && (
        <div className="insights-container">
          <h3 className="insights-title">Capital Optimization Actions</h3>
          <p className="insights-subtitle">The system detected highly correlated assets. To optimize taxes and minimize redundancy, consolidate capital into the strongest compounder.</p>
          
          <div className="insights-grid">
            {insights.map((insight, idx) => (
              <div key={idx} className="insight-card">
                <div className="insight-header">
                  <span className="insight-pair">{insight.pair[0]} & {insight.pair[1]}</span>
                  <span className="insight-corr badge-danger">{(insight.correlation * 100).toFixed(0)}% Correlated</span>
                </div>
                <p className="insight-verdict">
                  ✓ <strong>Retain {insight.winner}</strong> over {insight.loser}.
                </p>
                <div className="insight-stats">
                  <div>
                    <span className="stat-label-small">{insight.winner} α (Alpha)</span>
                    <span className="stat-value-small" style={{color: insight.winnerAlpha >= 0 ? '#10b981' : '#ef4444'}}>
                      {insight.winnerAlpha >= 0 ? '+' : ''}{insight.winnerAlpha.toFixed(2)}%
                    </span>
                  </div>
                  <div>
                    <span className="stat-label-small">{insight.loser} α (Alpha)</span>
                    <span className="stat-value-small" style={{color: insight.loserAlpha >= 0 ? '#10b981' : '#ef4444'}}>
                      {insight.loserAlpha >= 0 ? '+' : ''}{insight.loserAlpha.toFixed(2)}%
                    </span>
                  </div>
                </div>
                <p className="insight-action">
                  <strong>Action:</strong> {insight.winner} shows superior Alpha and a stronger fundamental regime. Consider trimming {insight.loser} on its next green day and swapping allocation to {insight.winner} to optimize risk-adjusted returns.
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default CorrelationHeatmap;
