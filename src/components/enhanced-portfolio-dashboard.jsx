import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Stock, MarketRegime, PortfolioStats } from '../types';
import { MOCK_PORTFOLIO, MOCK_MARKET_REGIME, MOCK_STATS } from '../mockData';
import NeuralBackground from './NeuralBackground';
import CorrelationHeatmap from './CorrelationHeatmap';

// ─── Signal & Regime Configuration ────────────────────────────────────────────
// BUG FIX: Signal and Regime are SEPARATE concerns.
// signal = recommended ACTION for the investor
// regime = the market/stock CONDITION providing context
// When signal === regime (e.g. WATCH), only one is displayed.
//
// The original code added WATCH, IDIOSYNCRATIC_DECAY etc. to BOTH SIGNAL_CFG and
// REGIME_CFG, then rendered both columns unconditionally — causing the duplicate.
// Fix: regime column is hidden when it provides no additional information
// beyond what the signal already communicates.

const SIGNAL_CFG: Record<string, {
  color: string; label: string; tier: 'bull' | 'flat' | 'bear';
  badge: string;   // plain-English badge shown in the signal column
  action: string;  // one-liner action for non-expert investors
  why: string;     // brief rationale
}> = {
  ADD: {
    color: '#059669', label: 'Add', tier: 'bull',
    badge: '▲ Add',
    action: 'Consider adding to your position.',
    why: 'High quality + technicals aligned + insider buying. Strong conviction hold.',
  },
  SPRING_CONFIRMED: {
    color: '#047857', label: 'Spring ✓', tier: 'bull',
    badge: '🌱 Spring',
    action: 'Quality stock bouncing from a low. Good entry window.',
    why: '3-day recovery confirmed after a sharp dip on a high-quality business — classic Wyckoff spring.',
  },
  SPRING_CANDIDATE: {
    color: '#10b981', label: 'Spring ~', tier: 'bull',
    badge: '🌱 Forming',
    action: 'Possible entry forming — monitor for 3-day confirmation.',
    why: 'Price dipped sharply on a high-quality stock. Watch for follow-through before adding.',
  },
  STRONG_BUY: {
    color: '#2563eb', label: 'Strong Buy', tier: 'bull',
    badge: '⬆ Strong Buy',
    action: 'A compelling opportunity — consider a full position.',
    why: 'Fundamentals, technicals, and analyst consensus all pointing strongly positive.',
  },
  BUY: {
    color: '#3b82f6', label: 'Buy', tier: 'bull',
    badge: '↑ Buy',
    action: 'Reasonable opportunity to build or hold a position.',
    why: 'Quality score and trend support a constructive view.',
  },
  HOLD: {
    color: '#6b7280', label: 'Hold', tier: 'flat',
    badge: '→ Hold',
    action: 'Keep your position. No action needed.',
    why: 'Quality intact, no meaningful new signal. Stay the course.',
  },
  HOLD_NOISE: {
    color: '#9ca3af', label: 'Hold · Noise', tier: 'flat',
    badge: '→ Hold (Noise)',
    action: 'Hold. Recent movement looks like market noise.',
    why: 'Short-term volatility with no change to fundamentals. Avoid reacting.',
  },
  NORMAL: {
    color: '#6b7280', label: 'Normal', tier: 'flat',
    badge: '→ Normal',
    action: 'Hold your position at current size.',
    why: 'No elevated signal in either direction.',
  },
  MARKET_NOISE: {
    color: '#9ca3af', label: 'Market Noise', tier: 'flat',
    badge: '~ Mkt Noise',
    action: 'Ignore short-term swings. Hold.',
    why: 'Broad market choppiness — not driven by this stock\'s fundamentals.',
  },
  WATCH: {
    color: '#d97706', label: 'Watch', tier: 'bear',
    badge: '⚠ Watch',
    action: 'Review your thesis. Consider trimming if fundamentals weaken.',
    why: 'Some metrics are deteriorating. Quality still adequate but deserves scrutiny.',
  },
  TRIM_25: {
    color: '#ea580c', label: 'Trim 25%', tier: 'bear',
    badge: '↓ Trim 25%',
    action: 'Reduce your position by ~25% to manage risk.',
    why: 'Multiple warning signals. Reduce exposure while monitoring for recovery.',
  },
  REDUCE: {
    color: '#dc2626', label: 'Reduce', tier: 'bear',
    badge: '↓ Reduce',
    action: 'Cut your position size significantly.',
    why: 'Fundamentals weakening materially. Reducing protects your capital.',
  },
  SELL: {
    color: '#b91c1c', label: 'Sell', tier: 'bear',
    badge: '✕ Sell',
    action: 'Exit the position.',
    why: 'Investment thesis has broken down. Continued holding carries excessive risk.',
  },
  IDIOSYNCRATIC_DECAY: {
    color: '#7f1d1d', label: 'Decay', tier: 'bear',
    badge: '☠ Decay',
    action: 'Exit or significantly reduce. This stock is deteriorating independently of the market.',
    why: 'The business itself is losing competitiveness — not just market volatility. Revenue shrinking, margins falling, or debt rising while peers hold up.',
  },
  INSUFFICIENT_DATA: {
    color: '#9ca3af', label: 'No Data', tier: 'flat',
    badge: '? Pending',
    action: 'Awaiting data. No action yet.',
    why: 'Score not yet computed for this asset.',
  },
};

// Regime config — provides context ADDITIONAL to the signal.
// NOTE: regime is only shown in the UI when it differs meaningfully from signal
// (i.e. it adds new context). When regime === signal the column is suppressed.
const REGIME_CFG: Record<string, { color: string; label: string; description: string }> = {
  NORMAL:              { color: '#6b7280', label: 'Normal',           description: 'Business performing in line with expectations.' },
  MARKET_NOISE:        { color: '#9ca3af', label: 'Market Noise',     description: 'Broad market volatility — not stock-specific.' },
  WATCH:               { color: '#d97706', label: 'Watch',            description: 'Mild deterioration — close monitoring warranted.' },
  IDIOSYNCRATIC_DECAY: { color: '#dc2626', label: 'Biz Deteriorating',description: 'Company-specific decline independent of market.' },
  INSUFFICIENT_DATA:   { color: '#9ca3af', label: 'No Data',          description: 'Insufficient data for regime classification.' },
  BEAR:                { color: '#b91c1c', label: 'Bear Market',       description: 'Broad market in sustained decline.' },
  STRESSED:            { color: '#d97706', label: 'Stressed',          description: 'Market under meaningful pressure.' },
};

const sig = (s?: string) => SIGNAL_CFG[s ?? ''] ?? { color: '#6b7280', label: s ?? 'Pending', tier: 'flat' as const, badge: '?', action: '—', why: '—' };
const reg = (r?: string) => REGIME_CFG[r ?? ''] ?? { color: '#6b7280', label: r ?? 'Normal', description: '' };

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtUSD = (n?: number | null, compact = false): string => {
  if (n == null || isNaN(n)) return 'N/A';
  if (compact && Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (compact && Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
};

const fmtPct = (n?: number | null, dp = 2): string => {
  if (n == null || isNaN(n)) return 'N/A';
  return `${n >= 0 ? '+' : ''}${Number(n).toFixed(dp)}%`;
};

const scoreCol = (s?: number | null): string => {
  if (s == null) return '#9ca3af';
  if (s >= 8)   return '#059669';
  if (s >= 6.5) return '#2563eb';
  if (s >= 5)   return '#d97706';
  return '#dc2626';
};

const moatCol = (s?: number | null): string => {
  if (s == null) return '#9ca3af';
  if (s >= 7)   return '#059669';
  if (s >= 5)   return '#2563eb';
  if (s >= 3)   return '#d97706';
  return '#dc2626';
};

// ─── Score Ring ───────────────────────────────────────────────────────────────
const ScoreRing: React.FC<{ score?: number | null }> = ({ score }) => {
  const r = 17, circ = 2 * Math.PI * r;
  const col = scoreCol(score);
  return (
    <div className="score-ring" title={`Quality Score: ${score?.toFixed(1) ?? '—'}/10`}>
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r={r} fill="none" stroke="#e6e5df" strokeWidth="2.5" />
        <circle cx="22" cy="22" r={r} fill="none" stroke={col} strokeWidth="2.5"
          strokeDasharray={`${Math.max(0, Math.min(10, score ?? 0)) / 10 * circ} ${circ}`}
          strokeLinecap="round" transform="rotate(-90 22 22)"
          style={{ transition: 'stroke-dasharray .5s ease' }} />
      </svg>
      <span className="score-ring-num" style={{ color: col }}>
        {score != null ? score.toFixed(1) : '—'}
      </span>
    </div>
  );
};

// ─── Moat Ring ────────────────────────────────────────────────────────────────
const MoatRing: React.FC<{ score?: number | null }> = ({ score }) => {
  if (score == null) return null;
  const r = 11, circ = 2 * Math.PI * r;
  const col = moatCol(score);
  return (
    <div className="moat-ring" title={`Moat: ${score.toFixed(1)}/10 — ROIC premium, gross margin, revenue durability`}>
      <svg width="30" height="30" viewBox="0 0 30 30">
        <circle cx="15" cy="15" r={r} fill="none" stroke="#e6e5df" strokeWidth="2" />
        <circle cx="15" cy="15" r={r} fill="none" stroke={col} strokeWidth="2"
          strokeDasharray={`${Math.max(0, Math.min(10, score)) / 10 * circ} ${circ}`}
          strokeLinecap="round" transform="rotate(-90 15 15)"
          style={{ transition: 'stroke-dasharray .4s ease' }} />
      </svg>
      <span className="moat-ring-num" style={{ color: col }}>{score.toFixed(1)}</span>
    </div>
  );
};

// ─── Spring Bar ───────────────────────────────────────────────────────────────
const SpringBar: React.FC<{ days?: number }> = ({ days }) => {
  if (!days || days <= 0) return null;
  const col = days >= 3 ? '#047857' : '#10b981';
  const tip = days >= 3
    ? 'Spring CONFIRMED: Quality stock has recovered for 3+ consecutive days from a price dip. Historically a good entry window for long-term investors.'
    : `Spring forming — Day ${days}/3. Quality business dipped and is recovering. Wait for Day 3 (Confirmed) before adding.`;
  return (
    <div className="spring-bar" title={tip}>
      <div className="spring-track">
        <div className="spring-fill" style={{ width: `${Math.min(days, 3) / 3 * 100}%`, background: col }} />
      </div>
      <span className="spring-label" style={{ color: col }}>
        {days >= 3 ? '🌱 Spring Confirmed — entry window' : `🌱 Spring Day ${days}/3 — watch`}
      </span>
    </div>
  );
};

// ─── Cascade Pips ─────────────────────────────────────────────────────────────
// CascadePips — shows the multi-timeframe decay cascade.
// W1 (7-day) is suppressed: too short-term for a 3-7yr mandate, creates noise.
// W2+ = structurally meaningful. Only rendered when W2 or higher is active.
// W3 + W4 together = highest conviction sell signal the system can produce.
const CascadePips: React.FC<{ w1?: boolean; w2?: boolean; w3?: boolean; w4?: boolean }> = ({ w1: _w1, w2, w3, w4 }) => {
  // Don't render anything when only W1 is active — short-term noise
  if (!w2 && !w3 && !w4) return null;

  const pips = [
    {
      k: 'W2', on: w2, col: '#d97706',
      tip: 'W2: 3-week score decline — short-term concern. Monitor, don't panic.',
    },
    {
      k: 'W3', on: w3, col: '#dc2626',
      tip: 'W3: 3-month structural decline confirmed. Consider reviewing your thesis.',
    },
    {
      k: 'W4', on: w4, col: '#7f1d1d',
      tip: 'W4: 12-month sustained deterioration. Strongest sell signal in the system.',
    },
  ];

  const activeCount = pips.filter(p => p.on).length;
  const severity = activeCount >= 3 ? 'Serious (W2+W3+W4)' : activeCount === 2 ? 'Elevated' : 'Watch';

  return (
    <div className="cascade-pips"
      title={`Decay cascade — ${severity}. ${pips.filter(p=>p.on).map(p=>p.tip).join(' ')}`}>
      {pips.map(p => (
        <span key={p.k}
          className={`pip ${p.on ? 'pip-on' : 'pip-off'}`}
          style={p.on ? { background: p.col, borderColor: p.col } : {}}
          title={p.tip}>
          {p.k}
        </span>
      ))}
    </div>
  );
};

// ─── Fund Row ─────────────────────────────────────────────────────────────────
const FundRow: React.FC<{
  label: string; value?: string | null; hint?: string; positive?: boolean | null;
}> = ({ label, value, hint, positive }) => {
  if (value == null || value === 'N/A') return null;
  return (
    <div className="fund-row" title={hint}>
      <span className="fund-lbl">{label}</span>
      <span className="fund-val" style={
        positive === true ? { color: '#059669' } :
        positive === false ? { color: '#dc2626' } : {}
      }>{value}</span>
    </div>
  );
};

// ─── Score Bar Row ────────────────────────────────────────────────────────────
const ScoreBarRow: React.FC<{
  label: string; score?: number | null; hint?: string;
}> = ({ label, score, hint }) => {
  if (score == null) return null;
  const col = scoreCol(score);
  return (
    <div className="fund-row" title={hint} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
        <span className="fund-lbl">{label}</span>
        <span className="fund-val" style={{ color: col }}>{score.toFixed(1)}/10</span>
      </div>
      <div className="score-bar-wrap" style={{ width: '100%' }}>
        <div className="score-bar-track">
          <div className="score-bar-fill"
            style={{ width: `${score / 10 * 100}%`, background: col }} />
        </div>
      </div>
    </div>
  );
};

// ─── Action Guidance Card ─────────────────────────────────────────────────────
// NEW: A plain-English card explaining what to do and why — for non-experts
const ActionCard: React.FC<{ stock: Stock }> = ({ stock }) => {
  const sCfg = sig(stock.signal);
  const rCfg = reg(stock.regime);

  const cardClass =
    sCfg.tier === 'bull' ? 'action-card action-card-bull' :
    sCfg.tier === 'bear' && ['WATCH', 'TRIM_25'].includes(stock.signal ?? '') ? 'action-card action-card-amber' :
    sCfg.tier === 'bear' ? 'action-card action-card-bear' :
    'action-card action-card-flat';

  const titleColor = sCfg.color;

  // Build context bullets
  const bullets: string[] = [];

  if (stock.latest_score != null) {
    const qStr = stock.latest_score >= 8 ? 'High' : stock.latest_score >= 6.5 ? 'Good' : stock.latest_score >= 5 ? 'Fair' : 'Poor';
    bullets.push(`Quality score: ${qStr} (${stock.latest_score.toFixed(1)}/10)`);
  }
  if (stock.moat_score != null) {
    const mStr = stock.moat_score >= 7 ? 'Strong' : stock.moat_score >= 5 ? 'Moderate' : 'Weak';
    bullets.push(`Competitive moat: ${mStr} (${stock.moat_score.toFixed(1)}/10)`);
  }
  // fcf_yield: treat 0 as null (API often returns 0 when data is missing, not genuine 0% yield)
  if (stock.fcf_yield != null && stock.fcf_yield > 0) {
    const fy = stock.fcf_yield * 100;
    const fyLabel = fy > 5 ? 'attractive entry' : fy > 3 ? 'fair value' : fy > 1.5 ? 'expensive' : 'very expensive';
    bullets.push(`FCF yield: ${fy.toFixed(1)}% — ${fyLabel}`);
  }
  if (stock.excess_return != null) {
    bullets.push(`Outperforming market by ${fmtPct(stock.excess_return)} (Jensen's α)`);
  }
  if (stock.max_drawdown != null && stock.max_drawdown < -25) {
    bullets.push(`Peak drawdown: ${stock.max_drawdown.toFixed(1)}% — elevated risk`);
  }
  if (stock.spring_days && stock.spring_days > 0) {
    bullets.push(`🌱 Spring signal day ${stock.spring_days}/3 — potential bounce entry`);
  }
  if (stock.sharp_score_drop) {
    bullets.push(`⚡ Score dropped ${Math.abs(stock.score_delta_1d ?? 0).toFixed(1)} pts vs yesterday — review thesis`);
  }
  if (stock.earnings_quality_flag === 'risk') {
    bullets.push('⚠ Earnings quality risk: cash flow lagging reported profit');
  }
  if (stock.debt_maturity_flag === 'wall') {
    bullets.push('⚠ Near-term debt maturity wall — refinancing risk');
  }
  if (stock.cyclical_peak_flag) {
    bullets.push('⚠ May be at peak cycle earnings — not a structural improvement');
  }

  // Regime context — only add if regime differs from signal and adds information
  const regimeDiffersFromSignal = stock.regime !== stock.signal &&
    stock.regime !== 'NORMAL' && stock.regime !== stock.signal;
  if (regimeDiffersFromSignal && rCfg.description) {
    bullets.push(`Market context: ${rCfg.description}`);
  }

  return (
    <div className={`detail-section ${cardClass}`} style={{ borderRadius: 10 }}>
      <div className="detail-section-head">
        <span className="detail-section-title" style={{ color: titleColor }}>
          🎯 What to Do
        </span>
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 4,
          background: sCfg.color + '18', color: sCfg.color,
          border: `1px solid ${sCfg.color}40`,
          fontFamily: 'DM Mono, monospace',
        }}>{sCfg.badge}</span>
      </div>

      <p style={{ fontSize: 13, fontWeight: 600, color: '#1a1918', margin: 0 }}>
        {sCfg.action}
      </p>
      <p style={{ fontSize: 12, color: '#4b4b45', lineHeight: 1.55, margin: 0 }}>
        {sCfg.why}
      </p>

      {bullets.length > 0 && (
        <ul className="action-list">
          {bullets.map((b, i) => (
            <li key={i} style={{
              color: b.startsWith('⚠') || b.startsWith('⚡') ? '#92400e' :
                     b.startsWith('🌱') ? '#166534' : '#4b4b45'
            }}>→ {b}</li>
          ))}
        </ul>
      )}

      {/* Tax awareness note — shown when signal requires selling a profitable position */}
      {(['SELL', 'TRIM_25', 'REDUCE'].includes(stock.signal ?? '')) &&
       stock.current_price != null &&
       stock.average_price > 0 &&
       stock.current_price > stock.average_price && (() => {
        const gainPct = ((stock.current_price - stock.average_price) / stock.average_price) * 100;
        const gainAmt = (stock.current_price - stock.average_price) * stock.quantity;
        return gainPct > 20 ? (
          <div style={{
            marginTop: 4, padding: '8px 12px', borderRadius: 8,
            background: '#fff7ed', border: '1px solid #fed7aa',
            display: 'flex', alignItems: 'flex-start', gap: 8,
          }}>
            <span style={{ fontSize: 14, flexShrink: 0 }}>🇮🇳</span>
            <div style={{ fontSize: 11, color: '#92400e', lineHeight: 1.5 }}>
              <strong>Tax consideration (Indian investor):</strong>{' '}
              This position has a <strong>{gainPct.toFixed(0)}% unrealised gain</strong>{' '}
              (~{gainAmt >= 0 ? '+' : ''}${Math.abs(gainAmt).toFixed(0)} USD).
              {gainPct > 100
                ? ' Selling triggers significant LTCG/STCG. The system requires W4 confirmation (12-month structural decline) before escalating to SELL on large winners. Review the W2/W3 cascade before acting.'
                : ' Review whether the signal strength justifies the capital gains tax bill before selling.'}
            </div>
          </div>
        ) : null;
      })()}

      {stock.hypergrowth_mode && (
        <span style={{
          alignSelf: 'flex-start',
          fontSize: 10, padding: '2px 7px', borderRadius: 4,
          background: '#7c3aed18', color: '#7c3aed',
          border: '1px solid #7c3aed40', fontWeight: 600,
          fontFamily: 'DM Mono, monospace',
        }}>⚡ Hypergrowth Mode — valuation scored leniently</span>
      )}
    </div>
  );
};

// ─── Detail Panel ─────────────────────────────────────────────────────────────
const DetailPanel: React.FC<{ stock: Stock }> = ({ stock }) => {
  const isETF = stock.instrument_type === 'ETF';
  const fcfYieldPct = stock.fcf_yield != null ? stock.fcf_yield * 100 : null;
  const sbcPct = stock.sbc_to_market_cap;
  const filingScore = stock.filing_sentiment;

  const filingLabel = filingScore == null ? null
    : filingScore >= 7 ? 'Positive tone'
    : filingScore >= 5 ? 'Neutral tone'
    : filingScore >= 3 ? 'Cautious tone'
    : 'Negative tone';
  const filingColor = filingScore == null ? '#9ca3af'
    : filingScore >= 7 ? '#059669'
    : filingScore >= 5 ? '#6b7280'
    : filingScore >= 3 ? '#d97706'
    : '#dc2626';

  return (
    <tr className="detail-panel-row">
      <td colSpan={7}>
        <div className="detail-panel">

          {/* Action Guidance — first and most prominent */}
          <ActionCard stock={stock} />

          {/* ETF Panel */}
          {isETF && (
            <div className="detail-section etf-info-section">
              <div className="detail-section-head">
                <span className="detail-section-title">📊 ETF Details</span>
              </div>
              <div className="detail-rows">
                <FundRow label="Type" value="Exchange-Traded Fund"
                  hint="ETFs score on momentum, trend, and news — not individual company fundamentals" />
                {stock.expense_ratio != null && (
                  <FundRow label="Annual Cost (Expense Ratio)"
                    value={`${stock.expense_ratio.toFixed(2)}%/yr`}
                    hint="Annual fee. Under 0.20%/yr is low-cost. Over 0.50%/yr is high."
                    positive={stock.expense_ratio < 0.25} />
                )}
                {stock.max_drawdown != null && (
                  <FundRow label="Max Drawdown (1 Year)"
                    value={`${stock.max_drawdown.toFixed(1)}%`}
                    hint="Largest peak-to-trough loss over the past year"
                    positive={stock.max_drawdown > -20} />
                )}
              </div>
            </div>
          )}

          {/* Moat — stocks only */}
          {!isETF && stock.moat_score != null && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">🏰 Competitive Moat</span>
                <span className="detail-section-score" style={{ color: moatCol(stock.moat_score) }}>
                  {stock.moat_score.toFixed(1)}/10
                </span>
              </div>
              <p style={{ fontSize: 11, color: '#6b6b65', margin: 0 }}>
                How durable and defensible is this business? A wide moat means pricing power,
                high switching costs, and profits that persist for years.
                <span style={{ color: '#2563eb' }}> This score now contributes 20% to the overall quality score</span>
                — so a strong moat directly lifts the signal.
              </p>
              <div className="detail-rows">
                <FundRow label="Gross Profit Margin"
                  value={stock.gross_margin_pct != null ? `${stock.gross_margin_pct.toFixed(1)}%` : null}
                  hint="How much of each revenue dollar turns into gross profit. Over 40% shows pricing power."
                  positive={stock.gross_margin_pct != null && stock.gross_margin_pct > 40} />
                <FundRow label="Revenue Growth (last 12m)"
                  value={stock.revenue_growth_pct != null ? fmtPct(stock.revenue_growth_pct, 1) : null}
                  hint="Year-over-year revenue growth. Over 10% is healthy."
                  positive={stock.revenue_growth_pct != null && stock.revenue_growth_pct > 10} />
                <FundRow label="Revenue Growth (3-year avg)"
                  value={stock.revenue_growth_3y != null ? fmtPct(stock.revenue_growth_3y, 1) : null}
                  hint="Compounded annual growth over 3 years — a durability check. Over 10% sustained = strong moat."
                  positive={stock.revenue_growth_3y != null && stock.revenue_growth_3y > 10} />
              </div>
            </div>
          )}

          {/* Valuation — stocks only */}
          {!isETF && (fcfYieldPct != null || stock.ev_fcf != null) && (fcfYieldPct == null || fcfYieldPct > 0 || stock.ev_fcf != null) && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">💰 Valuation</span>
              </div>
              <p style={{ fontSize: 11, color: '#6b6b65', margin: 0 }}>
                Is the market price attractive relative to the cash this business generates?
              </p>
              <div className="detail-rows">
                <FundRow label="Free Cash Flow Yield"
                  value={fcfYieldPct != null && fcfYieldPct > 0 ? `${fcfYieldPct.toFixed(2)}%` : fcfYieldPct === 0 ? 'Pending data' : null}
                  hint={fcfYieldPct != null && fcfYieldPct > 0 ? `FCF yield of ${fcfYieldPct.toFixed(1)}% — ${fcfYieldPct > 5 ? 'cheap entry (<20x FCF)' : fcfYieldPct > 3 ? 'fair value' : fcfYieldPct > 1.5 ? 'expensive (>67x FCF)' : 'very expensive (>125x FCF)'}` : "FCF yield data is being computed — will update after next EOD run."}
                  positive={fcfYieldPct != null && fcfYieldPct > 3} />
                <FundRow label="EV/FCF (Price vs Cash)"
                  value={stock.ev_fcf != null ? `${stock.ev_fcf.toFixed(1)}×` : null}
                  hint="How many years of free cash flow you're paying. Under 15× = cheap, 15-25× = fair, over 40× = expensive."
                  positive={stock.ev_fcf != null && stock.ev_fcf < 25} />
              </div>
            </div>
          )}

          {/* Risk — stocks only */}
          {!isETF && (stock.max_drawdown != null || sbcPct != null ||
            stock.earnings_quality_flag || stock.debt_maturity_flag ||
            stock.dilution_flag || stock.cyclical_peak_flag) && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">⚠️ Risk Factors</span>
              </div>
              <div className="detail-rows">
                <FundRow label="Largest Drop (1 year)"
                  value={stock.max_drawdown != null ? `${stock.max_drawdown.toFixed(1)}%` : null}
                  hint={stock.max_drawdown != null
                    ? `Peak-to-trough: ${stock.max_drawdown.toFixed(1)}%. ${
                        stock.max_drawdown > -15 ? 'Normal volatility — no action needed.'
                      : stock.max_drawdown > -25 ? 'Meaningful dip — watch for spring entry signal.'
                      : stock.max_drawdown > -40 ? 'Significant drawdown — a -0.5pt penalty applied to technical score.'
                      : 'Severe drawdown — a -1.5pt penalty applied to technical score. Check if thesis intact.'
                      }` : "Peak-to-trough decline over the last year"}
                  positive={stock.max_drawdown != null && stock.max_drawdown > -20} />
                <FundRow label="Dilution Rate (SBC)"
                  value={sbcPct != null ? `${sbcPct.toFixed(2)}%/yr` : null}
                  hint="Share-based compensation as % of market cap. Like a hidden fee you pay as a shareholder. Under 2% = healthy, over 3% = high."
                  positive={sbcPct != null && sbcPct < 2} />
                {stock.sbc_millions != null && (
                  <FundRow label="Annual Dilution Cost"
                    value={`$${stock.sbc_millions.toFixed(0)}M`}
                    hint="Annual stock grants to employees — comes out of shareholder value" />
                )}
                {stock.earnings_quality_flag === 'risk' && (
                  <FundRow label="Earnings Quality"
                    value="⚠ Profits outpace cash"
                    hint="Reported profits look good, but actual cash collected is lower. This can be an early warning sign."
                    positive={false} />
                )}
                {stock.earnings_quality_flag === 'strong' && (
                  <FundRow label="Earnings Quality"
                    value="✓ Strong cash conversion"
                    hint="The business is collecting more cash than its reported profits — a sign of quality earnings."
                    positive={true} />
                )}
                {stock.debt_maturity_flag === 'wall' && (
                  <FundRow label="Debt Repayment Risk"
                    value="⚠ Large debt due soon"
                    hint="Over 30% of the company's debt needs to be repaid or refinanced within 12 months — a risk if rates are high."
                    positive={false} />
                )}
                {stock.debt_maturity_flag === 'watch' && (
                  <FundRow label="Debt Repayment Risk"
                    value="~ Some debt due soon"
                    hint="15-30% of debt matures within 12 months. Worth watching but not critical." />
                )}
                {stock.dilution_flag === 'heavy' && (
                  <FundRow label="Share Dilution"
                    value={`⚠ Shares grew ${stock.shares_yoy_pct?.toFixed(1)}% this year`}
                    hint="The number of shares is growing faster than 5% per year — your ownership slice is shrinking materially."
                    positive={false} />
                )}
                {stock.dilution_flag === 'buyback' && (
                  <FundRow label="Share Count"
                    value={`✓ Buybacks: ${stock.shares_yoy_pct?.toFixed(1)}% vs last year`}
                    hint="The company is reducing share count via buybacks — good for long-term owners."
                    positive={true} />
                )}
                {stock.cyclical_peak_flag && (
                  <FundRow label="Cycle Warning"
                    value="⚠ May be at earnings peak"
                    hint="Margins are unusually high vs history — this may be peak-cycle profitability, not permanent improvement."
                    positive={false} />
                )}
              </div>
            </div>
          )}

          {/* Filing tone — stocks only */}
          {!isETF && filingScore != null && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">📄 Filing Tone</span>
                <span className="detail-section-score" style={{ color: filingColor }}>
                  {filingScore.toFixed(1)}/10
                </span>
              </div>
              <div className="detail-rows">
                <FundRow label={`${stock.filing_form ?? 'Filing'} Language`}
                  value={filingLabel}
                  hint="We analyse the language in SEC filings. Positive = confident tone. Negative = cautious or hedging tone."
                  positive={filingScore >= 6} />
              </div>
            </div>
          )}

          {/* Score breakdown */}
          {(isETF ? stock.score_tech != null : stock.score_fund != null) && (
            <div className="detail-section">
              <div className="detail-section-head">
                <span className="detail-section-title">📐 How the Score is Built</span>
                <span className="detail-section-score" style={{ color: scoreCol(stock.latest_score) }}>
                  {stock.latest_score?.toFixed(1)}/10
                </span>
              </div>
              <p style={{ fontSize: 11, color: '#6b6b65', margin: 0 }}>
                {isETF
                  ? 'ETF score uses price momentum, trend, and news sentiment.'
                  : 'Stock score combines business quality, insider activity, analyst views, trend, and news.'}
              </p>
              <div className="detail-rows">
                {isETF ? (
                  <>
                    <ScoreBarRow label="Price Trend (50%)"   score={stock.score_tech}   hint="Is the ETF above its 200-day average? Uptrend = healthy." />
                    <ScoreBarRow label="News Sentiment (30%)" score={stock.score_news}  hint="Are headlines for this sector positive or negative?" />
                    <ScoreBarRow label="Analyst Views (20%)" score={stock.score_rating} hint="What analysts think about the underlying index." />
                  </>
                ) : (
                  <>
                    <ScoreBarRow label="Business Quality (60%)" score={stock.score_fund}
                      hint="ROIC quality (40%) · SBC-adjusted FCF margin (30%) · Debt level (20%) · Revenue growth (10%) — then blended with competitive moat (20%) and FCF yield valuation adjuster (±1.8 pts). Quality + durability + price in one number." />
                    <ScoreBarRow label="Insider Activity (15%)" score={stock.score_insider}
                      hint="CEO/CFO open-market purchases count triple. Excludes tax withholding, grants, and option exercises. Reduced from 25%: a high-conviction but sparse signal — insider neutrality shouldn't override business quality." />
                    <ScoreBarRow label="Analyst Consensus (10%)" score={stock.score_rating}
                      hint="Wall Street buy/sell/hold consensus + recent upgrade/downgrade velocity" />
                    <ScoreBarRow label="Price Trend (8%)" score={stock.score_tech}
                      hint="SMA-200 trend (60%) + RSI (40%). Oversold quality stocks score as high as healthy uptrends — buy-the-dip calibration for compounders." />
                    <ScoreBarRow label="News Sentiment (7%)" score={stock.score_news}
                      hint="3× daily news runs (9am, 1pm, 4:15pm ET) weighted by recency. Low weight intentional: noise for a 3-7yr holder." />
                    {/* Valuation adjuster is embedded in Business Quality, shown here for transparency */}
                    {stock.fcf_yield != null && stock.fcf_yield > 0 && (() => {
                      const fy = stock.fcf_yield;
                      const adj = fy > 0.06 ? +0.7 : fy > 0.04 ? +0.4 : fy > 0.025 ? +0.1 : fy > 0.015 ? 0 : fy > 0.008 ? -0.8 : -1.8;
                      const adjLabel = adj > 0 ? `+${adj.toFixed(1)} pts (cheap)` : adj < 0 ? `${adj.toFixed(1)} pts (expensive)` : '±0 (fair)';
                      return (
                        <div className="fund-row" title={`FCF yield of ${(fy*100).toFixed(1)}% applied a ${adjLabel} valuation adjustment to Business Quality. Cheap stocks get rewarded; overpriced ones penalised.`}>
                          <span className="fund-lbl" style={{ color: '#6b6b65' }}>↳ Valuation adj (in quality)</span>
                          <span className="fund-val" style={{ color: adj > 0 ? '#059669' : adj < 0 ? '#dc2626' : '#6b7280', fontSize: 11 }}>{adjLabel}</span>
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
            </div>
          )}

        </div>
      </td>
    </tr>
  );
};

// ─── Modal ────────────────────────────────────────────────────────────────────
const Modal: React.FC<{
  onClose: () => void; children: React.ReactNode; wide?: boolean;
}> = ({ onClose, children, wide = false }) =>
  createPortal(
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className={`modal-box${wide ? ' modal-news' : ''}`}
        onMouseDown={e => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body
  );

// ─── Add / Edit Form ──────────────────────────────────────────────────────────
interface FormData {
  symbol: string; name: string; quantity: string;
  average_price: string; type: string; sector: string;
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
const Dashboard: React.FC = () => {
  const [portfolio, setPortfolio] = useState<Stock[]>([]);
  const [stats, setStats] = useState<PortfolioStats | null>(null);
  const [marketRegime, setMarketRegime] = useState<MarketRegime>(MOCK_MARKET_REGIME);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const [sortBy, setSortBy] = useState('score');
  const [filterSignal, setFilterSignal] = useState('ALL');

  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState<'add' | 'edit'>('add');
  const [formData, setFormData] = useState<FormData>({
    symbol: '', name: '', quantity: '', average_price: '',
    type: 'Stock', sector: '',
  });
  const [editingId, setEditingId] = useState<number | null>(null);

  const [newsModalStock, setNewsModalStock] = useState<Stock | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const nextIdRef = useRef(100);

  // ── Load data (mock) ──────────────────────────────────────────────────────
  // nullToUndefined: API may return null; our types use optional (undefined).
  // This prevents TypeScript assignment errors when merging mock + live data.
  const nullToUndefined = (obj: Record<string, unknown>): Stock => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = v === null ? undefined : v;
    return out as unknown as Stock;
  };

  const fetchPortfolio = useCallback(async () => {
    setLoading(true);
    await new Promise(r => setTimeout(r, 400));
    setPortfolio(prev => {
      const localAdds = prev.filter(s => s.id >= 100);
      const cleaned = (MOCK_PORTFOLIO as Record<string, unknown>[]).map(nullToUndefined);
      return [...cleaned, ...localAdds];
    });
    setStats(MOCK_STATS as PortfolioStats);
    setMarketRegime(MOCK_MARKET_REGIME);
    setLastUpdate(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchPortfolio();
  }, [fetchPortfolio]);

  // ── CRUD (local only in demo) ─────────────────────────────────────────────
  const handleAddStock = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.symbol || !formData.quantity || !formData.average_price) return;
    const newStock: Stock = {
      id: nextIdRef.current++,
      symbol: formData.symbol,
      name: formData.name,
      sector: formData.sector,
      type: formData.type,
      instrument_type: formData.type,
      quantity: parseFloat(formData.quantity),
      average_price: parseFloat(formData.average_price),
      current_price: parseFloat(formData.average_price),
      change_percent: 0,
      signal: 'INSUFFICIENT_DATA',
      regime: 'NORMAL',
      latest_score: undefined,
    };
    setPortfolio(prev => [...prev, newStock]);
    setStats(prev => prev ? {
      ...prev,
      totalValue: prev.totalValue + newStock.quantity * newStock.average_price,
    } : null);
    setShowForm(false);
  };

  const handleEditStock = (e: React.FormEvent) => {
    e.preventDefault();
    setPortfolio(prev => prev.map(s =>
      s.id === editingId ? {
        ...s,
        name: formData.name,
        quantity: parseFloat(formData.quantity),
        average_price: parseFloat(formData.average_price),
        sector: formData.sector,
        type: formData.type,
      } : s
    ));
    setShowForm(false);
    setEditingId(null);
  };

  const handleDeleteStock = (id: number) => {
    if (!window.confirm('Remove this asset from the portfolio?')) return;
    setPortfolio(prev => prev.filter(s => s.id !== id));
  };

  const openEditForm = (stock: Stock) => {
    setFormMode('edit'); setEditingId(stock.id);
    setFormData({
      symbol: stock.symbol, name: stock.name ?? '',
      quantity: stock.quantity.toString(),
      average_price: stock.average_price.toString(),
      type: stock.type ?? 'Stock',
      sector: stock.sector ?? '',
    });
    setShowForm(true);
  };

  const openAddForm = () => {
    setFormMode('add'); setEditingId(null);
    setFormData({ symbol: '', name: '', quantity: '', average_price: '', type: 'Stock', sector: '' });
    setShowForm(true);
  };

  const toggleRow = (symbol: string) =>
    setExpandedRow(prev => prev === symbol ? null : symbol);

  // ── Filter & Sort ─────────────────────────────────────────────────────────
  const BULL_SIGNALS = ['ADD', 'SPRING_CONFIRMED', 'SPRING_CANDIDATE', 'STRONG_BUY', 'BUY'];
  const NOISE_SIGNALS = ['HOLD_NOISE', 'MARKET_NOISE', 'HOLD', 'NORMAL'];
  const BEAR_SIGNALS  = ['WATCH', 'TRIM_25', 'REDUCE', 'SELL', 'IDIOSYNCRATIC_DECAY'];

  const filteredPortfolio = (() => {
    let list = [...portfolio];
    if (filterSignal === 'BULLISH')
      list = list.filter(s => BULL_SIGNALS.includes(s.signal ?? ''));
    else if (filterSignal === 'NOISE')
      list = list.filter(s => NOISE_SIGNALS.includes(s.signal ?? '') || s.regime === 'MARKET_NOISE');
    else if (filterSignal === 'BEARISH')
      list = list.filter(s => BEAR_SIGNALS.includes(s.signal ?? ''));

    return list.sort((a, b) => {
      if (sortBy === 'moat')   return (b.moat_score ?? 0) - (a.moat_score ?? 0);
      if (sortBy === 'alpha')  return (b.excess_return ?? 0) - (a.excess_return ?? 0);
      if (sortBy === 'symbol') return a.symbol.localeCompare(b.symbol);
      if (sortBy === 'pnl') {
        const pA = ((a.current_price ?? 0) - a.average_price) * a.quantity;
        const pB = ((b.current_price ?? 0) - b.average_price) * b.quantity;
        return pB - pA;
      }
      return (b.latest_score ?? 0) - (a.latest_score ?? 0);
    });
  })();

  // ── Portfolio totals ──────────────────────────────────────────────────────
  const totalVal = portfolio.reduce((s, x) => s + (x.current_price ?? 0) * x.quantity, 0);
  const totalCost = portfolio.reduce((s, x) => s + x.average_price * x.quantity, 0);
  const totalPnL  = totalVal - totalCost;
  const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;

  const totalDayChange = portfolio.reduce((s, x) => {
    if (!x.current_price || x.change_percent == null) return s;
    const prev = x.current_price / (1 + x.change_percent / 100);
    return s + (x.current_price - prev) * x.quantity;
  }, 0);

  const totalDayPct = totalVal > 0
    ? portfolio.reduce((s, x) => {
        if (!x.current_price || x.change_percent == null) return s;
        return s + x.change_percent * ((x.current_price * x.quantity) / totalVal);
      }, 0)
    : 0;

  const avgScore = portfolio.length
    ? (portfolio.reduce((s, x) => s + (x.latest_score ?? 0), 0) / portfolio.length).toFixed(1)
    : '—';
  const bullCount = portfolio.filter(s => BULL_SIGNALS.includes(s.signal ?? '')).length;
  const bearCount = portfolio.filter(s => BEAR_SIGNALS.includes(s.signal ?? '')).length;

  // ── Regime display ────────────────────────────────────────────────────────
  const showRegimeBanner = marketRegime?.regime && !['NORMAL', 'INSUFFICIENT_DATA'].includes(marketRegime.regime);

  if (loading && portfolio.length === 0) {
    return (
      <div className="dashboard-container">
        <NeuralBackground />
        <div className="loading-wrap"><div className="loading-ring" /></div>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <NeuralBackground />

      {/* ── Header ── */}
      <div className="dashboard-header">
        <div>
          <h1>Alpha Compounder</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
            <p className="subtitle" style={{ margin: 0 }}>
              Regime-Aware · Long-Horizon · Fundamentals-First
            </p>
            {showRegimeBanner && (
              <span style={{
                padding: '2px 8px', borderRadius: 4, fontSize: 10,
                fontFamily: 'DM Mono, monospace', fontWeight: 700,
                background: marketRegime.regime === 'BEAR' ? '#fef2f2' : '#fff7ed',
                color: marketRegime.regime === 'BEAR' ? '#dc2626' : '#c2410c',
                border: `1px solid ${marketRegime.regime === 'BEAR' ? '#fca5a5' : '#fdba74'}`,
              }}>
                {marketRegime.regime === 'BEAR' ? '🐻 BEAR MARKET' : '⚠ STRESSED'}
                {' · SPY '}{marketRegime.spy21d >= 0 ? '+' : ''}{(marketRegime.spy21d ?? 0).toFixed(1)}%
              </span>
            )}
          </div>
        </div>
        <div className="header-actions">
          {lastUpdate && (
            <div className="last-update">
              <span className="live-dot" />
              Last updated: {lastUpdate.toLocaleTimeString()}
            </div>
          )}
          <button onClick={openAddForm} className="btn-primary">+ Add Stock</button>
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
            <div className={`stat-sub ${totalDayChange >= 0 ? 'pos' : 'neg'}`}>
              {fmtPct(totalDayPct)} vs yesterday
            </div>
          </div>
          <div className={`stat-card ${totalPnL >= 0 ? 'profit-card' : 'loss-card'}`}>
            <div className="stat-label">Total Gain / Loss</div>
            <div className="stat-value stat-value-sm" style={{ color: totalPnL >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {totalPnL >= 0 ? '+' : ''}{fmtUSD(totalPnL, true)}
            </div>
            <div className={`stat-sub ${totalPnL >= 0 ? 'pos' : 'neg'}`}>
              {fmtPct(totalPnLPct)} vs cost basis
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Avg Quality</div>
            <div className="stat-value" style={{ color: scoreCol(parseFloat(stats?.averageScore ?? avgScore)) }}>
              {stats?.averageScore ?? avgScore}<span className="stat-unit">/10</span>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Buy Signals</div>
            <div className="stat-value" style={{ color: bullCount > 0 ? 'var(--green)' : 'var(--text-muted)' }}>
              {bullCount}
            </div>
            <div className="stat-sub" style={{ color: '#6b6b65' }}>positions to consider adding</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Risk Alerts</div>
            <div className="stat-value" style={{ color: bearCount > 0 ? 'var(--red)' : 'var(--text-muted)' }}>
              {bearCount}
            </div>
            <div className="stat-sub" style={{ color: '#6b6b65' }}>positions to review</div>
          </div>
        </div>
      </div>

      {/* ── Controls ── */}
      <div className="controls-section">
        <div className="filter-pills">
          {[
            { v: 'ALL',     l: 'All Assets' },
            { v: 'BULLISH', l: '▲ Buy Signals' },
            { v: 'NOISE',   l: '— Hold / Noise' },
            { v: 'BEARISH', l: '▼ Risk Alerts' },
          ].map(({ v, l }) => (
            <button key={v}
              className={`pill ${filterSignal === v ? 'pill-active' : ''}`}
              onClick={() => setFilterSignal(v)}>{l}</button>
          ))}
        </div>
        <select className="minimal-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="score">Sort: Quality Score</option>
          <option value="moat">Sort: Moat Score</option>
          <option value="alpha">Sort: Outperformance (α)</option>
          <option value="pnl">Sort: Gain / Loss</option>
          <option value="symbol">Sort: Symbol A–Z</option>
        </select>
        <div className="results-count">{filteredPortfolio.length} of {portfolio.length} assets</div>
      </div>

      {/* ── Table ── */}
      <div className="portfolio-section">
        {filteredPortfolio.length === 0 ? (
          <div className="no-results">
            No assets match this filter.{' '}
            <button className="btn-secondary" style={{ padding: '6px 14px', marginLeft: 8 }}
              onClick={() => setFilterSignal('ALL')}>Clear filter</button>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="portfolio-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Price &amp; P&amp;L</th>
                  <th>Quality &amp; Moat</th>
                  {/* ── REGIME COLUMN:
                      BUG: In the original code, regime labels like WATCH, MARKET_NOISE,
                      IDIOSYNCRATIC_DECAY were shown in BOTH "Regime" and "Signal" columns
                      because those values appear in both SIGNAL_CFG and REGIME_CFG.
                      FIX: We renamed this column "Context" and only render the regime
                      label when regime !== signal AND it adds distinct information. ──*/}
                  <th>Context &amp; α</th>
                  <th>Recommendation</th>
                  <th>Position Value</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredPortfolio.map(stock => {
                  const tv   = (stock.current_price ?? 0) * stock.quantity;
                  const pd   = ((stock.current_price ?? 0) - stock.average_price) * stock.quantity;
                  const pp   = stock.average_price > 0
                    ? ((stock.current_price ?? 0) - stock.average_price) / stock.average_price * 100
                    : null;
                  const sCfg = sig(stock.signal);
                  const rCfg = reg(stock.regime);
                  const isExpanded = expandedRow === stock.symbol;

                  // ── BUG FIX: Regime display logic ──────────────────────────
                  // Original bug: regime rendered even when regime === signal,
                  // causing duplicate labels (e.g. WATCH shown twice).
                  // Fix: only show regime label when it genuinely differs AND adds context.
                  // Specific cases where regime === signal (so regime adds nothing new):
                  //   WATCH signal + WATCH regime → show signal only
                  //   IDIOSYNCRATIC_DECAY signal + IDIOSYNCRATIC_DECAY regime → show signal only
                  //   MARKET_NOISE signal + MARKET_NOISE regime → show signal only
                  // When regime IS different and meaningful (e.g. NORMAL regime + WATCH signal),
                  // it provides useful context about whether the issue is market-wide or stock-specific.
                  const regimeSameAsSignal = stock.regime === stock.signal;
                  const regimeIsNormal     = stock.regime === 'NORMAL' || stock.regime == null;
                  const showRegime = !regimeSameAsSignal && !regimeIsNormal;

                  return (
                    <React.Fragment key={stock.id}>
                      <tr className={`row-${sCfg.tier}${isExpanded ? ' row-expanded' : ''}`}>

                        {/* Asset */}
                        <td>
                          <div className="symbol-row">
                            <strong className="stock-symbol">{stock.symbol}</strong>
                            {stock.instrument_type === 'ETF' && (
                              <span className="etf-badge" title="ETF — scored on trend and news, not company fundamentals">ETF</span>
                            )}
                          </div>
                          {stock.name   && <div className="stock-name">{stock.name}</div>}
                          {stock.sector && <span className="sector-pill">{stock.sector}</span>}
                        </td>

                        {/* Price & P&L */}
                        <td>
                          <div className="price-value">{fmtUSD(stock.current_price)}</div>
                          {stock.change_percent != null && (
                            <div className={`change ${stock.change_percent >= 0 ? 'positive' : 'negative'}`}>
                              {stock.change_percent >= 0 ? '+' : ''}{stock.change_percent.toFixed(2)}% today
                            </div>
                          )}
                          {stock.average_price > 0 && stock.current_price != null && (
                            <div className={`change ${pd >= 0 ? 'positive' : 'negative'}`} style={{ fontWeight: 600, marginTop: 4 }}>
                              {pd >= 0 ? '▲' : '▼'} {fmtUSD(Math.abs(pd))}
                              {pp != null && <span style={{ opacity: 0.75 }}> ({fmtPct(pp)})</span>}
                            </div>
                          )}
                        </td>

                        {/* Quality + Moat */}
                        <td>
                          <div className="quality-moat-cell">
                            <ScoreRing score={stock.latest_score} />
                            <MoatRing score={stock.moat_score} />
                            {stock.capex_exception && (
                              <span className="capex-flag" title="Capital investment exception: large capex forgiven as strategic investment">🏗️</span>
                            )}
                          </div>
                          {/* fcf_yield: only show when > 0 (0 = data pending, not genuinely 0% yield) */}
                          {stock.fcf_yield != null && stock.fcf_yield > 0 && (
                            <div className="compact-metric" title={`FCF yield: ${(stock.fcf_yield*100).toFixed(1)}% — ${stock.fcf_yield > 0.05 ? 'attractive entry (<20x FCF)' : stock.fcf_yield > 0.03 ? 'fair value' : stock.fcf_yield > 0.015 ? 'expensive' : 'very expensive (>67x FCF)'}`}>
                              <span className="compact-lbl">FCF yld</span>
                              <span className={`compact-val ${stock.fcf_yield * 100 > 3 ? 'pos' : stock.fcf_yield * 100 < 1.5 ? 'neg' : ''}`}>
                                {(stock.fcf_yield * 100).toFixed(1)}%
                              </span>
                            </div>
                          )}
                        </td>

                        {/* Context & Alpha — FIXED: no duplicate regime/signal */}
                        <td>
                          {/* ── Regime label — only shown when it differs from signal ── */}
                          {showRegime ? (
                            <div className="regime-name" style={{ color: rCfg.color }}
                              title={rCfg.description}>
                              {rCfg.label}
                            </div>
                          ) : (
                            <div className="regime-name" style={{ color: '#9ca3af', fontWeight: 400 }}>
                              Normal
                            </div>
                          )}

                          {/* Jensen's Alpha */}
                          {stock.excess_return != null && (
                            <div className={`alpha-val change ${stock.excess_return >= 0 ? 'positive' : 'negative'}`}>
                              α {fmtPct(stock.excess_return)}
                            </div>
                          )}
                          {stock.beta != null && (
                            <div className="beta-val">β {Number(stock.beta).toFixed(2)}</div>
                          )}
                          {stock.max_drawdown != null && (
                            <div className="compact-metric" title="Largest drop in the past year — risk gauge">
                              <span className="compact-lbl">MaxDD</span>
                              <span className={`compact-val ${stock.max_drawdown > -15 ? '' : 'neg'}`}>
                                {stock.max_drawdown.toFixed(1)}%
                              </span>
                            </div>
                          )}
                        </td>

                        {/* Recommendation — FIXED: signal here only, not echoed in regime column */}
                        <td>
                          <span className={`signal-badge ${
                            sCfg.tier === 'bull' ? 'signal-bull' :
                            sCfg.tier === 'bear' && ['WATCH', 'TRIM_25'].includes(stock.signal ?? '') ? 'signal-bear-soft' :
                            sCfg.tier === 'bear' ? 'signal-bear-hard' :
                            'signal-neutral'
                          }`}>{sCfg.label}</span>

                          {/* Sharp drop alert */}
                          {stock.sharp_score_drop && (
                            <span
                              title={`Score dropped ${Math.abs(stock.score_delta_1d ?? 0).toFixed(1)} pts vs yesterday — review thesis`}
                              style={{
                                display: 'inline-block', marginLeft: 4, padding: '1px 5px',
                                fontSize: 9, fontWeight: 700,
                                background: '#fef2f2', color: '#dc2626',
                                border: '1px solid #fca5a5', borderRadius: 3,
                                fontFamily: 'DM Mono, monospace', verticalAlign: 'middle',
                              }}>
                              ⚡ −{Math.abs(stock.score_delta_1d ?? 0).toFixed(1)}
                            </span>
                          )}

                          {/* Plain-English tip */}
                          <div className="signal-action-tip">{sCfg.action}</div>

                          <SpringBar days={stock.spring_days} />
                          <CascadePips w1={stock.w1_signal} w2={stock.w2_confirmed} w3={stock.w3_confirmed} w4={stock.w4_confirmed} />
                        </td>

                        {/* Position Value */}
                        <td>
                          <div className="price-value">{fmtUSD(tv)}</div>
                          {totalVal > 0 && (() => {
                            const wPct = (tv / totalVal) * 100;
                            const sCfgSig = stock.signal ?? '';
                            const fnd = stock.score_fund ?? 5;
                            const isHighConviction = fnd >= 8.0 &&
                              ['ADD', 'SPRING_CONFIRMED', 'SPRING_CANDIDATE', 'STRONG_BUY'].includes(sCfgSig);
                            const isWeak = fnd < 6.5 ||
                              ['WATCH', 'REDUCE', 'TRIM_25', 'SELL', 'IDIOSYNCRATIC_DECAY'].includes(sCfgSig);
                            const isSpring = ['SPRING_CONFIRMED', 'SPRING_CANDIDATE'].includes(sCfgSig);
                            const mr = marketRegime?.regime ?? 'NORMAL';
                            const rawThreshold = isHighConviction ? 25 : isWeak ? 8 : 15;
                            const threshold = isSpring ? rawThreshold
                              : mr === 'BEAR'     ? Math.min(rawThreshold, 15)
                              : mr === 'STRESSED' ? Math.min(rawThreshold, 20)
                              : rawThreshold;
                            const overweight = wPct > threshold;
                            const wColor = overweight ? '#dc2626' : wPct > threshold * 0.8 ? '#d97706' : '#6b6b65';
                            const hint = overweight
                              ? `${wPct.toFixed(1)}% of portfolio — OVERSIZED (limit: ${threshold}% for this conviction level)`
                              : `${wPct.toFixed(1)}% of portfolio (limit: ${threshold}%)`;
                            return (
                              <div title={hint} className="weight-bar-wrap">
                                <div style={{
                                  fontFamily: 'var(--font-mono)', fontSize: 11,
                                  color: wColor, fontWeight: overweight ? 700 : 400,
                                }}>
                                  {wPct.toFixed(1)}% weight {overweight && '⚠'}
                                </div>
                                <div className="weight-bar-track">
                                  <div className="weight-bar-fill" style={{
                                    width: `${Math.min(wPct / threshold * 100, 100)}%`,
                                    background: wColor,
                                  }} />
                                </div>
                              </div>
                            );
                          })()}
                        </td>

                        {/* Actions */}
                        <td className="col-actions">
                          <button
                            onClick={() => toggleRow(stock.symbol)}
                            className={`btn-icon btn-expand${isExpanded ? ' btn-expand-active' : ''}`}
                            title={isExpanded ? 'Collapse detail' : 'Expand detail'}>
                            {isExpanded ? '▲' : '▼'}
                          </button>
                          <button onClick={() => setNewsModalStock(stock)} className="btn-icon" title="View news & intelligence">📰</button>
                          <button onClick={() => openEditForm(stock)} className="btn-icon" title="Edit position">✏️</button>
                          <button onClick={() => handleDeleteStock(stock.id)} className="btn-icon btn-icon-danger" title="Remove">✕</button>
                        </td>
                      </tr>

                      {/* Detail Panel */}
                      {isExpanded && <DetailPanel stock={stock} />}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Correlation Heatmap */}
      <CorrelationHeatmap portfolio={portfolio} />

      {/* Glossary / Legend */}
      <div style={{
        marginTop: 20,
        background: 'rgba(255,255,255,0.75)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 10,
        backdropFilter: 'blur(8px)',
      }}>
        <div style={{ gridColumn: '1 / -1', fontSize: 11, fontWeight: 700, color: '#6b6b65', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
          📖 Signal Guide
        </div>
        {Object.entries(SIGNAL_CFG)
          .filter(([k]) => k !== 'INSUFFICIENT_DATA' && k !== 'NORMAL')
          .map(([k, v]) => (
            <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span style={{
                flexShrink: 0, padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                background: v.color + '18', color: v.color, border: `1px solid ${v.color}40`,
                fontFamily: 'DM Mono, monospace', whiteSpace: 'nowrap',
              }}>{v.badge}</span>
              <span style={{ fontSize: 11, color: '#4b4b45', lineHeight: 1.4 }}>{v.action}</span>
            </div>
          ))}
      </div>

      {/* Footer */}
      <p style={{ textAlign: 'center', fontSize: 11, color: '#9ca3af', marginTop: 24, lineHeight: 1.6 }}>
        Alpha Compounder · For educational and informational purposes only. Not financial advice.
        All signals are systematic — always apply your own judgement.{' '}
        <strong style={{ color: '#d97706' }}>
          Indian investors: Trim/Sell signals do not account for your CGT position.
          Always weigh the tax cost (20% LTCG / 30% STCG) before acting on any sell signal.
        </strong>
      </p>

      {/* ── Add / Edit Modal ── */}
      {showForm && (
        <Modal onClose={() => setShowForm(false)}>
          <div className="modal-header">
            <div className="modal-header-text">
              <h2>{formMode === 'add' ? 'Add Stock' : 'Edit Position'}</h2>
              <p className="modal-sub-label">
                {formMode === 'add'
                  ? 'Enter ticker details to begin tracking.'
                  : `Editing ${formData.symbol}`}
              </p>
            </div>
            <button className="btn-close" onClick={() => setShowForm(false)}>✕</button>
          </div>
          <div className="modal-body">
            <div className="form-grid">
              <div className="form-group">
                <label>Symbol</label>
                <input type="text" placeholder="e.g. CRWD"
                  value={formData.symbol}
                  onChange={e => setFormData({ ...formData, symbol: e.target.value.toUpperCase() })}
                  disabled={formMode === 'edit'} />
              </div>
              <div className="form-group">
                <label>Name</label>
                <input type="text" placeholder="Company name"
                  value={formData.name}
                  onChange={e => setFormData({ ...formData, name: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Quantity</label>
                <input type="number" step="0.01"
                  value={formData.quantity}
                  onChange={e => setFormData({ ...formData, quantity: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Avg Cost (per share)</label>
                <input type="number" step="0.01"
                  value={formData.average_price}
                  onChange={e => setFormData({ ...formData, average_price: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Sector <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 400 }}>(auto-filled after first run)</span></label>
                <input type="text" placeholder="e.g. Technology"
                  value={formData.sector}
                  onChange={e => setFormData({ ...formData, sector: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Type</label>
                <select value={formData.type}
                  onChange={e => setFormData({ ...formData, type: e.target.value })}>
                  <option>Stock</option>
                  <option>ETF</option>
                </select>
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
            <button type="button" className="btn-primary"
              onClick={formMode === 'add' ? handleAddStock : handleEditStock}>
              {formMode === 'add' ? 'Add to Portfolio' : 'Save Changes'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Intelligence Modal ── */}
      {newsModalStock && (
        <Modal onClose={() => setNewsModalStock(null)} wide>
          <div className="modal-header">
            <div className="modal-header-text">
              <h2>Intelligence · {newsModalStock.symbol}</h2>
              <p className="modal-sub-label">
                {sig(newsModalStock.signal).badge}
                {newsModalStock.excess_return != null
                  ? ` · Market outperformance: ${fmtPct(newsModalStock.excess_return)}`
                  : ''}
              </p>
            </div>
            <button className="btn-close" onClick={() => setNewsModalStock(null)}>✕</button>
          </div>
          <div className="modal-body">
            {(newsModalStock.recent_news?.length ?? 0) > 0 ? (
              newsModalStock.recent_news!.map((n, i) => (
                <a href={n.url} target="_blank" rel="noopener noreferrer" key={i} className="news-card">
                  <span className="news-date">
                    {new Date(n.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                  <h3 className="news-headline">{n.headline}</h3>
                  {n.description && (
                    <p className="news-desc">{n.description.substring(0, 180)}…</p>
                  )}
                </a>
              ))
            ) : (
              <p className="no-news">No recent news found for this asset.</p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
};

export default Dashboard;
