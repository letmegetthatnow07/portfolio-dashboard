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
    if (value > 0.7) return '#ef4444'; // Red (Danger - Highly Correlated)
    if (value > 0.3) return '#fca5a5'; // Light Red (Mild Correlation)
    if (value > -0.3) return '#10b981'; // Green (Excellent Hedge - Uncorrelated)
    return '#059669'; // Dark Green (Strong Hedge - Negatively Correlated)
  };

  if (loading) return <div className="heatmap-loading">Calculating Hedging Physics...</div>;
  if (!matrixData || !matrixData.tickers) return null;

  const { tickers, matrix } = matrixData;

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
    </div>
  );
};

export default CorrelationHeatmap;
