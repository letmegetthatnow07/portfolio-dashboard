import React, { useState } from 'react';
import { AlertCircle, Plus, X, Calendar, LineChart, DollarSign, Target } from 'lucide-react';

const EnhancedPortfolioDashboard = () => {
  const [portfolio, setPortfolio] = useState([]);
  const [showAddStock, setShowAddStock] = useState(false);
  const [selectedStock, setSelectedStock] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [newStock, setNewStock] = useState({ symbol: '', quantity: '', costPrice: '' });
  const [apiKey, setApiKey] = useState(
    process.env.REACT_APP_FINNHUB_API_KEY || ''
  );
  const [showApiSetup, setShowApiSetup] = useState(true);

  // Historical price data from uploaded CSVs
  const historicalPrices = {
    'BWXT': [
      { date: '03/01/2026', price: 195.98, change: -4.85 },
      { date: '02/01/2026', price: 205.98, change: 0.27 },
      { date: '01/01/2026', price: 205.43, change: 18.86 },
      { date: '12/01/2025', price: 172.84, change: -3.38 },
      { date: '11/01/2025', price: 178.88, change: -16.26 },
      { date: '10/01/2025', price: 213.61, change: 15.86 },
      { date: '09/01/2025', price: 184.37, change: 13.78 },
      { date: '08/01/2025', price: 162.04, change: 6.65 },
      { date: '07/01/2025', price: 151.93, change: 5.46 },
    ],
    'CRWD': [
      { date: '03/01/2026', price: 442.03, change: 18.83 },
      { date: '02/01/2026', price: 371.98, change: -15.73 },
      { date: '01/01/2026', price: 441.40, change: -5.84 },
      { date: '12/01/2025', price: 468.76, change: -7.93 },
      { date: '11/01/2025', price: 509.16, change: -6.23 },
      { date: '10/01/2025', price: 543.01, change: 10.73 },
      { date: '09/01/2025', price: 490.38, change: 15.74 },
      { date: '08/01/2025', price: 423.70, change: -6.79 },
      { date: '07/01/2025', price: 454.57, change: -10.75 },
    ]
  };

  // Comprehensive stock database
  const stockDatabase = {
    'SPMO': { name: 'Salzburg Minerals', sector: 'Materials', pe: 15.2, eps: 1.87, dividendYield: 2.1, pe_vs_sector: -15, revenue_growth: 12.5 },
    'SMH': { name: 'iShares Semiconductor ETF', sector: 'ETF - Semiconductors', pe: 18.5, eps: null, dividendYield: 0.6, isETF: true, holdings: ['NVDA', 'ASML', 'TSMC', 'QCOM', 'AMD', 'MU', 'LRCX'], holdingWeights: [24, 17, 15, 10, 9, 7, 6] },
    'TPL': { name: 'Texas Pacific Land', sector: 'Energy', pe: 12.1, eps: 8.45, dividendYield: 1.5, pe_vs_sector: -25, revenue_growth: 8.3 },
    'VRT': { name: 'Virtus Investment', sector: 'Financial', pe: 11.8, eps: 5.23, dividendYield: 3.2, pe_vs_sector: -30, revenue_growth: 5.1 },
    'MU': { name: 'Micron Technology', sector: 'Semiconductors', pe: 12.5, eps: 7.84, dividendYield: 1.8, pe_vs_sector: -28, revenue_growth: 15.2 },
    'MELI': { name: 'MercadoLibre', sector: 'E-commerce', pe: 89.2, eps: 16.34, dividendYield: 0, pe_vs_sector: 45, revenue_growth: 35.5 },
    'AVNV': { name: 'Avanti Acquisition Corp', sector: 'SPAC', pe: null, eps: -0.12, dividendYield: 0 },
    'BWXT': { name: 'BWX Technologies', sector: 'Aerospace & Defense', pe: 25.3, eps: 3.87, dividendYield: 0.8, pe_vs_sector: 12, revenue_growth: 8.9, historicalPrices: historicalPrices['BWXT'] },
    'GEV': { name: 'GE Vernova', sector: 'Energy', pe: null, eps: -0.45, dividendYield: 0 },
    'FTAI': { name: 'Flex LNG', sector: 'Energy', pe: 8.2, eps: 4.17, dividendYield: 12.5, pe_vs_sector: -65, revenue_growth: 2.1 },
    'SHLD': { name: 'Sears Holdings', sector: 'Retail', pe: null, eps: -5.23, dividendYield: 0 },
    'SCCO': { name: 'Southern Copper', sector: 'Materials', pe: 10.5, eps: 2.34, dividendYield: 3.8, pe_vs_sector: -35, revenue_growth: 6.2 },
    'KTOS': { name: 'Kratos Defense', sector: 'Defense', pe: 89.5, eps: 0.32, dividendYield: 0, pe_vs_sector: 55, revenue_growth: 18.2 },
    'RKLB': { name: 'Rocket Lab', sector: 'Aerospace', pe: null, eps: -0.15, dividendYield: 0, revenue_growth: 22.5 },
    'AGX': { name: 'Argan Inc', sector: 'Construction', pe: 13.2, eps: 4.51, dividendYield: 2.3, pe_vs_sector: -18 },
    'ASTS': { name: 'AST SpaceMobile', sector: 'Aerospace', pe: null, eps: -0.89, dividendYield: 0 },
    'CRWD': { name: 'CrowdStrike', sector: 'Cybersecurity', pe: 145.3, eps: 1.98, dividendYield: 0, pe_vs_sector: 125, revenue_growth: 32.1, historicalPrices: historicalPrices['CRWD'] },
    'LLY': { name: 'Eli Lilly', sector: 'Pharmaceuticals', pe: 52.3, eps: 16.10, dividendYield: 0.8, pe_vs_sector: 35, revenue_growth: 28.3 }
  };

  // Earnings calendar data
  const earningsCalendar = [
    { symbol: 'CRWD', company: 'CrowdStrike', date: '2026-03-15', eps_estimate: 0.82, revenue_estimate: '432M', importance: 'high' },
    { symbol: 'BWXT', company: 'BWX Technologies', date: '2026-03-22', eps_estimate: 1.05, revenue_estimate: '612M', importance: 'high' },
    { symbol: 'MU', company: 'Micron Technology', date: '2026-04-02', eps_estimate: 2.15, revenue_estimate: '8200M', importance: 'high' },
    { symbol: 'LLY', company: 'Eli Lilly', date: '2026-04-21', eps_estimate: 4.32, revenue_estimate: '11500M', importance: 'high' },
    { symbol: 'MELI', company: 'MercadoLibre', date: '2026-04-28', eps_estimate: 4.82, revenue_estimate: '3200M', importance: 'medium' },
  ];

  // Generate recommendations
  const generateRecommendations = () => {
    if (portfolio.length === 0) {
      return [{ type: 'info', title: 'Start Building Your Portfolio', description: 'Add your first stock to get personalized recommendations', priority: 'high' }];
    }
    return [];
  };

  // Calculate portfolio stats
  const getPortfolioStats = () => {
    let totalValue = 0;
    let totalGain = 0;
    portfolio.forEach(stock => {
      const value = stock.price * stock.quantity;
      totalValue += value;
      totalGain += (stock.price - stock.costPrice) * stock.quantity;
    });
    return {
      totalValue: totalValue.toFixed(2),
      totalGain: totalGain.toFixed(2),
      gainPercent: totalValue > 0 ? ((totalGain / (totalValue - totalGain)) * 100).toFixed(2) : 0
    };
  };

  const handleAddStock = () => {
    if (newStock.symbol && newStock.quantity) {
      const stock = stockDatabase[newStock.symbol.toUpperCase()];
      if (stock) {
        setPortfolio([...portfolio, {
          id: Date.now(),
          symbol: newStock.symbol.toUpperCase(),
          quantity: parseFloat(newStock.quantity),
          costPrice: parseFloat(newStock.costPrice) || 0,
          price: 100,
          ...stock
        }]);
        setNewStock({ symbol: '', quantity: '', costPrice: '' });
        setShowAddStock(false);
      }
    }
  };

  const removeStock = (id) => {
    setPortfolio(portfolio.filter(s => s.id !== id));
    setSelectedStock(null);
  };

  const stats = getPortfolioStats();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white font-sans">
      {/* API Setup Modal */}
      {showApiSetup && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-md w-full p-8">
            <h2 className="text-2xl font-bold text-cyan-400 mb-4">Finnhub API Setup</h2>
            <p className="text-slate-300 text-sm mb-6">Get a free API key at finnhub.io</p>
            <input type="password" placeholder="API Key (optional)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-white mb-4 focus:border-cyan-500 focus:outline-none" />
            <button onClick={() => setShowApiSetup(false)} className="w-full bg-cyan-600 hover:bg-cyan-700 px-4 py-2 rounded font-medium transition-colors">Continue</button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="border-b border-slate-800 bg-slate-900/50 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-8 py-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">PORTFOLIO DASHBOARD</h1>
              <p className="text-slate-400 text-sm mt-1">Long-term Growth Analytics</p>
            </div>
            <button onClick={() => setShowAddStock(!showAddStock)} className="bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 px-6 py-3 rounded-lg flex items-center gap-2 transition-all">
              <Plus size={20} /> Add Stock
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        {/* Tabs */}
        <div className="flex gap-4 mb-8 border-b border-slate-700">
          {['overview', 'events', 'recommendations', 'analysis'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`px-4 py-3 font-medium transition-colors capitalize ${activeTab === tab ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-300'}`}>
              {tab}
            </button>
          ))}
        </div>

        {/* Portfolio Summary */}
        {portfolio.length > 0 && activeTab === 'overview' && (
          <div className="grid grid-cols-4 gap-6 mb-8">
            <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-6 rounded-xl border border-slate-700">
              <p className="text-slate-400 text-sm mb-2">Portfolio Value</p>
              <p className="text-3xl font-bold text-cyan-400">${stats.totalValue}</p>
            </div>
            <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-6 rounded-xl border border-slate-700">
              <p className="text-slate-400 text-sm mb-2">Holdings</p>
              <p className="text-3xl font-bold text-green-400">{portfolio.length}</p>
            </div>
            <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-6 rounded-xl border border-slate-700">
              <p className="text-slate-400 text-sm mb-2">Gain/Loss</p>
              <p className={`text-3xl font-bold ${parseFloat(stats.totalGain) >= 0 ? 'text-green-400' : 'text-red-400'}`}>${stats.totalGain}</p>
            </div>
            <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-6 rounded-xl border border-slate-700">
              <p className="text-slate-400 text-sm mb-2">Return %</p>
              <p className={`text-3xl font-bold ${parseFloat(stats.gainPercent) >= 0 ? 'text-green-400' : 'text-red-400'}`}>{stats.gainPercent}%</p>
            </div>
          </div>
        )}

        {/* Add Stock Form */}
        {showAddStock && (
          <div className="bg-slate-800 border border-slate-700 p-6 rounded-xl mb-8">
            <div className="grid grid-cols-3 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Symbol</label>
                <input type="text" placeholder="e.g., CRWD" value={newStock.symbol} onChange={(e) => setNewStock({...newStock, symbol: e.target.value.toUpperCase()})} className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white focus:border-cyan-500 focus:outline-none" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Quantity</label>
                <input type="number" placeholder="Shares" value={newStock.quantity} onChange={(e) => setNewStock({...newStock, quantity: e.target.value})} className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white focus:border-cyan-500 focus:outline-none" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Cost Price</label>
                <input type="number" placeholder="Entry price" value={newStock.costPrice} onChange={(e) => setNewStock({...newStock, costPrice: e.target.value})} className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white focus:border-cyan-500 focus:outline-none" />
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={handleAddStock} className="bg-green-600 hover:bg-green-700 px-6 py-2 rounded-lg font-medium transition-colors">Add Stock</button>
              <button onClick={() => setShowAddStock(false)} className="bg-slate-700 hover:bg-slate-600 px-6 py-2 rounded-lg font-medium transition-colors">Cancel</button>
            </div>
          </div>
        )}

        {/* Portfolio Cards */}
        {activeTab === 'overview' && (
          portfolio.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
              {portfolio.map(stock => {
                const gainLoss = stock.price - stock.costPrice;
                const gainLossPercent = stock.costPrice ? ((gainLoss / stock.costPrice) * 100).toFixed(2) : 0;
                
                return (
                  <div key={stock.id} onClick={() => setSelectedStock(stock)} className="bg-gradient-to-br from-slate-800 to-slate-900 border border-slate-700 rounded-xl p-5 hover:border-cyan-500 transition-all cursor-pointer hover:shadow-lg hover:shadow-cyan-500/20">
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h3 className="text-lg font-bold text-white">{stock.symbol}</h3>
                        <p className="text-xs text-slate-400">{stock.name}</p>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); removeStock(stock.id); }} className="text-slate-400 hover:text-red-500"><X size={18} /></button>
                    </div>
                    <div className="mb-4 pb-4 border-b border-slate-700">
                      <div className="flex items-baseline gap-2 mb-2">
                        <span className="text-2xl font-bold text-cyan-400">${stock.price.toFixed(2)}</span>
                        <div className={`text-sm font-medium ${gainLoss >= 0 ? 'text-green-400' : 'text-red-400'}`}>{gainLoss >= 0 ? '+' : ''}{gainLossPercent}%</div>
                      </div>
                      <div className="text-sm text-slate-400">Qty: {stock.quantity} | Value: ${(stock.price * stock.quantity).toFixed(2)}</div>
                    </div>
                    <div className="text-xs text-cyan-400 font-semibold">View Details →</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-16">
              <Target size={48} className="mx-auto text-slate-600 mb-4" />
              <h3 className="text-xl font-semibold text-slate-300 mb-2">No stocks added yet</h3>
              <button onClick={() => setShowAddStock(true)} className="bg-cyan-600 hover:bg-cyan-700 px-6 py-2 rounded-lg transition-colors mt-4">Add Stock</button>
            </div>
          )
        )}

        {/* Events Tab */}
        {activeTab === 'events' && (
          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
            <div className="bg-slate-900 border-b border-slate-700 px-6 py-4 flex items-center gap-2">
              <Calendar size={20} className="text-cyan-400" />
              <h2 className="text-xl font-bold">Earnings Calendar</h2>
            </div>
            <div className="divide-y divide-slate-700">
              {earningsCalendar.map((event, i) => (
                <div key={i} className="p-6 hover:bg-slate-900/50 transition-colors">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-bold text-lg text-cyan-400">{event.symbol}</span>
                        <span className={`text-xs px-2 py-1 rounded ${event.importance === 'high' ? 'bg-red-500/20 text-red-300' : 'bg-yellow-500/20 text-yellow-300'}`}>{event.importance.toUpperCase()}</span>
                      </div>
                      <p className="text-slate-400 text-sm">{event.company}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-white">{event.date}</p>
                      {event.eps_estimate && <p className="text-xs text-slate-400">EPS: ${event.eps_estimate}</p>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recommendations Tab */}
        {activeTab === 'recommendations' && (
          <div className="space-y-4">
            {generateRecommendations().map((rec, i) => (
              <div key={i} className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-6">
                <div className="flex items-start gap-3">
                  <AlertCircle size={20} className="text-blue-400 flex-shrink-0 mt-1" />
                  <div>
                    <h3 className="text-lg font-bold text-white">{rec.title}</h3>
                    <p className="text-slate-300 text-sm mt-1">{rec.description}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Analysis Tab */}
        {activeTab === 'analysis' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
              <h3 className="text-lg font-bold text-cyan-400 mb-4 flex items-center gap-2">
                <LineChart size={20} /> Key Metrics
              </h3>
              <div className="space-y-4">
                <div>
                  <p className="text-slate-400 text-sm mb-1">Avg P/E Ratio</p>
                  <p className="text-2xl font-bold text-white">
                    {portfolio.length > 0
                      ? (portfolio.reduce((sum, s) => sum + (s.pe || 0), 0) / portfolio.filter(s => s.pe).length).toFixed(1)
                      : 'N/A'}
                  </p>
                </div>
                <div>
                  <p className="text-slate-400 text-sm mb-1">Avg Dividend Yield</p>
                  <p className="text-2xl font-bold text-green-400">
                    {portfolio.length > 0
                      ? `${(portfolio.reduce((sum, s) => sum + (s.dividendYield || 0), 0) / portfolio.length).toFixed(2)}%`
                      : 'N/A'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Detail Panel */}
      {selectedStock && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-slate-900 border-b border-slate-700 p-6 flex justify-between items-center">
              <h2 className="text-2xl font-bold text-cyan-400">{selectedStock.symbol} - {selectedStock.name}</h2>
              <button onClick={() => setSelectedStock(null)} className="text-slate-400 hover:text-white"><X size={24} /></button>
            </div>

            <div className="p-6 space-y-6">
              {/* Price History Chart */}
              {selectedStock.historicalPrices && (
                <div className="bg-slate-800 border border-slate-700 rounded-lg p-6">
                  <h3 className="text-lg font-bold text-cyan-400 mb-4">Price History (9 Months)</h3>
                  <div className="h-64 bg-slate-900 rounded flex items-end gap-1 p-4 overflow-x-auto">
                    {selectedStock.historicalPrices.map((ph, i) => {
                      const maxPrice = Math.max(...selectedStock.historicalPrices.map(p => p.price));
                      const minPrice = Math.min(...selectedStock.historicalPrices.map(p => p.price));
                      const range = maxPrice - minPrice;
                      const height = ((ph.price - minPrice) / range * 100);
                      
                      return (
                        <div key={i} className="flex-1 flex flex-col items-center gap-2 min-w-12">
                          <div className="w-full bg-gradient-to-t from-cyan-500 to-blue-500 rounded-t hover:opacity-80 transition-opacity cursor-pointer" style={{ height: `${Math.max(height, 5)}%` }} />
                          <span className="text-xs text-slate-500">{ph.date.split('/')[0]}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Fundamentals */}
              <div className="grid grid-cols-2 gap-6">
                <div className="bg-slate-800 border border-slate-700 rounded-lg p-6">
                  <h3 className="text-lg font-bold text-blue-400 mb-4">Fundamentals</h3>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-slate-400">P/E Ratio</span>
                      <span className="font-semibold text-white">{selectedStock.pe ? selectedStock.pe.toFixed(1) : 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">EPS</span>
                      <span className="font-semibold text-white">${selectedStock.eps ? selectedStock.eps.toFixed(2) : 'N/A'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Dividend Yield</span>
                      <span className="font-semibold text-white">{selectedStock.dividendYield ? selectedStock.dividendYield.toFixed(2) : '0'}%</span>
                    </div>
                  </div>
                </div>

                {/* ETF Holdings */}
                {selectedStock.isETF && selectedStock.holdings && (
                  <div className="bg-slate-800 border border-slate-700 rounded-lg p-6">
                    <h3 className="text-lg font-bold text-cyan-400 mb-4">Top Holdings</h3>
                    <div className="space-y-2">
                      {selectedStock.holdings.map((holding, i) => (
                        <div key={holding} className="flex justify-between items-center">
                          <span className="text-slate-300">{holding}</span>
                          <div className="flex-1 mx-3 bg-slate-600 rounded-full h-2">
                            <div className="bg-gradient-to-r from-cyan-500 to-blue-500 h-2 rounded-full" style={{ width: `${selectedStock.holdingWeights[i]}%` }} />
                          </div>
                          <span className="text-sm font-semibold text-cyan-400">{selectedStock.holdingWeights[i]}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EnhancedPortfolioDashboard;
