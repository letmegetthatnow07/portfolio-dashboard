/**
 * Deduplication Cache
 * Prevents fetching the same data multiple times in one day
 * Uses TTL (Time To Live) for different data types
 */

class DeduplicationCache {
  constructor() {
    this.cache = new Map();
    this.ttl = {
      prices: 24,        // Fetch once per day
      ratings: 336,      // Fetch once per 2 weeks (336 hours)
      news: 6,           // Fetch every 6 hours
      filings: 720,      // Fetch once per month
      grades: 720,       // Fetch once per month
      insider: 168       // Fetch once per week
    };
  }

  /**
   * Check if data should be fetched
   * Returns true if not cached or cache expired
   */
  shouldFetch(symbol, dataType) {
    const key = `${symbol}:${dataType}`;
    const cached = this.cache.get(key);
    
    // Nothing cached, fetch it
    if (!cached) {
      return true;
    }
    
    // Check if cache expired
    const hoursSince = (Date.now() - cached.timestamp) / (1000 * 60 * 60);
    const ttl = this.ttl[dataType] || 24;
    
    return hoursSince >= ttl;
  }

  /**
   * Store fetched data in cache
   */
  markFetched(symbol, dataType, data) {
    const key = `${symbol}:${dataType}`;
    this.cache.set(key, {
      timestamp: Date.now(),
      data: data,
      expireAt: new Date(Date.now() + this.ttl[dataType] * 60 * 60 * 1000)
    });
  }

  /**
   * Get cached data
   */
  getCached(symbol, dataType) {
    const key = `${symbol}:${dataType}`;
    const cached = this.cache.get(key);
    return cached ? cached.data : null;
  }

  /**
   * Clear old cache entries
   */
  cleanup() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now > value.expireAt.getTime()) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get cache stats for debugging
   */
  getStats() {
    return {
      totalCached: this.cache.size,
      entries: Array.from(this.cache.keys())
    };
  }
}

module.exports = new DeduplicationCache();
