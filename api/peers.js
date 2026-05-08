// /api/peers.js — Vercel serverless function
// Fetches live valuation multiples from Financial Modeling Prep for a list of tickers.
// API key stays server-side via process.env.TWELVE_DATA_API_KEY (set in Vercel env vars).
// Caches results in-memory for 6 hours to preserve the 250/day free-tier quota.

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map(); // ticker -> { ts, data }

async function fetchOne(ticker, apiKey) {
  // Twelve Data: use the /statistics endpoint for valuation ratios.
  // Returns valuations_metrics with enterprise_to_ebitda, enterprise_to_revenue, trailing_pe, etc.
  const url = `https://api.twelvedata.com/statistics?symbol=${encodeURIComponent(ticker)}&apikey=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Twelve Data ${res.status}`);
  const body = await res.json();
  // Twelve Data signals errors via a "code" field in the JSON body even on 200 responses
  if (body.code && body.code !== 200) throw new Error(`Twelve Data ${body.code}: ${body.message || 'error'}`);
  const v = body.statistics?.valuations_metrics || {};
  const f = body.statistics?.financials || {};
  return {
    ticker,
    ebitda: parseFloat(v.enterprise_to_ebitda) || null,
    rev:    parseFloat(v.enterprise_to_revenue) || null,
    pe:     parseFloat(v.trailing_pe) || null,
    pb:     parseFloat(v.price_to_book_mrq ?? f.price_to_book) || null,
    fetchedAt: Date.now(),
  };
}

export default async function handler(req, res) {
  // CORS — same-origin in production, but harmless to allow GET from anywhere
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'TWELVE_DATA_API_KEY not configured on server' });
    return;
  }

  const tickersRaw = req.query.tickers || '';
  const tickers = String(tickersRaw)
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .slice(0, 10); // hard cap so a malicious caller can't drain the quota

  if (!tickers.length) {
    res.status(400).json({ error: 'tickers query param required (comma-separated)' });
    return;
  }

  const now = Date.now();
  const results = {};
  const toFetch = [];

  // Cache check
  for (const t of tickers) {
    const cached = cache.get(t);
    if (cached && (now - cached.ts < CACHE_TTL_MS)) {
      results[t] = cached.data;
    } else {
      toFetch.push(t);
    }
  }

  // Fetch the rest in parallel; one failure doesn't kill the others
  if (toFetch.length) {
    const settled = await Promise.allSettled(toFetch.map(t => fetchOne(t, apiKey)));
    settled.forEach((s, i) => {
      const t = toFetch[i];
      if (s.status === 'fulfilled') {
        results[t] = s.value;
        cache.set(t, { ts: now, data: s.value });
      } else {
        results[t] = { ticker: t, error: String(s.reason?.message || s.reason) };
      }
    });
  }

  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
  res.status(200).json({ results, fetchedAt: now });
}
