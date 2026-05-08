// /api/peers.js — Vercel serverless function
// Fetches live valuation multiples from Financial Modeling Prep for a list of tickers.
// API key stays server-side via process.env.FMP_API_KEY (set in Vercel env vars).
// Caches results in-memory for 6 hours to preserve the 250/day free-tier quota.

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map(); // ticker -> { ts, data }

async function fetchOne(ticker, apiKey) {
  // ratios-ttm endpoint returns trailing-twelve-month ratios incl. EV/EBITDA, EV/Sales, P/E, P/B
  const url = `https://financialmodelingprep.com/api/v3/ratios-ttm/${encodeURIComponent(ticker)}?apikey=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`FMP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) throw new Error('empty response');
  const r = arr[0];
  // FMP returns enterpriseValueMultipleTTM (EV/EBITDA), priceToSalesRatioTTM, peRatioTTM, priceToBookRatioTTM
  // We approximate EV/Revenue via priceToSalesRatio for simplicity (close enough for peer comparison);
  // for a stricter EV/Revenue you'd combine market cap + debt - cash / revenue, which needs another endpoint.
  return {
    ticker,
    ebitda: r.enterpriseValueMultipleTTM ?? null,
    rev:    r.priceToSalesRatioTTM ?? null,
    pe:     r.peRatioTTM ?? null,
    pb:     r.priceToBookRatioTTM ?? null,
    fetchedAt: Date.now(),
  };
}

export default async function handler(req, res) {
  // CORS — same-origin in production, but harmless to allow GET from anywhere
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'FMP_API_KEY not configured on server' });
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
