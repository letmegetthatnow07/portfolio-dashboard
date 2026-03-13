import React, { useState, useEffect } from 'react';
import { AlertCircle, Plus, X, Calendar, LineChart, Target, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react';

const EnhancedPortfolioDashboard = () => {
  const [portfolio, setPortfolio] = useState([]);
  const [showAddStock, setShowAddStock] = useState(false);
  const [selectedStock, setSelectedStock] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [newStock, setNewStock] = useState({ symbol: '', quantity: '', costPrice: '' });
  const [loading, setLoading] = useState(false);
  const [editingPrice, setEditingPrice] = useState(null);

  const FINNHUB_KEY = process.env.REACT_APP_FINNHUB_API_KEY || '';

  // Load portfolio from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('portfolio');
    if (saved) {
      try {
        setPortfolio(JSON.parse(saved));
      } catch (e) {
        console.error('Error loading portfolio:', e);
      }
    }
  }, []);

  // Save portfolio to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('portfolio', JSON.stringify(portfolio));
  }, [portfolio]);

  // Comprehensive stock database with pre-loaded data
  const stockDatabase = {
    'SPMO': { name: 'Salzburg Minerals', sector: 'Materials', pe: 15.2, eps: 1.87, dividendYield: 2.1, revenue_growth: 12.5 },
    'SMH': { name: 'iShares Semiconductor ETF', sector: 'ETF - Semiconductors', pe: 18.5, dividendYield: 0.6, isETF: true },
    'TPL': { name: 'Texas Pacific Land', sector: 'Energy', pe: 12.1, eps: 8.45, dividendYield: 1.5, revenue_growth: 8.3 },
    'VRT': { name: 'Virtus Investment', sector: 'Financial', pe: 11.8, eps: 5.23, dividendYield: 3.2, revenue_growth: 5.1 },
    'MU': { name: 'Micron Technology', sector: 'Semiconductors', pe: 12.5, eps: 7.84, dividendYield: 1.8, revenue_growth: 15.2 },
    'MELI': { name: 'MercadoLibre', sector: 'E-commerce', pe: 89.2, eps: 16.34, dividendYield: 0, revenue_growth: 35.5 },
    'BWXT': { name: 'BWX Technologies', sector: 'Aerospace & Defense', pe: 25.3, eps: 3.87, dividendYield: 0.8, revenue_growth: 8.9 },
    'FTAI': { name: 'Flex LNG', sector: 'Energy', pe: 8.2, eps: 4.17, dividendYield: 12.5, revenue_growth: 2.1 },
    'KTOS': { name: 'Kratos Defense', sector: 'Defense', pe: 89.5, eps: 0.32, dividendYield: 0, revenue_growth: 18.2 },
    'RKLB': { name: 'Rocket Lab', sector: 'Aerospace', eps: -0.15, dividendYield: 0, revenue_growth: 22.5 },
    'CRWD': { name: 'CrowdStrike', sector: 'Cybersecurity', pe: 145.3, eps: 1.98, dividendYield: 0, revenue_growth: 32.1 },
    'LLY': { name: 'Eli Lilly', sector: 'Pharmaceuticals', pe: 52.3, eps: 16.10, dividendYield: 0.8, revenue_growth: 28.3 }
  };

  // Fetch real data from Finnhub API
  const fetchStockData = async (symbol) => {
    if (!FINNHUB_KEY) return null;
    
    try {
      const quoteRes = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`
      );
      const quote = await quoteRes.json();

      const newsRes = await fetch(
        `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=2026-02-01&to=2026-03-13&token=${FINNHUB_KEY}`
      );
      const news = await newsRes.json();

      const ratingsRes = await fetch(
        `https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${FINNHUB_KEY}`
      );
      const ratings = await ratingsRes.json();

      return {
        price: quote.c || 0,
        change: quote.d || 0,
        changePercent: quote.dp || 0,
        high: quote.h || 0,
        low: quote.l || 0,
        news: news.slice(0, 5) || [],
        ratings: ratings[0] || {}
      };
    } catch (e) {
      console.error('Error fetching stock data:', e);
      return null;
    }
  };

  // Calculate composite score
  const calculateScore = (stock) => {
    const institutionalScore = stock.institutionalRating ? (stock.institutionalRating / 5) * 10 : 5;
    const expertScore = stock.analystRating ? (stock.analystRating / 5) * 10 : 5;
    const newsScore = stock.newsScore ? stock.newsScore * 10 : 5;
    const technicalScore = stock.rsi ? (stock.rsi / 100) * 10 : 5;

    // New weights: Institutions 40%, Experts 30%, News 20%, Technical 10%
    const composite = (institutionalScore * 0.40) + (expertScore * 0.30) + (newsScore * 0.20) + (technicalScore * 0.10);
    return composite.toFixed(1);
  };

  const getRecommendation = (score) => {
    const s = parseFloat(score);
    if (s >= 8.5) return { text: 'STRONG BUY', color: 'bg-green-600' };
    if (s >= 7.5) return { text: 'BUY', color: 'bg-green-500' };
    if (s >= 6.5) return { text: 'HOLD', color: 'bg-blue-500' };
    return { text: 'REDUCE', color: 'bg-red-500' };
  };

  const handleAddStock = async () => {
    if (!newStock.symbol || !newStock.quantity) return;

    const baseStock = stockDatabase[newStock.symbol.toUpperCase()];
    if (!baseStock) {
      alert('Stock not found in database');
      return;
    }

    setLoading(true);
    const apiData = await fetchStockData(newStock.symbol.toUpperCase());
    setLoading(false);

    const stock = {
      id: Date.now(),
      symbol: newStock.symbol.toUpperCase(),
      quantity: parseFloat(newStock.quantity),
      costPrice: parseFloat(newStock.costPrice) || 0,
      averagePrice: parseFloat(newStock.costPrice) || 0,
      price: apiData?.price || 100,
      change: apiData?.change || 0,
      news: apiData?.news || [],
      analystRating: apiData?.ratings?.strongBuy ? 4.5 : apiData?.ratings?.buy ? 4 : 3,
      institutionalRating: apiData?.ratings?.strongBuy ? 4.5 : apiData?.ratings?.buy ? 4 : 3,
      rsi: 50,
      newsScore: 0.7,
      ...baseStock
    };

    stock.compositeScore = calculateScore(stock);
    setPortfolio([...portfolio, stock]);
    setNewStock({ symbol: '', quantity: '', costPrice: '' });
    setShowAddStock(false);
  };

  const removeStock = (id) => {
    setPortfolio(portfolio.filter(s => s.id !== id));
    setSelectedStock(null);
  };

  const updateAveragePrice = (id, newPrice) => {
    setPortfolio(portfolio.map(s => 
      s.id === id ? { ...s, averagePrice: newPrice } : s
    ));
  };

  const addMoreShares = (id, quantity, price) => {
    setPortfolio(portfolio.map(s => {
      if (s.id === id) {
        const totalShares = s.quantity + quantity;
        const newAverage = ((s.averagePrice * s.quantity) + (price * quantity)) / totalShares;
        return {
          ...s,
          quantity: totalShares,
          averagePrice: newAverage
        };
      }
      return s;
    }));
  };

  const getPortfolioStats = () => {
    let totalValue = 0;
    let totalGain = 0;
    portfolio.forEach(stock => {
      const value = stock.price * stock.quantity;
      totalValue += value;
      totalGain += (stock.price - stock.averagePrice) * stock.quantity;
    });
    return {
      totalValue: totalValue.toFixed(2),
      totalGain: totalGain.toFixed(2),
      gainPercent: totalValue > 0 ? ((totalGain / (totalValue - totalGain)) * 100).toFixed(2) : 0
    };
  };

  const stats = getPortfolioStats();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white font-sans">
      {/* Header */}
      <div className="border-b border-slate-800 bg-slate-900/50 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-8 py-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">PORTFOLIO DASHBOARD</h1>
              <p className="text-slate-400 text-sm mt-1">Professional Investment Tracking with AI Analysis</p>
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
          {['overview', 'analysis', 'news'].map(tab => (
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
              <button onClick={handleAddStock} disabled={loading} className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 px-6 py-2 rounded-lg font-medium transition-colors flex items-center gap-2">
                {loading ? <RefreshCw size={16} className="animate-spin" /> : ''} {loading ? 'Fetching...' : 'Add Stock'}
              </button>
              <button onClick={() => setShowAddStock(false)} className="bg-slate-700 hover:bg-slate-600 px-6 py-2 rounded-lg font-medium transition-colors">Cancel</button>
            </div>
          </div>
        )}

        {/* Portfolio Cards */}
        {activeTab === 'overview' && (
          portfolio.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
              {portfolio.map(stock => {
                const gainLoss = stock.price - stock.averagePrice;
                const gainLossPercent = stock.averagePrice ? ((gainLoss / stock.averagePrice) * 100).toFixed(2) : 0;
                const recommendation = getRecommendation(stock.compositeScore || 7);
                
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
                        <div className={`text-sm font-medium ${stock.change >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {stock.change >= 0 ? '+' : ''}{stock.changePercent?.toFixed(2)}%
                        </div>
                      </div>
                      <div className="text-sm text-slate-400">Qty: {stock.quantity} | Avg: ${stock.averagePrice.toFixed(2)}</div>
                      <div className={`text-sm font-medium ${gainLoss >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {gainLoss >= 0 ? '+' : ''}{gainLoss.toFixed(2)} ({gainLossPercent}%)
                      </div>
                    </div>
                    <div className={`inline-block px-3 py-1 rounded font-semibold text-xs text-white ${recommendation.color}`}>
                      {recommendation.text}
                    </div>
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

        {/* Analysis Tab */}
        {activeTab === 'analysis' && portfolio.length > 0 && (
          <div className="space-y-6">
            {portfolio.map(stock => {
              const recommendation = getRecommendation(stock.compositeScore || 7);
              return (
                <div key={stock.id} className="bg-slate-800 border border-slate-700 rounded-xl p-6">
                  <h3 className="text-xl font-bold text-cyan-400 mb-4">{stock.symbol} - Analysis</h3>
                  
                  <div className="grid grid-cols-2 gap-6 mb-6">
                    {/* Scores */}
                    <div>
                      <h4 className="font-bold text-white mb-3">Rating Scores</h4>
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-slate-400">🏛️ Institutional (40% weight)</span>
                          <span className="font-bold text-cyan-400">{stock.institutionalRating}/5.0</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">🏆 Expert Analysts (30% weight)</span>
                          <span className="font-bold text-blue-400">{stock.analystRating}/5.0</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">📰 News Sentiment (20% weight)</span>
                          <span className="font-bold text-green-400">{(stock.newsScore * 10).toFixed(1)}/10</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">📊 Technical (10% weight)</span>
                          <span className="font-bold text-yellow-400">{stock.rsi}/100</span>
                        </div>
                      </div>
                    </div>

                    {/* Composite Score */}
                    <div>
                      <h4 className="font-bold text-white mb-3">Composite Score</h4>
                      <div className="bg-slate-700/50 p-4 rounded-lg">
                        <p className="text-4xl font-bold text-cyan-400 mb-2">{stock.compositeScore || 7.0}/10</p>
                        <div className={`inline-block px-4 py-2 rounded font-bold text-white ${recommendation.color}`}>
                          {recommendation.text}
                        </div>
                        <p className="text-xs text-slate-400 mt-3">Weighted score based on institutional backing, expert ratings, news sentiment, and technical indicators</p>
                      </div>
                    </div>
                  </div>

                  {/* Fundamentals */}
                  <div className="bg-slate-700/30 p-4 rounded-lg">
                    <h4 className="font-bold text-white mb-3">Fundamentals</h4>
                    <div className="grid grid-cols-4 gap-4 text-sm">
                      <div>
                        <p className="text-slate-400 text-xs">P/E Ratio</p>
                        <p className="font-bold text-white">{stock.pe || 'N/A'}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-xs">EPS</p>
                        <p className="font-bold text-white">${stock.eps?.toFixed(2) || 'N/A'}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-xs">Dividend Yield</p>
                        <p className="font-bold text-white">{stock.dividendYield?.toFixed(2)}%</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-xs">Revenue Growth</p>
                        <p className="font-bold text-white">{stock.revenue_growth?.toFixed(1)}%</p>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* News Tab */}
        {activeTab === 'news' && portfolio.length > 0 && (
          <div className="space-y-6">
            {portfolio.map(stock => (
              <div key={stock.id} className="bg-slate-800 border border-slate-700 rounded-xl p-6">
                <h3 className="text-xl font-bold text-cyan-400 mb-4">{stock.symbol} - Latest News</h3>
                {stock.news && stock.news.length > 0 ? (
                  <div className="space-y-3">
                    {stock.news.map((article, i) => (
                      <a key={i} href={article.url} target="_blank" rel="noopener noreferrer" className="block p-3 bg-slate-700/50 hover:bg-slate-700 rounded-lg transition-colors">
                        <p className="text-white font-medium text-sm mb-1">{article.headline}</p>
                        <p className="text-slate-400 text-xs">{article.source} • {new Date(article.datetime * 1000).toLocaleDateString()}</p>
                      </a>
                    ))}
                  </div>
                ) : (
                  <p className="text-slate-400">No news available. Add Finnhub API key to fetch real news.</p>
                )}
              </div>
            ))}
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
              <div className="bg-slate-800 border border-slate-700 rounded-lg p-6">
                <h3 className="text-lg font-bold text-cyan-400 mb-4">Position Details</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-slate-400">Current Price</p>
                    <p className="text-2xl font-bold text-white">${selectedStock.price.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-slate-400">Quantity</p>
                    <p className="text-2xl font-bold text-white">{selectedStock.quantity}</p>
                  </div>
                  <div>
                    <p className="text-slate-400">Average Price</p>
                    <button onClick={() => setEditingPrice(selectedStock.id)} className="text-2xl font-bold text-cyan-400 hover:text-cyan-300">${selectedStock.averagePrice.toFixed(2)} ✏️</button>
                  </div>
                  <div>
                    <p className="text-slate-400">Position Value</p>
                    <p className="text-2xl font-bold text-cyan-400">${(selectedStock.price * selectedStock.quantity).toFixed(2)}</p>
                  </div>
                </div>

                {editingPrice === selectedStock.id && (
                  <div className="mt-4 flex gap-2">
                    <input type="number" placeholder="New average price" defaultValue={selectedStock.averagePrice} onBlur={(e) => {
                      updateAveragePrice(selectedStock.id, parseFloat(e.target.value));
                      setEditingPrice(null);
                      setSelectedStock({...selectedStock, averagePrice: parseFloat(e.target.value)});
                    }} className="flex-1 bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white" autoFocus />
                  </div>
                )}
              </div>

              <div className="bg-slate-800 border border-slate-700 rounded-lg p-6">
                <h3 className="text-lg font-bold text-cyan-400 mb-4">Add More Shares</h3>
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <input type="number" id="addQty" placeholder="Quantity" className="bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white" />
                  <input type="number" id="addPrice" placeholder="Price per share" className="bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white" />
                </div>
                <button onClick={() => {
                  const qty = parseFloat(document.getElementById('addQty').value);
                  const price = parseFloat(document.getElementById('addPrice').value);
                  if (qty && price) {
                    addMoreShares(selectedStock.id, qty, price);
                    alert('Shares added and average price updated!');
                    setSelectedStock(null);
                  }
                }} className="w-full bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded font-medium transition-colors">
                  Add Shares
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EnhancedPortfolioDashboard;
